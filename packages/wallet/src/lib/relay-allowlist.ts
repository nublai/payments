import {
    decodeFunctionData,
    erc20Abi,
    formatUnits,
    getAddress,
    zeroAddress,
    type Address,
    type Hex,
} from 'viem'
import { assertOrderRecipients, hashRelayOrder, orderPayees, RelayOrderRejected } from './relay-order'
import { QuotePaymentRejected, reviewQuotePayment } from './intent-payment'
import { WETH_BY_CHAIN } from './quote-spend'
import { getUsdcAddressByChainId } from './network-config'
import type { RelayCurrencyAmount, RelayQuoteResponse } from './relay-link'

/**
 * Swap and bridge may only sign calls to these relay.link contracts, and only
 * with the selectors below. Chain 31337 is absent from the chains API, so it
 * fails closed. `relayReceiver` is returned by that API but no sampled
 * quote/v2 step called it and the docs do not publish a user selector for it,
 * so calls to it are refused.
 *
 * Addresses (Base 8453 and Polygon 137, checked separately on 2026-10-07):
 * - GET https://api.relay.link/chains
 *   https://docs.relay.link/references/api/get-chains
 *   https://docs.relay.link/references/protocol/addresses (depository list is live from that API)
 *   Base and Polygon both report:
 *     erc20Router / v3.erc20Router 0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f
 *     approvalProxy / v3.approvalProxy 0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE
 *     protocol.v2.depository 0x4cD00E387622C35bDDB9b4c962C136462338BC31
 *   Historical v2 routers on
 *   https://docs.relay.link/references/api/api_resources/contract-addresses
 *   are not the addresses those two chains return, so they are not allowlisted.
 *
 * Selectors: POST https://api.relay.link/quote/v2
 *   https://docs.relay.link/references/api/get-quote-v2
 *   Base ETH→USDC swap calls the v3 router with 0xcd6e13f7.
 *   Base and Polygon USDC→ETH swaps call the v3 approval proxy with 0xf9e4bab4
 *   after approve(approvalProxy, quoted amount).
 *   Base USDC bridge approves the depository, then calls it with 0xe8017952.
 *   Base ETH bridge calls the depository with 0x49290c1c and msg.value = input.
 *   depositNative(address,bytes32) and depositErc20(address,address,uint256,bytes32)
 *   are documented at
 *   https://docs.relay.link/references/protocol/contracts/evm-depository
 *   and keccak to 0x49290c1c and 0xe8017952.
 *   The full-allowance overload depositErc20(address,address,bytes32) is
 *   0x5a1ee3ac and is not allowlisted.
 *   0xcd6e13f7 is multicall((address,bool,uint256,bytes)[],address,address,bytes).
 *   0xf9e4bab4 is transferAndMulticall(address[],uint256[],(address,bool,uint256,bytes)[],address,address,bytes).
 *   ERC-20 approve is 0x095ea7b3. transfer, transferFrom, and increaseAllowance are refused.
 *   Inner calls are allowlisted, not denylisted: only cleanupErc20s (0x9bb43718)
 *   and cleanupNative (0xa6bd8c96) on an allowlisted relay contract are signed.
 *   Any other inner selector, including 0x12345678, is refused.
 *   Those inner selectors are not canExecute rows. A swap session's canExecute
 *   is the outer entrypoints below, plus the quoted input token's approve
 *   (and transfer only when that quote's outer calls include it).
 */

const APPROVE_SELECTOR = '0x095ea7b3'

const MULTICALL_SELECTOR = '0xcd6e13f7'

const TRANSFER_AND_MULTICALL_SELECTOR = '0xf9e4bab4'

const DEPOSIT_NATIVE_SELECTOR = '0x49290c1c'

const DEPOSIT_ERC20_SELECTOR = '0xe8017952'

const FORBIDDEN_SELECTORS: Record<string, string> = {
    '0xa9059cbb': 'transfer',
    '0x23b872dd': 'transferFrom',
    '0x39509351': 'increaseAllowance',
}

/** Inner calls Relay quotes use besides the outer entrypoint. Anything else is refused. */
const ALLOWED_INNER_SELECTORS: Record<string, string> = {
    '0x9bb43718': 'cleanupErc20s',
    '0xa6bd8c96': 'cleanupNative',
}

const VALUE_SELECTORS = new Set([MULTICALL_SELECTOR, DEPOSIT_NATIVE_SELECTOR])

type RelayContract = {
    address: Address
    name: string
    selectors: Record<string, string>
}

const RELAY_V3_ROUTER: RelayContract = {
    address: '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f',
    name: 'Relay v3 ERC-20 Router',
    selectors: {
        [MULTICALL_SELECTOR]: 'multicall',
    },
}

