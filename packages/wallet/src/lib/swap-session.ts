import { encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from 'viem'
import { ERC20_SELECTORS, type Call } from '@nubl/relayer-client'
import { accountAbi } from '@nubl/contracts/abis'
import { getUsdcAddressByChainId } from './network-config'
import { WETH_BY_CHAIN } from './quote-spend'
import { relayEntryPoints, type RelayEntryPoint } from './relay-allowlist'
import { toSpendPeriodEnum } from './session-common'

/**
 * A swap session is dedicated. Its resting canExecute is only the Relay
 * entrypoints on that chain. The quoted input token is not known at create
 * time, so approve (and transfer, only when a quote's outer calls include it)
 * is granted by the root for that quote and revoked with the minute spend.
 * The payment session is left as the active key.
 *
 * Spend is a minute limit of 0 on native, chain USDC, legacy USDC, and WETH.
 * A day limit of 0 would reject the quote: every period is checked, including
 * after this flow raises the minute slot to the quoted amount. Minute 0 keeps
 * those tokens in the guarded set between quotes. The quote installer writes
 * the minute slot and restores it to 0. This period is full access, so create
 * requires CREATE SWAP SESSION. It does not install the 10 USDC/day
 * default, and a 0 minute limit adds nothing to that daily stack.
 */

const APPROVE_SELECTOR = ERC20_SELECTORS.APPROVE
const TRANSFER_SELECTOR = ERC20_SELECTORS.TRANSFER

export class SwapSessionRejected extends Error {
    override cause?: unknown

    constructor(message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'SwapSessionRejected'
        this.cause = options?.cause
    }
}

export type SwapCallGrant = {
    target: Address
    selector: Hex
}

type CallPermission = {
    type: string
    to?: string
    selector?: string
}

export function swapSessionSpendTokens(chainId: number): Address[] {
    const tokens: Address[] = [zeroAddress]
    const extras = [
        getUsdcAddressByChainId(chainId),
        getUsdcAddressByChainId(chainId, true),
        WETH_BY_CHAIN[chainId],
    ]
    for (const extra of extras) {
        if (!extra) continue
        const address = getAddress(extra)
        if (tokens.some((token) => token.toLowerCase() === address.toLowerCase())) continue
        tokens.push(address)
    }
    return tokens
}

export function relaySessionCallPermissions(chainId: number): Array<{
    type: 'call'
    to: Address
    selector: Hex
}> {
    return relayEntryPoints(chainId).map((entry) => ({
        type: 'call' as const,
        to: entry.target,
        selector: entry.selector,
    }))
}

function pairKey(target: string, selector: string): string {
    return `${getAddress(target).toLowerCase()}:${selector.toLowerCase()}`
}

function callPairs(permissions: readonly CallPermission[]): { target: Address; selector: string }[] {
    const pairs: { target: Address; selector: string }[] = []
    for (const permission of permissions) {
        if (permission.type !== 'call') continue
        if (!permission.to || !permission.selector) {
            throw new SwapSessionRejected(
                'This session has a call permission with no target or selector. Refusing to sign.',
            )
        }
        pairs.push({
            target: getAddress(permission.to),
            selector: permission.selector.toLowerCase(),
        })
    }
    return pairs
}

/**
 * A swap session at rest, or during a quote that added approve or transfer
 * on one input token. A payment key and a wildcard are not.
 */
export function isSwapSessionKey(
    permissions: readonly CallPermission[],
    chainId: number,
): boolean {
    const relay = relayEntryPoints(chainId)
    if (relay.length === 0) return false
    let pairs: { target: Address; selector: string }[]
    try {
        pairs = callPairs(permissions)
    } catch {
        return false
    }
    const have = new Set(pairs.map((pair) => pairKey(pair.target, pair.selector)))
    if (!relay.every((entry) => have.has(pairKey(entry.target, entry.selector)))) return false
    const relayKeys = new Set(relay.map((entry) => pairKey(entry.target, entry.selector)))
    const extras = pairs.filter((pair) => !relayKeys.has(pairKey(pair.target, pair.selector)))
    if (extras.length === 0) return true
    const token = extras[0]!.target.toLowerCase()
    return extras.every(
        (pair) =>
            pair.target.toLowerCase() === token &&
            (pair.selector === APPROVE_SELECTOR || pair.selector === TRANSFER_SELECTOR),
    )
}

/** Resting swap key: exactly the Relay entrypoints, and no other call permission. */
export function isExactRelaySession(
    permissions: readonly CallPermission[],
    chainId: number,
): boolean {
    const relay = relayEntryPoints(chainId)
    if (relay.length === 0) return false
    let pairs: { target: Address; selector: string }[]
    try {
        pairs = callPairs(permissions)
    } catch {
        return false
    }
    if (pairs.length !== relay.length) return false
    const have = new Set(pairs.map((pair) => pairKey(pair.target, pair.selector)))
    return relay.every((entry) => have.has(pairKey(entry.target, entry.selector)))
}

function selectorOf(data: string | undefined): string | undefined {
    if (!data?.startsWith('0x') || data.length < 10) return undefined
    return data.slice(0, 10).toLowerCase()
}

/**
 * Call grants the root must add before this quote is signed.
 * Relay entrypoints must already be on the key. Approve and transfer are
 * added only for the quoted input, and transfer only when the quote includes it.
 */
export function planSwapSessionUse(input: {
    chainId: number
    permissions: readonly CallPermission[]
    inputToken?: Address
    quoteCalls: readonly { target: string; data?: string }[]
    chainLabel?: string
}): SwapCallGrant[] {
    const relay = relayEntryPoints(input.chainId)
    const chainLabel = input.chainLabel ?? String(input.chainId)
    if (relay.length === 0) {
        throw new SwapSessionRejected(
            `Chain ${chainLabel} has no relay.link contracts. Refusing to sign.`,
        )
    }
    const pairs = callPairs(input.permissions)
    const have = new Set(pairs.map((pair) => pairKey(pair.target, pair.selector)))
    for (const entry of relay) {
        if (have.has(pairKey(entry.target, entry.selector))) continue
        throw new SwapSessionRejected(
            `This session's canExecute is missing ${entry.contractName} ${entry.functionName} (${entry.selector}). Create a dedicated swap session with \`tw session create <name> --swap --chain ${chainLabel}\` and pass it with --session <name>.`,
        )
    }

    const wanted: SwapCallGrant[] = []
    const inputToken = input.inputToken ? getAddress(input.inputToken) : undefined
    if (inputToken && inputToken !== zeroAddress) {
        for (const call of input.quoteCalls) {
            let target: Address
            try {
                target = getAddress(call.target)
            } catch {
                continue
            }
            if (target.toLowerCase() !== inputToken.toLowerCase()) continue
            const selector = selectorOf(call.data)
            if (selector !== APPROVE_SELECTOR && selector !== TRANSFER_SELECTOR) continue
            if (wanted.some((grant) => grant.selector.toLowerCase() === selector)) continue
            wanted.push({ target: inputToken, selector: selector as Hex })
        }
    }

    const allowed = new Set([
        ...relay.map((entry) => pairKey(entry.target, entry.selector)),
        ...wanted.map((grant) => pairKey(grant.target, grant.selector)),
    ])
    for (const pair of pairs) {
        if (allowed.has(pairKey(pair.target, pair.selector))) continue
        throw new SwapSessionRejected(
            `This session's canExecute includes ${pair.target} ${pair.selector}, which this quote does not allow. A swap session is the Relay entrypoints plus approve on the quoted input token, and transfer only when the quote includes it.`,
        )
    }

    return wanted.filter((grant) => !have.has(pairKey(grant.target, grant.selector)))
}

export function canExecuteChangeCalls(input: {
    account: Address
    keyHash: Hex
    grants: readonly SwapCallGrant[]
    allowed: boolean
}): Call[] {
    return input.grants.map((grant) => ({
        target: getAddress(input.account),
        value: 0n,
        data: encodeFunctionData({
            abi: accountAbi,
            functionName: 'setCanExecute',
            args: [input.keyHash, getAddress(grant.target), grant.selector, input.allowed],
        }),
    }))
}

export function swapSessionInstallCalls(input: {
    account: Address
    keyHash: Hex
    chainId: number
}): { calls: Call[]; entryPoints: RelayEntryPoint[]; spendTokens: Address[] } {
    const entryPoints = relayEntryPoints(input.chainId)
    if (entryPoints.length === 0) {
        throw new SwapSessionRejected(
            `Chain ${input.chainId} has no relay.link contracts. Refusing to create a swap session.`,
        )
    }
    const spendTokens = swapSessionSpendTokens(input.chainId)
    const calls: Call[] = [
        ...entryPoints.map((entry) => ({
            target: getAddress(input.account),
            value: 0n,
            data: encodeFunctionData({
                abi: accountAbi,
                functionName: 'setCanExecute',
                args: [input.keyHash, entry.target, entry.selector, true],
            }),
        })),
        ...spendTokens.map((token) => ({
            target: getAddress(input.account),
            value: 0n,
            data: encodeFunctionData({
                abi: accountAbi,
                functionName: 'setSpendLimit',
                args: [input.keyHash, token, toSpendPeriodEnum('minute'), 0n],
            }),
        })),
    ]
    return { calls, entryPoints, spendTokens }
}
