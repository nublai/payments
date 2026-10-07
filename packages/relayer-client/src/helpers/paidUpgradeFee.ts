import { getAddress, type Address, type Hex } from 'viem'
import {
    feeAuthorizationWindowReason,
    paidUpgradeFeeNonce,
    paidUpgradeFeeTypedData,
    type PaidUpgradeFeeAuthorization,
} from '@nubl/relayer/rpc/schema/paid-upgrade-fee'

export { paidUpgradeFeeNonce }

import { PreparedCallsBindingError, signedPaymentMaxForQuote } from './bindPreparedCalls'

const REFUSE = 'Refusing to sign prepared calls'

/**
 * Typed data the account key signs for `receiveWithAuthorization`.
 * Checked before the signature: the amount is the quote's clamped fee, the
 * payee is the expected relayer fee recipient, and the nonce is the quote binding.
 */
export function paidUpgradeFeeAuthorizationToSign(input: {
    account: Address
    chainId: number
    token: Address
    quoteSignature: Hex
    quoteTtl: number
    paymentAmount: bigint
    paymentMaxAmount: bigint
    quoteFeeRecipient?: Address
    expectedFeeRecipient: Address
    now?: bigint
}): {
    typedData: ReturnType<typeof paidUpgradeFeeTypedData>
    authorization: Omit<PaidUpgradeFeeAuthorization, 'signature'>
} {
    const now = input.now ?? BigInt(Math.floor(Date.now() / 1000))
    const value = signedPaymentMaxForQuote(input.paymentAmount)
    if (value <= 0n) {
        throw new PreparedCallsBindingError(`${REFUSE}: paid upgrade fee is zero`)
    }
    if (input.paymentMaxAmount !== value) {
        throw new PreparedCallsBindingError(`${REFUSE}: fee amount does not match the quote`)
    }
    const payee = input.expectedFeeRecipient
    if (!input.quoteFeeRecipient || getAddress(input.quoteFeeRecipient) !== getAddress(payee)) {
        throw new PreparedCallsBindingError(`${REFUSE}: fee recipient does not match`)
    }
    let nonce: Hex
    try {
        nonce = paidUpgradeFeeNonce({
            quoteSignature: input.quoteSignature,
            chainId: input.chainId,
            from: input.account,
            to: payee,
            value,
        })
    } catch {
        throw new PreparedCallsBindingError(`${REFUSE}: fee nonce does not match the quote`)
    }
    const ttl = BigInt(input.quoteTtl)
    const proposed = now + 120n
    const validBefore = proposed < ttl ? proposed : ttl
    const window = feeAuthorizationWindowReason({
        validAfter: 0n,
        validBefore,
        now,
        quoteTtl: ttl,
    })
    if (window) {
        throw new PreparedCallsBindingError(`${REFUSE}: ${window}`)
    }
    const typedData = paidUpgradeFeeTypedData({
        chainId: input.chainId,
        token: input.token,
        from: input.account,
        to: payee,
        value,
        validAfter: 0n,
        validBefore,
        nonce,
    })
    verifyPaidUpgradeFeeTypedData({
        message: typedData.message,
        account: input.account,
        chainId: input.chainId,
        quoteSignature: input.quoteSignature,
        quoteTtl: ttl,
        clampedFee: value,
        expectedFeeRecipient: payee,
        now,
    })
    return {
        typedData,
        authorization: {
            validAfter: '0',
            validBefore: validBefore.toString(),
            nonce,
        },
    }
}

export function verifyPaidUpgradeFeeTypedData(input: {
    message: {
        from: Address
        to: Address
        value: bigint
        validAfter: bigint
        validBefore: bigint
        nonce: Hex
    }
    account: Address
    chainId: number
    quoteSignature: Hex
    quoteTtl: bigint
    clampedFee: bigint
    expectedFeeRecipient: Address
    now: bigint
}): void {
    if (getAddress(input.message.from) !== getAddress(input.account)) {
        throw new PreparedCallsBindingError(`${REFUSE}: fee authorization is not from the account`)
    }
    if (input.message.value !== input.clampedFee) {
        throw new PreparedCallsBindingError(`${REFUSE}: fee amount does not match the quote`)
    }
    if (getAddress(input.message.to) !== getAddress(input.expectedFeeRecipient)) {
        throw new PreparedCallsBindingError(`${REFUSE}: fee recipient does not match`)
    }
    let expected: Hex
    try {
        expected = paidUpgradeFeeNonce({
            quoteSignature: input.quoteSignature,
            chainId: input.chainId,
            from: input.account,
            to: input.expectedFeeRecipient,
            value: input.clampedFee,
        })
    } catch {
        throw new PreparedCallsBindingError(`${REFUSE}: fee nonce does not match the quote`)
    }
    if (input.message.nonce.toLowerCase() !== expected.toLowerCase()) {
        throw new PreparedCallsBindingError(`${REFUSE}: fee nonce does not match the quote`)
    }
    const window = feeAuthorizationWindowReason({
        validAfter: input.message.validAfter,
        validBefore: input.message.validBefore,
        now: input.now,
        quoteTtl: input.quoteTtl,
    })
    if (window) {
        throw new PreparedCallsBindingError(`${REFUSE}: ${window}`)
    }
}