const RELAY_V3_APPROVAL_PROXY: RelayContract = {
    address: '0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE',
    name: 'Relay v3 Approval Proxy',
    selectors: {
        [TRANSFER_AND_MULTICALL_SELECTOR]: 'transferAndMulticall',
    },
}

const RELAY_DEPOSITORY: RelayContract = {
    address: '0x4cD00E387622C35bDDB9b4c962C136462338BC31',
    name: 'Relay Depository',
    selectors: {
        [DEPOSIT_NATIVE_SELECTOR]: 'depositNative',
        [DEPOSIT_ERC20_SELECTOR]: 'depositErc20',
    },
}

const CALL_ALLOWLIST: Record<number, readonly RelayContract[]> = {
    8453: [RELAY_V3_ROUTER, RELAY_V3_APPROVAL_PROXY, RELAY_DEPOSITORY],
    137: [RELAY_V3_ROUTER, RELAY_V3_APPROVAL_PROXY, RELAY_DEPOSITORY],
}

export type RelayEntryPoint = {
    target: Address
    selector: Hex
    contractName: string
    functionName: string
}

/** Outer Relay entrypoints a swap session may call. Empty when the chain has no allowlist. */
export function relayEntryPoints(chainId: number): RelayEntryPoint[] {
    const contracts = CALL_ALLOWLIST[chainId]

    if (!contracts) return []
    const points: RelayEntryPoint[] = []

    for (const contract of contracts) {
        for (const [selector, functionName] of Object.entries(contract.selectors)) {
            points.push({
                target: contract.address,
                selector: selector as Hex,
                contractName: contract.name,
                functionName,
            })
        }
    }

    return points
}

const multicallAbi = [
    {
        name: 'multicall',
        type: 'function',
        stateMutability: 'payable',
        inputs: [
            {
                name: 'calls',
                type: 'tuple[]',
                components: [
                    { name: 'target', type: 'address' },
                    { name: 'allowFailure', type: 'bool' },
                    { name: 'value', type: 'uint256' },
                    { name: 'callData', type: 'bytes' },
                ],
            },
            { name: 'refundTo', type: 'address' },
            { name: 'nftRecipient', type: 'address' },
            { name: 'metadata', type: 'bytes' },
        ],
        outputs: [],
    },
] as const

const transferAndMulticallAbi = [
    {
        name: 'transferAndMulticall',
        type: 'function',
        stateMutability: 'payable',
        inputs: [
            { name: 'tokens', type: 'address[]' },
            { name: 'amounts', type: 'uint256[]' },
            {
                name: 'calls',
                type: 'tuple[]',
                components: [
                    { name: 'target', type: 'address' },
                    { name: 'allowFailure', type: 'bool' },
                    { name: 'value', type: 'uint256' },
                    { name: 'callData', type: 'bytes' },
                ],
            },
            { name: 'refundTo', type: 'address' },
            { name: 'nftRecipient', type: 'address' },
            { name: 'metadata', type: 'bytes' },
        ],
        outputs: [],
    },
] as const

export class RelayQuoteRejected extends Error {
    override cause?: unknown

    constructor(message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'RelayQuoteRejected'
        this.cause = options?.cause
    }
}

export type RelayQuoteCheck = {
    sourceChainId: number
    destinationChainId: number
    /** User slippage in basis points. The quoted minimum must cover it. */
    slippageBps: number
    inputAmount: bigint
    inputIsNative: boolean
    originCurrency: Address
    user: Address
    recipient: Address
    /**
     * Orchestrator payment attached to this quote. Token and amount must match
     * the quote fee and the 5 USDC ceiling, and the recipient must be
     * `expectedRecipient`. Absent means this quote carries no payment.
     */
    payment?: {
        token: Address
        amount: bigint
        recipient: Address
        feeAmount: bigint
        expectedRecipient: Address
    }
}

export type RelayQuoteReview = {
    cap: bigint
    tokens: Address[]
}

type InnerCall = {
    target: Address
    selector: string
    functionName: string
}

type PartyCall = {
    refundTo?: Address
    nftRecipient?: Address
    depositor?: Address
    innerCalls?: InnerCall[]
}

function contractsFor(chainId: number): readonly RelayContract[] | undefined {
    return CALL_ALLOWLIST[chainId]
}

function contractAt(chainId: number, target: Address): RelayContract | undefined {
    const contracts = contractsFor(chainId)

    if (!contracts) return undefined
    const normalized = target.toLowerCase()

    return contracts.find((contract) => contract.address.toLowerCase() === normalized)
}

function spenderName(chainId: number, spender: Address): string | undefined {
    return contractAt(chainId, spender)?.name
}

