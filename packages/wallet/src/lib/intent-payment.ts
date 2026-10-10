import { getAddress, zeroAddress, type Address } from 'viem'
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
type IntentPayment = { payer: Address; paymentToken: Address; paymentMaxAmount: bigint }

export function resolveIntentPayment(
    env: EnvName,
    chainId: number,
    from: Address,
): IntentPayment {
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

export class QuotePaymentRejected extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'QuotePaymentRejected'
    }
}

/**
 * The signed payment must be the quote's fee, in that fee's token, paid to
 * the expected recipient, and it must also sit at or under the 5 USDC ceiling.
 * A zero token and a zero amount is no payment.
 *
 * `paymentAmount` and `paymentRecipient` are not in the Orchestrator intent
 * typehash. This check refuses a message that already names a different token,
 * amount, or recipient. The filler can still replace the recipient after the
 * signature, because that field is not signed.
 */
export function reviewQuotePayment(input: {
    paymentToken: Address
    paymentAmount: bigint
    paymentRecipient: Address
    feeToken: Address
    feeAmount: bigint
    recipient: Address
}): void {
    const token = getAddress(input.paymentToken)
    const recipient = getAddress(input.paymentRecipient)
    const feeToken = getAddress(input.feeToken)
    const expectedRecipient = getAddress(input.recipient)

    if (input.paymentAmount < 0n || input.feeAmount < 0n) {
        throw new QuotePaymentRejected('Payment amount is negative.')
    }

    if (input.paymentAmount === 0n && token === zeroAddress) {
        if (recipient !== zeroAddress && recipient !== expectedRecipient) {
            throw new QuotePaymentRejected(
                `Payment recipient ${recipient} is not the expected recipient ${expectedRecipient}.`,
            )
        }

        return
    }

    if (token !== feeToken) {
        throw new QuotePaymentRejected(
            `Payment token ${token} is not the quote fee token ${feeToken}.`,
        )
    }

    if (input.paymentAmount > PAID_FEE_CAP || input.feeAmount > PAID_FEE_CAP) {
        throw new QuotePaymentRejected(
            `Payment amount ${input.paymentAmount} is over the 5 USDC ceiling (${PAID_FEE_CAP}).`,
        )
    }

    if (input.paymentAmount > input.feeAmount) {
        throw new QuotePaymentRejected(
            `Payment amount ${input.paymentAmount} is over the quote fee ${input.feeAmount}.`,
        )
    }

    if (recipient !== expectedRecipient) {
        throw new QuotePaymentRejected(
            `Payment recipient ${recipient} is not the expected recipient ${expectedRecipient}.`,
        )
    }
}

export function discloseFeeCap(token: Address, amount: bigint): FeeCapDisclosure {
    const native = getAddress(token) === zeroAddress

    return {
        token,
        symbol: native ? 'none' : 'USDC',
        // Native value is wei. A zero native cap stays "0" so local dev output
        // is unchanged. Any other native amount is labeled in wei, not 6-decimal USDC.
        amountUsdc: native ? (amount === 0n ? '0' : `${amount.toString()} wei`) : formatUsdcAmount(amount),
        expiresIn: '1h',
    }
}
