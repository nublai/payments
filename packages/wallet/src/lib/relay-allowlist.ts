import { decodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from 'viem'
import type { RelayQuoteResponse } from './relay-link'

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
    inputAmount: bigint
    inputIsNative: boolean
    originCurrency: Address
}

type ReviewedCall = {
    target: Address
    targetName?: string
    selector: string
    functionName: string
    value: bigint
    chainId: number
    approveSpender?: Address
    approveSpenderName?: string
    approveAmount?: bigint
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

function assertDepositErc20(input: { data: Hex; cap: bigint; originCurrency: Address }): void {
    if (input.data.length < 2 + 8 + 64 * 3) {
        throw new RelayQuoteRejected('relay.link quote depositErc20 calldata is incomplete.')
    }
    let token: Address
    let amount: bigint
    try {
        token = getAddress(`0x${input.data.slice(10 + 64 + 24, 10 + 64 + 64)}`)
        amount = BigInt(`0x${input.data.slice(10 + 64 * 2, 10 + 64 * 3)}`)
    } catch (error) {
        throw new RelayQuoteRejected('relay.link quote depositErc20 calldata is invalid.', {
            cause: error,
        })
    }
    if (token.toLowerCase() !== input.originCurrency.toLowerCase()) {
        throw new RelayQuoteRejected(
            `relay.link quote deposits ${token}, which is not the quoted input token.`,
        )
    }
    if (amount > input.cap) {
        throw new RelayQuoteRejected(
            `relay.link quote deposits ${amount} base units, above the quoted input of ${input.cap}.`,
        )
    }
}

function assertTransferAndMulticall(data: Hex, cap: bigint): void {
    let amounts: readonly bigint[]
    try {
        const decoded = decodeFunctionData({ abi: transferAndMulticallAbi, data })
        amounts = decoded.args[1]
    } catch (error) {
        throw new RelayQuoteRejected('relay.link quote transferAndMulticall calldata is invalid.', {
            cause: error,
        })
    }
    let sum = 0n
    for (const amount of amounts) {
        if (amount > cap) {
            throw new RelayQuoteRejected(
                `relay.link quote pulls ${amount} base units, above the quoted input of ${cap}.`,
            )
        }
        sum += amount
    }
    if (sum > cap) {
        throw new RelayQuoteRejected(
            `relay.link quote pulls ${sum} base units, above the quoted input of ${cap}.`,
        )
    }
}

function incompleteItems(quote: RelayQuoteResponse) {
    return quote.steps.flatMap((step) =>
        step.kind === 'transaction'
            ? step.items.filter((item) => item.status === 'incomplete')
            : [],
    )
}

export function reviewRelayQuote(
    quote: RelayQuoteResponse,
    check: RelayQuoteCheck,
): ReviewedCall[] {
    const cap = quotedInputCap(check.inputAmount, quote)
    const contracts = contractsFor(check.sourceChainId)

    let nativeValue = 0n
    const reviewed: ReviewedCall[] = []
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

        let approveSpender: Address | undefined
        let approveSpenderName: string | undefined
        let approveAmount: bigint | undefined
        let functionName = functionNameFor(selector, contract)

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
            if (approve.amount > cap) {
                throw new RelayQuoteRejected(
                    `relay.link quote approves ${approve.amount} base units, above the quoted input of ${cap}.`,
                )
            }
            approveSpender = approve.spender
            approveSpenderName = spenderName(check.sourceChainId, approve.spender)
            approveAmount = approve.amount
            functionName = 'approve'
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
        } else if (selector === DEPOSIT_ERC20_SELECTOR) {
            if (value !== 0n) {
                throw new RelayQuoteRejected(
                    `relay.link quote attaches native value ${value}, which this quote did not ask to spend.`,
                )
            }
            assertDepositErc20({
                data: item.data.data,
                cap,
                originCurrency: check.originCurrency,
            })
        } else if (selector === TRANSFER_AND_MULTICALL_SELECTOR) {
            if (value !== 0n) {
                throw new RelayQuoteRejected(
                    `relay.link quote attaches native value ${value}, which this quote did not ask to spend.`,
                )
            }
            assertTransferAndMulticall(item.data.data, cap)
        } else if (!VALUE_SELECTORS.has(selector) || !check.inputIsNative) {
            if (value !== 0n) {
                throw new RelayQuoteRejected(
                    `relay.link quote attaches native value ${value}, which this quote did not ask to spend.`,
                )
            }
        }

        nativeValue += value
        reviewed.push({
            target,
            targetName: contract?.name,
            selector,
            functionName,
            value,
            chainId: item.data.chainId,
            approveSpender,
            approveSpenderName,
            approveAmount,
        })
    }

    if (nativeValue > (check.inputIsNative ? cap : 0n)) {
        throw new RelayQuoteRejected(
            `relay.link quote attaches native value ${nativeValue}, above the quoted input of ${cap}.`,
        )
    }
    return reviewed
}

export function formatRelayQuoteCalls(quote: RelayQuoteResponse): string {
    const lines: string[] = []
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
        lines.push(
            `  ${lines.length + 1}. ${targetLabel} ${functionName} (${selector})${approve} value ${value}`,
        )
    }
    if (lines.length === 0) return ''
    return `Calls:\n${lines.join('\n')}\n`
}