function isAllowlistedSpender(chainId: number, spender: Address): boolean {
    return contractAt(chainId, spender) !== undefined
}

function quotedInputCap(requested: bigint, quote: RelayQuoteResponse): bigint {
    const raw = quote.details?.currencyIn?.amount

    if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
        const quoted = BigInt(raw)

        if (quoted < requested) return quoted
    }

    return requested
}

function parseValue(value: string): bigint {
    if (!/^[0-9]+$/.test(value)) {
        throw new RelayQuoteRejected('relay.link quote has an invalid native value.')
    }

    return BigInt(value)
}

function selectorOf(data: string): string {
    if (!data.startsWith('0x') || data.length < 10 || (data.length - 2) % 2 !== 0) {
        throw new RelayQuoteRejected('relay.link quote includes a call with no function selector.')
    }

    return data.slice(0, 10).toLowerCase()
}

function functionNameFor(selector: string, contract: RelayContract | undefined): string {
    return contract?.selectors[selector] ?? FORBIDDEN_SELECTORS[selector] ?? selector
}

function decodeApprove(data: Hex): { spender: Address; amount: bigint } {
    try {
        const decoded = decodeFunctionData({ abi: erc20Abi, data })

        if (decoded.functionName !== 'approve') {
            throw new Error('not approve')
        }

        const [spender, amount] = decoded.args

        return { spender: getAddress(spender), amount }
    } catch (error) {
        throw new RelayQuoteRejected(
            'relay.link quote approve calldata is not approve(address,uint256).',
            {
                cause: error,
            },
        )
    }
}

function sameAddress(left: Address, right: Address): boolean {
    return left.toLowerCase() === right.toLowerCase()
}

function isUserOrZero(address: Address, user: Address): boolean {
    return sameAddress(address, zeroAddress) || sameAddress(address, user)
}

function assertParty(address: Address, user: Address, kind: 'refundTo' | 'nftRecipient' | 'depositor'): void {
    if (isUserOrZero(address, user)) return

    if (kind === 'refundTo') {
        throw new RelayQuoteRejected(
            `relay.link quote refunds to ${address}, which is not the user.`,
        )
    }

    if (kind === 'nftRecipient') {
        throw new RelayQuoteRejected(
            `relay.link quote sends NFTs to ${address}, which is not the user.`,
        )
    }

    throw new RelayQuoteRejected(
        `relay.link quote deposits for ${address}, which is not the user.`,
    )
}

function assertInnerCalls(calls: InnerCall[], chainId: number): void {
    for (const call of calls) {
        const forbidden = FORBIDDEN_SELECTORS[call.selector]

        if (forbidden || call.selector === APPROVE_SELECTOR) {
            const name = forbidden ?? 'approve'
            throw new RelayQuoteRejected(
                `relay.link quote inner call is ${name} (${call.selector}) on ${call.target}, which swap and bridge will not sign.`,
            )
        }

        const allowed = ALLOWED_INNER_SELECTORS[call.selector]

        if (!allowed || !contractAt(chainId, call.target)) {
            throw new RelayQuoteRejected(
                `relay.link quote inner call ${call.selector} on ${call.target} is not an allowlisted relay entrypoint.`,
            )
        }
    }
}

function innerCallOf(target: Address, data: Hex): InnerCall {
    const selector = data.length >= 10 ? data.slice(0, 10).toLowerCase() : '0x'

    const name =
        FORBIDDEN_SELECTORS[selector] ??
        (selector === APPROVE_SELECTOR ? 'approve' : undefined) ??
        (selector === '0x9bb43718' ? 'cleanupErc20s' : undefined) ??
        (selector === '0xa6bd8c96' ? 'cleanupNative' : undefined) ??
        selector

    return { target, selector, functionName: name }
}

function decodeMulticall(data: Hex, user: Address, chainId: number): PartyCall {
    try {
        const decoded = decodeFunctionData({ abi: multicallAbi, data })
        const [calls, refundTo, nftRecipient] = decoded.args
        assertParty(getAddress(refundTo), user, 'refundTo')
        assertParty(getAddress(nftRecipient), user, 'nftRecipient')
        const innerCalls = calls.map((call) => innerCallOf(getAddress(call.target), call.callData))
        assertInnerCalls(innerCalls, chainId)

        return {
            refundTo: getAddress(refundTo),
            nftRecipient: getAddress(nftRecipient),
            innerCalls,
        }
    } catch (error) {
        if (error instanceof RelayQuoteRejected) throw error
        throw new RelayQuoteRejected('relay.link quote multicall calldata is invalid.', {
            cause: error,
        })
    }
}

