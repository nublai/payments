import { encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import type { Call } from '@nubl/relayer-client'
import { toSpendPeriodEnum } from './session-common'

/**
 * Shortest spend period the guard implements. Every period on a token is
 * checked, so a minute limit caps a key that also has a forever max.
 * The limit is removed after the quote is included, so the minute bucket
 * does not stay on the key.
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
    const period = toSpendPeriodEnum(QUOTE_SPEND_PERIOD)
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
    return tokens.map((entry) => ({
        target: getAddress(bound.account),
        value: 0n,
        data: encodeFunctionData({
            abi: accountAbi,
            functionName: mode === 'set' ? 'setSpendLimit' : 'removeSpendLimit',
            args:
                mode === 'set'
                    ? [bound.keyHash, entry.token, period, entry.limit]
                    : [bound.keyHash, entry.token, period],
        }),
    }))
}
