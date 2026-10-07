import { encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import type { Call } from '@nubl/relayer-client'
import { toSpendPeriodEnum } from './session-common'

/**
 * Shortest spend period the guard implements. Every period on a token is
 * checked, so a minute limit caps a key that also has a forever max.
 * After the quote is included, a minute period this flow created is removed
 * and a minute period that was already there is set back to its old limit.
 */
export const QUOTE_SPEND_PERIOD = 'minute' as const

const MAX_UINT256 = 2n ** 256n - 1n

/** Wrapped native the wallet knows how to bound. Other ERC-20s are a residual. */
export const WETH_BY_CHAIN: Record<number, Address> = {
    8453: '0x4200000000000000000000000000000000000006',
    137: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
}

export class QuoteSpendError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'QuoteSpendError'
    }
}

export type QuoteSpendBound = {
    keyHash: Hex
    /** Account the root key calls. `setSpendLimit` is `onlyThis`. */
    account: Address
    /** Native (address 0) limit for this quote. 0 when the input is not ETH. */
    nativeLimit: bigint
    usdc: Address
    /** USDC limit for this quote. 0 when the input is not USDC. */
    usdcLimit: bigint
    /** Other tokens that must not move. Each gets a minute limit of 0. */
    frozenTokens: Address[]
}

function assertLimit(limit: bigint, label: string): void {
    if (limit < 0n || limit === MAX_UINT256) {
        throw new QuoteSpendError(
            `${label} spend limit must be the quoted input, never uint256 max.`,
        )
    }
}

export type QuoteSpendSlot = {
    token: Address
    /** Null when this key had no minute period before the quote. */
    previousLimit: bigint | null
    installedLimit: bigint
}

export type SpendInfoLike = {
    token: Address
    /** `GuardedExecutor.SpendPeriod`. Minute is 0. */
    period: number
    limit: bigint
}

function plannedTokenLimits(bound: QuoteSpendBound): { token: Address; limit: bigint }[] {
    const tokens: { token: Address; limit: bigint }[] = [
        { token: zeroAddress, limit: bound.nativeLimit },
        { token: getAddress(bound.usdc), limit: bound.usdcLimit },
    ]
    const seen = new Set(tokens.map((entry) => entry.token.toLowerCase()))
    for (const token of bound.frozenTokens) {
        const address = getAddress(token)
        if (seen.has(address.toLowerCase())) continue
        seen.add(address.toLowerCase())
        tokens.push({ token: address, limit: 0n })
    }
    return tokens
}

/**
 * Minute slots for this quote. A held token with no period at all is frozen
 * at 0 for the quote, then restored. A pre-existing minute limit is remembered
 * so release can put that limit back.
 */
export function planQuoteSpendSlots(input: {
    bound: QuoteSpendBound
    spendInfos: readonly SpendInfoLike[]
    balances: readonly { token: Address; balance: bigint }[]
}): QuoteSpendSlot[] {
    assertLimit(input.bound.nativeLimit, 'Native')
    assertLimit(input.bound.usdcLimit, 'USDC')
    const planned = plannedTokenLimits(input.bound)
    const seen = new Set(planned.map((entry) => entry.token.toLowerCase()))
    for (const balance of input.balances) {
        const token = getAddress(balance.token)
        if (balance.balance <= 0n) continue
        if (seen.has(token.toLowerCase())) continue
        const hasPeriod = input.spendInfos.some(
            (info) => getAddress(info.token).toLowerCase() === token.toLowerCase(),
        )
        if (hasPeriod) continue
        seen.add(token.toLowerCase())
        planned.push({ token, limit: 0n })
    }
    return planned.map((entry) => {
        const minute = input.spendInfos.find(
            (info) =>
                getAddress(info.token).toLowerCase() === entry.token.toLowerCase() &&
                Number(info.period) === 0,
        )
        return {
            token: entry.token,
            installedLimit: entry.limit,
            previousLimit: minute ? minute.limit : null,
        }
    })
}

function spendCall(input: {
    account: Address
    keyHash: Hex
    token: Address
    mode: 'set' | 'remove'
    limit?: bigint
}): Call {
    const period = toSpendPeriodEnum(QUOTE_SPEND_PERIOD)
    return {
        target: getAddress(input.account),
        value: 0n,
        data: encodeFunctionData({
            abi: accountAbi,
            functionName: input.mode === 'set' ? 'setSpendLimit' : 'removeSpendLimit',
            args:
                input.mode === 'set'
                    ? [input.keyHash, input.token, period, input.limit ?? 0n]
                    : [input.keyHash, input.token, period],
        }),
    }
}

export function quoteSpendSetCalls(input: {
    keyHash: Hex
    account: Address
    slots: readonly QuoteSpendSlot[]
}): Call[] {
    return input.slots.map((slot) => {
        assertLimit(slot.installedLimit, slot.token)
        return spendCall({
            account: input.account,
            keyHash: input.keyHash,
            token: slot.token,
            mode: 'set',
            limit: slot.installedLimit,
        })
    })
}

/** Put back the minute period that was on the key before this quote. */
export function quoteSpendRestoreCalls(input: {
    keyHash: Hex
    account: Address
    slots: readonly Pick<QuoteSpendSlot, 'token' | 'previousLimit'>[]
}): Call[] {
    return input.slots.map((slot) => {
        if (slot.previousLimit === null) {
            return spendCall({
                account: input.account,
                keyHash: input.keyHash,
                token: slot.token,
                mode: 'remove',
            })
        }
        if (slot.previousLimit < 0n) {
            throw new QuoteSpendError(
                `${slot.token} previous minute limit cannot be restored.`,
            )
        }
        return spendCall({
            account: input.account,
            keyHash: input.keyHash,
            token: slot.token,
            mode: 'set',
            limit: slot.previousLimit,
        })
    })
}

/**
 * Calls the root key submits so the session's own execution is capped.
 * The input token's minute limit equals the quoted amount. Every other
 * token we can name gets 0, so a balance drop reverts `ExceededSpendLimit`.
 * A forever `uint256` max on native does not raise this cap: the guard
 * checks every period.
 */
export function quoteSpendCalls(bound: QuoteSpendBound, mode: 'set' | 'remove'): Call[] {
    assertLimit(bound.nativeLimit, 'Native')
    assertLimit(bound.usdcLimit, 'USDC')
    return plannedTokenLimits(bound).map((entry) =>
        spendCall({
            account: bound.account,
            keyHash: bound.keyHash,
            token: entry.token,
            mode,
            limit: entry.limit,
        }),
    )
}