function decodeDepositNative(data: Hex, user: Address): { depositor: Address; id: Hex } {
    if (data.length !== 2 + 8 + 64 * 2) {
        throw new RelayQuoteRejected('relay.link quote depositNative calldata is incomplete.')
    }

    try {
        const depositor = getAddress(`0x${data.slice(10 + 24, 10 + 64)}`)
        const id = `0x${data.slice(10 + 64, 10 + 64 * 2)}` as Hex
        assertParty(depositor, user, 'depositor')

        return { depositor, id }
    } catch (error) {
        if (error instanceof RelayQuoteRejected) throw error
        throw new RelayQuoteRejected('relay.link quote depositNative calldata is invalid.', {
            cause: error,
        })
    }
}

function decodeDepositErc20(
    data: Hex,
    user: Address,
    originCurrency: Address,
    inputIsNative: boolean,
): { depositor: Address; token: Address; amount: bigint; id: Hex } {
    if (data.length !== 2 + 8 + 64 * 4) {
        throw new RelayQuoteRejected('relay.link quote depositErc20 calldata is incomplete.')
    }

    let depositor: Address
    let token: Address
    let amount: bigint
    let id: Hex

    try {
        depositor = getAddress(`0x${data.slice(10 + 24, 10 + 64)}`)
        token = getAddress(`0x${data.slice(10 + 64 + 24, 10 + 64 * 2)}`)
        amount = BigInt(`0x${data.slice(10 + 64 * 2, 10 + 64 * 3)}`)
        id = `0x${data.slice(10 + 64 * 3, 10 + 64 * 4)}` as Hex
    } catch (error) {
        throw new RelayQuoteRejected('relay.link quote depositErc20 calldata is invalid.', {
            cause: error,
        })
    }

    assertParty(depositor, user, 'depositor')

    if (inputIsNative || !sameAddress(token, originCurrency)) {
        throw new RelayQuoteRejected(
            `relay.link quote deposits ${token}, which is not the quoted input token.`,
        )
    }

    return { depositor, token, amount, id }
}

function decodeTransferAndMulticall(
    data: Hex,
    user: Address,
    originCurrency: Address,
    inputIsNative: boolean,
    chainId: number,
): { pulls: { token: Address; amount: bigint }[]; party: PartyCall } {
    try {
        const decoded = decodeFunctionData({ abi: transferAndMulticallAbi, data })
        const [tokens, amounts, calls, refundTo, nftRecipient] = decoded.args
        assertParty(getAddress(refundTo), user, 'refundTo')
        assertParty(getAddress(nftRecipient), user, 'nftRecipient')

        if (tokens.length !== amounts.length) {
            throw new RelayQuoteRejected('relay.link quote transferAndMulticall calldata is invalid.')
        }

        const innerCalls = calls.map((call) => innerCallOf(getAddress(call.target), call.callData))
        assertInnerCalls(innerCalls, chainId)

        const pulls = tokens.map((token, index) => {
            const address = getAddress(token)
            const amount = amounts[index] ?? 0n

            if (inputIsNative || !sameAddress(address, originCurrency)) {
                throw new RelayQuoteRejected(
                    `relay.link quote pulls ${address}, which is not the quoted input token.`,
                )
            }

            return { token: address, amount }
        })

        return {
            pulls,
            party: {
                refundTo: getAddress(refundTo),
                nftRecipient: getAddress(nftRecipient),
                innerCalls,
            },
        }
    } catch (error) {
        if (error instanceof RelayQuoteRejected) throw error
        throw new RelayQuoteRejected('relay.link quote transferAndMulticall calldata is invalid.', {
            cause: error,
        })
    }
}

function addAmount(totals: Map<string, bigint>, token: Address, amount: bigint): void {
    const key = token.toLowerCase()
    totals.set(key, (totals.get(key) ?? 0n) + amount)
}

function assertWithinCap(totals: Map<string, bigint>, cap: bigint, kind: 'approves' | 'pulls'): void {
    for (const [, sum] of totals) {
        if (sum > cap) {
            throw new RelayQuoteRejected(
                kind === 'approves'
                    ? `relay.link quote approves ${sum} base units, above the quoted input of ${cap}.`
                    : `relay.link quote pulls ${sum} base units, above the quoted input of ${cap}.`,
            )
        }
    }
}

