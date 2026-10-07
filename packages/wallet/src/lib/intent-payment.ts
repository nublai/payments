import { zeroAddress, type Address } from 'viem'
import { getUsdcAddressByChainId, type EnvName } from './network-config'

/**
 * 5 USDC hard ceiling. The signed cap is the accepted quote plus margin,
 * and any quote or quote-plus-margin above this is refused.
 */
export const PAID_FEE_CAP = 5_000_000n

export function isLocalFeeChain(env: EnvName, chainId: number): boolean {
    return env === 'dev' || chainId === 31337 || chainId === 41337
}

/**
 * Local and dev stay at a zero ceiling. Every other chain uses the 5 USDC ceiling,
 * paid by the account. The value that gets signed is the quote plus margin.
 */
export function resolveIntentPayment(
    env: EnvName,
    chainId: number,
    from: Address,
): { payer: Address; paymentToken: Address; paymentMaxAmount: bigint } {
    if (isLocalFeeChain(env, chainId)) {
        return {
            payer: zeroAddress,
            paymentToken: zeroAddress,
            paymentMaxAmount: 0n,
        }
    }
    const paymentToken = getUsdcAddressByChainId(chainId)
    if (!paymentToken) {
        throw new Error(
            `No USDC deployment for chain ${chainId}. Refusing to sign a zero fee cap.`,
        )
    }
    return {
        payer: from,
        paymentToken,
        paymentMaxAmount: PAID_FEE_CAP,
    }
}

export type FeeCapDisclosure = {
    token: Address
    symbol: 'USDC' | 'none'
    amountUsdc: string
    expiresIn: '1h'
}

/** Human amount for a 6-decimal USDC cap. */
export function formatUsdcAmount(amount: bigint): string {
    const negative = amount < 0n
    const value = negative ? -amount : amount
    const whole = value / 1_000_000n
    const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
    const text = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString()
    return negative ? `-${text}` : text
}

export function discloseFeeCap(token: Address, amount: bigint): FeeCapDisclosure {
    return {
        token,
        symbol: token === zeroAddress ? 'none' : 'USDC',
        amountUsdc: formatUsdcAmount(amount),
        expiresIn: '1h',
    }
}