function bindOrder(quote: RelayQuoteResponse, check: RelayQuoteCheck, depositIds: Hex[]): void {
    const order = quote.protocol?.v2
    const bridge = check.destinationChainId !== check.sourceChainId

    if (!bridge && depositIds.length === 0 && !order?.orderData && !order?.orderId) return

    if (!order?.orderData) {
        throw new RelayQuoteRejected(
            bridge
                ? 'relay.link bridge quote is missing an order. Refusing to sign.'
                : 'relay.link quote deposit is missing an order. Refusing to sign.',
        )
    }

    let orderHash: Hex

    try {
        orderHash = hashRelayOrder(quote.protocol?.v2?.orderData)
    } catch (error) {
        if (error instanceof RelayOrderRejected) {
            throw new RelayQuoteRejected(error.message, { cause: error })
        }

        throw error
    }

    const quotedId = quote.protocol?.v2?.orderId

    if (quotedId && quotedId.toLowerCase() !== orderHash.toLowerCase()) {
        throw new RelayQuoteRejected(
            `relay.link quote order id ${quotedId} does not match the order hash ${orderHash}.`,
        )
    }

    for (const id of depositIds) {
        if (id.toLowerCase() !== orderHash.toLowerCase()) {
            throw new RelayQuoteRejected(
                `relay.link quote deposit id ${id} does not match the order hash ${orderHash}.`,
            )
        }
    }

    const payees = orderPayees(quote.protocol?.v2?.orderData)

    for (const recipient of payees.outputs) {
        let address: Address

        try {
            address = getAddress(recipient)
        } catch (error) {
            throw new RelayQuoteRejected('relay.link quote output recipient is not an address.', {
                cause: error,
            })
        }

        if (!sameAddress(address, check.user) && !sameAddress(address, check.recipient)) {
            throw new RelayQuoteRejected(
                `relay.link quote pays ${address}, which is not the user or the bridge recipient.`,
            )
        }
    }

    for (const recipient of payees.refunds) {
        let address: Address

        try {
            address = getAddress(recipient)
        } catch (error) {
            throw new RelayQuoteRejected('relay.link quote refund recipient is not an address.', {
                cause: error,
            })
        }

        if (!sameAddress(address, check.user) && !sameAddress(address, check.recipient)) {
            throw new RelayQuoteRejected(
                `relay.link quote refunds the order to ${address}, which is not the user or the bridge recipient.`,
            )
        }
    }

    try {
        assertOrderRecipients(quote.protocol?.v2?.orderData, check.user, check.recipient)
    } catch (error) {
        if (error instanceof RelayOrderRejected) {
            throw new RelayQuoteRejected(error.message, { cause: error })
        }

        throw error
    }
}

function assertQuotedMinimum(quote: RelayQuoteResponse, slippageBps: number): void {
    const out = quote.details?.currencyOut
    const minimum = out?.minimumAmount
    const shown = out?.amount

    if (typeof minimum !== 'string' || !/^[0-9]+$/.test(minimum) || BigInt(minimum) === 0n) {
        throw new RelayQuoteRejected('relay.link quote minimum output is 0. Refusing to sign.')
    }

    if (typeof shown !== 'string' || !/^[0-9]+$/.test(shown)) {
        throw new RelayQuoteRejected('relay.link quote is missing the output amount. Refusing to sign.')
    }

    if (!Number.isInteger(slippageBps) || slippageBps <= 0 || slippageBps >= 10_000) {
        throw new RelayQuoteRejected('relay.link quote slippage is not a usable basis-point value.')
    }

    const floor = (BigInt(shown) * BigInt(10_000 - slippageBps)) / 10_000n

    if (BigInt(minimum) < floor) {
        throw new RelayQuoteRejected(
            `relay.link quote minimum ${minimum} is below ${floor}, the shown output minus ${slippageBps} bps of slippage.`,
        )
    }
}

/** Minimum the confirmation shows. `amountFormatted` is not a guarantee. */
export function formatQuotedBuy(amount?: RelayCurrencyAmount): string {
    const raw = amount?.minimumAmount

    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw) || BigInt(raw) === 0n) {
        return 'minimum unavailable'
    }

    const decimals = amount?.currency?.decimals

    if (typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) {
        return `minimum ${formatUnits(BigInt(raw), decimals)}`
    }

    return `minimum ${raw}`
}

/**
 * Tokens other than the quoted input that this wallet can name.
 * The swap standing-rights check uses `knownErc20Tokens`, which also includes
 * the quoted input. An unknown ERC-20 is not in either list. That is the residual.
 */
export function foreignAllowanceTokens(chainId: number, inputToken: Address | undefined): Address[] {
    const candidates = [
        WETH_BY_CHAIN[chainId],
        getUsdcAddressByChainId(chainId),
        getUsdcAddressByChainId(chainId, true),
    ]

    const input = inputToken?.toLowerCase()
    const seen = new Set<string>()
    const tokens: Address[] = []

    for (const candidate of candidates) {
        if (!candidate) continue
        const address = getAddress(candidate)

        if (input && address.toLowerCase() === input) continue

        if (seen.has(address.toLowerCase())) continue
        seen.add(address.toLowerCase())
        tokens.push(address)
    }

    return tokens
}

export function relayAllowanceSpenders(chainId: number): Address[] {
    return (CALL_ALLOWLIST[chainId] ?? []).map((contract) => contract.address)
}

export function quotedOutputMinimum(quote: RelayQuoteResponse): bigint {
    const raw = quote.details?.currencyOut?.minimumAmount

    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw) || BigInt(raw) === 0n) {
        throw new RelayQuoteRejected('relay.link quote minimum output is 0. Refusing to sign.')
    }

    return BigInt(raw)
}

export function quoteExecutionFingerprint(quote: RelayQuoteResponse): string {
    const calls = incompleteItems(quote).map(
        (item) =>
            `${item.data.chainId}|${item.data.to.toLowerCase()}|${item.data.value}|${item.data.data.toLowerCase()}`,
    )

    const order = quote.protocol?.v2
    const orderText = order ? JSON.stringify({ orderId: order.orderId, orderData: order.orderData }) : ''

    return `${calls.join(';')}|${orderText}`
}

function incompleteItems(quote: RelayQuoteResponse) {
    return quote.steps.flatMap((step) =>
        step.kind === 'transaction'
            ? step.items.filter((item) => item.status === 'incomplete')
            : [],
    )
}

export type RelayQuoteReviewOptions = {
    /**
     * Review the calls only. A swap-session daemon signature has the
     * Orchestrator intent, not the relay order or the quoted minimum.
     * Order binding and the output floor stay on `tw swap` / `tw bridge`
     * before that signature is requested.
     */
    callsOnly?: boolean
}

export function reviewRelayQuote(
    quote: RelayQuoteResponse,
    check: RelayQuoteCheck,
    options?: RelayQuoteReviewOptions,
): RelayQuoteReview {
    const cap = quotedInputCap(check.inputAmount, quote)
    const contracts = contractsFor(check.sourceChainId)
    const user = getAddress(check.user)

    let nativeValue = 0n
    const approveTotals = new Map<string, bigint>()
    const pullTotals = new Map<string, bigint>()
    const depositIds: Hex[] = []
    const tokens = new Set<string>()

    if (!check.inputIsNative) tokens.add(getAddress(check.originCurrency))

    for (const item of incompleteItems(quote)) {
        if (item.data.chainId !== check.sourceChainId) {
            throw new RelayQuoteRejected(
                `relay.link returned a step for chain ${item.data.chainId}, expected source chain ${check.sourceChainId}.`,
            )
        }

        const value = parseValue(item.data.value)
        const selector = selectorOf(item.data.data)
        let target: Address

        try {
            target = getAddress(item.data.to)
        } catch (error) {
            throw new RelayQuoteRejected(`relay.link quote calls invalid target ${item.data.to}.`, {
                cause: error,
            })
        }

        const contract = contractAt(check.sourceChainId, target)
        const forbidden = FORBIDDEN_SELECTORS[selector]

        if (forbidden) {
            throw new RelayQuoteRejected(
                `relay.link quote includes ${forbidden} (${selector}) on ${target}, which swap and bridge will not sign.`,
            )
        }

        if (selector === APPROVE_SELECTOR) {
            if (value !== 0n) {
                throw new RelayQuoteRejected(
                    `relay.link quote attaches native value ${value}, which this quote did not ask to spend.`,
                )
            }

            const approve = decodeApprove(item.data.data)

            if (!isAllowlistedSpender(check.sourceChainId, approve.spender)) {
                throw new RelayQuoteRejected(
                    `relay.link quote approves ${approve.spender}, which is not an allowlisted relay.link contract.`,
                )
            }

            if (check.inputIsNative || !sameAddress(target, check.originCurrency)) {
                throw new RelayQuoteRejected(
                    `relay.link quote approves ${target}, which is not the quoted input token.`,
                )
            }

            addAmount(approveTotals, target, approve.amount)
            tokens.add(target)
        } else if (!contracts) {
            throw new RelayQuoteRejected(
                `relay.link has no allowlisted router on chain ${check.sourceChainId}. Refusing to sign.`,
            )
        } else if (!contract) {
            throw new RelayQuoteRejected(
                `relay.link quote calls ${target} with ${selector}, which is not an allowlisted relay.link contract.`,
            )
        } else if (!contract.selectors[selector]) {
            throw new RelayQuoteRejected(
                `relay.link quote calls ${contract.name} (${target}) with unknown selector ${selector}.`,
            )
        } else if (!VALUE_SELECTORS.has(selector) || !check.inputIsNative) {
            if (value !== 0n) {
                throw new RelayQuoteRejected(
                    `relay.link quote attaches native value ${value}, which this quote did not ask to spend.`,
                )
            }
        }

        if (selector === DEPOSIT_NATIVE_SELECTOR && contract) {
            const decoded = decodeDepositNative(item.data.data, user)
            depositIds.push(decoded.id)
        } else if (selector === DEPOSIT_ERC20_SELECTOR && contract) {
            const decoded = decodeDepositErc20(
                item.data.data,
                user,
                check.originCurrency,
                check.inputIsNative,
            )

            addAmount(pullTotals, decoded.token, decoded.amount)
            tokens.add(decoded.token)
            depositIds.push(decoded.id)
        } else if (selector === TRANSFER_AND_MULTICALL_SELECTOR && contract) {
            const decoded = decodeTransferAndMulticall(
                item.data.data,
                user,
                check.originCurrency,
                check.inputIsNative,
                check.sourceChainId,
            )

            for (const pull of decoded.pulls) {
                addAmount(pullTotals, pull.token, pull.amount)
                tokens.add(pull.token)
            }
        } else if (selector === MULTICALL_SELECTOR && contract) {
            decodeMulticall(item.data.data, user, check.sourceChainId)
        }

        nativeValue += value
    }

    if (nativeValue > (check.inputIsNative ? cap : 0n)) {
        throw new RelayQuoteRejected(
            `relay.link quote attaches native value ${nativeValue}, above the quoted input of ${cap}.`,
        )
    }

    assertWithinCap(approveTotals, cap, 'approves')
    assertWithinCap(pullTotals, cap, 'pulls')

    if (!options?.callsOnly) {
        bindOrder(quote, { ...check, user }, depositIds)
        assertQuotedMinimum(quote, check.slippageBps)
    }

    if (check.payment) {
        const feeToken = getUsdcAddressByChainId(check.sourceChainId)

        if (!feeToken) {
            throw new RelayQuoteRejected(
                `Chain ${check.sourceChainId} has no USDC deployment. Refusing a quote payment.`,
            )
        }

        try {
            reviewQuotePayment({
                paymentToken: check.payment.token,
                paymentAmount: check.payment.amount,
                paymentRecipient: check.payment.recipient,
                feeToken,
                feeAmount: check.payment.feeAmount,
                recipient: check.payment.expectedRecipient,
            })
        } catch (error) {
            if (error instanceof QuotePaymentRejected) {
                throw new RelayQuoteRejected(error.message, { cause: error })
            }

            throw error
        }
    }

    return { cap, tokens: [...tokens].map((token) => getAddress(token)) }
}

const SESSION_SIGNATURE_CAP = 10n ** 30n

function selectorPrefix(data: Hex): string {
    return data.length >= 10 ? data.slice(0, 10).toLowerCase() : '0x'
}

/**
 * Origin for a session signature that has calls but no relay quote.
 * Approve and ERC-20 deposit name the input token. A native multicall does not.
 */
function intentOrigin(calls: readonly { to: Address; data: Hex }[]): {
    inputIsNative: boolean
    originCurrency: Address
} {
    for (const call of calls) {
        if (selectorPrefix(call.data) === APPROVE_SELECTOR) {
            return { inputIsNative: false, originCurrency: getAddress(call.to) }
        }
    }

    for (const call of calls) {
        if (selectorPrefix(call.data) !== DEPOSIT_ERC20_SELECTOR) continue

        if (call.data.length < 2 + 8 + 64 * 2) continue

        return {
            inputIsNative: false,
            originCurrency: getAddress(`0x${call.data.slice(10 + 64 + 24, 10 + 128)}`),
        }
    }

    for (const call of calls) {
        if (selectorPrefix(call.data) !== TRANSFER_AND_MULTICALL_SELECTOR) continue

        try {
            const decoded = decodeFunctionData({ abi: transferAndMulticallAbi, data: call.data })
            const token = decoded.args[0][0]

            if (token) return { inputIsNative: false, originCurrency: getAddress(token) }
        } catch {
            // reviewRelayQuote reports the bad calldata.
        }
    }

    return { inputIsNative: true, originCurrency: zeroAddress }
}

/**
 * The call-shape half of `reviewRelayQuote`, for a swap session that is
 * signing an Orchestrator intent rather than holding the relay quote.
 * Inner selectors other than cleanupErc20s and cleanupNative are refused.
 */
export function reviewRelayIntentCalls(input: {
    chainId: number
    user: Address
    calls: readonly { to: Address; value: bigint; data: Hex }[]
}): void {
    const user = getAddress(input.user)
    const origin = intentOrigin(input.calls)

    const quote: RelayQuoteResponse = {
        steps: [
            {
                id: 'swap',
                kind: 'transaction',
                items: input.calls.map((call) => ({
                    status: 'incomplete' as const,
                    data: {
                        to: getAddress(call.to),
                        data: call.data,
                        value: call.value.toString(),
                        chainId: input.chainId,
                    },
                })),
            },
        ],
        details: {
            currencyIn: { amount: SESSION_SIGNATURE_CAP.toString() },
            currencyOut: { amount: '1', minimumAmount: '1' },
        },
    }

    reviewRelayQuote(
        quote,
        {
            sourceChainId: input.chainId,
            destinationChainId: input.chainId,
            slippageBps: 1,
            inputAmount: SESSION_SIGNATURE_CAP,
            inputIsNative: origin.inputIsNative,
            originCurrency: origin.originCurrency,
            user,
            recipient: user,
        },
        { callsOnly: true },
    )
}

function partySuffix(data: Hex, selector: string): { suffix: string; inners: string[] } {
    try {
        if (selector === APPROVE_SELECTOR) return { suffix: '', inners: [] }

        if (selector === MULTICALL_SELECTOR) {
            const decoded = decodeFunctionData({ abi: multicallAbi, data })
            const refundTo = getAddress(decoded.args[1])
            const nftRecipient = getAddress(decoded.args[2])

            const inners = decoded.args[0].map((call, index) => {
                const inner = innerCallOf(getAddress(call.target), call.callData)

                return `    inner ${index + 1}. ${inner.target} ${inner.functionName} (${inner.selector})`
            })

            return {
                suffix: ` refundTo ${refundTo} nftRecipient ${nftRecipient}`,
                inners,
            }
        }

        if (selector === TRANSFER_AND_MULTICALL_SELECTOR) {
            const decoded = decodeFunctionData({ abi: transferAndMulticallAbi, data })
            const refundTo = getAddress(decoded.args[3])
            const nftRecipient = getAddress(decoded.args[4])

            const inners = decoded.args[2].map((call, index) => {
                const inner = innerCallOf(getAddress(call.target), call.callData)

                return `    inner ${index + 1}. ${inner.target} ${inner.functionName} (${inner.selector})`
            })

            return {
                suffix: ` refundTo ${refundTo} nftRecipient ${nftRecipient}`,
                inners,
            }
        }

        if (selector === DEPOSIT_NATIVE_SELECTOR && data.length >= 10 + 64) {
            const depositor = getAddress(`0x${data.slice(10 + 24, 10 + 64)}`)

            return { suffix: ` depositor ${depositor}`, inners: [] }
        }

        if (selector === DEPOSIT_ERC20_SELECTOR && data.length >= 10 + 64) {
            const depositor = getAddress(`0x${data.slice(10 + 24, 10 + 64)}`)

            return { suffix: ` depositor ${depositor}`, inners: [] }
        }
    } catch {
        return { suffix: '', inners: [] }
    }

    return { suffix: '', inners: [] }
}

export function formatRelayQuoteCalls(quote: RelayQuoteResponse): string {
    const lines: string[] = []
    let callIndex = 0

    for (const item of incompleteItems(quote)) {
        let target = item.data.to
        let targetName: string | undefined
        let selector = '0x'
        let functionName = 'unknown'
        let value = item.data.value

        try {
            target = getAddress(item.data.to)
            selector = selectorOf(item.data.data)
            targetName = contractAt(item.data.chainId, target)?.name
            functionName = functionNameFor(selector, contractAt(item.data.chainId, target))

            if (selector === APPROVE_SELECTOR) functionName = 'approve'
        } catch {
            selector = item.data.data.startsWith('0x') ? item.data.data.slice(0, 10) : '0x'
        }

        const targetLabel = targetName ? `${targetName} (${target})` : target
        let approve = ''

        if (selector === APPROVE_SELECTOR) {
            try {
                const decoded = decodeApprove(item.data.data as Hex)
                const name = spenderName(item.data.chainId, decoded.spender)
                const spenderLabel = name ? `${name} (${decoded.spender})` : decoded.spender
                approve = ` spender ${spenderLabel} amount ${decoded.amount}`
            } catch {
                approve = ' spender unknown'
            }
        }

        const party = partySuffix(item.data.data as Hex, selector)
        callIndex += 1
        lines.push(
            `  ${callIndex}. ${targetLabel} ${functionName} (${selector})${approve}${party.suffix} value ${value}`,
        )
        lines.push(...party.inners)
    }

    const payees = orderPayees(quote.protocol?.v2?.orderData)

    if (payees.outputs.length > 0) {
        lines.push(`Output recipient: ${payees.outputs.join(', ')}`)
    }

    if (lines.length === 0) return ''

    return `Calls:\n${lines.join('\n')}\n`
}
