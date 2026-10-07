import type { Hex } from 'viem'
import type { PaidUpgradeFeeAuthorization } from './paid-upgrade-fee'
import type { PaidUpgradeQuote, PrepareCallsContext } from './prepareCalls'

/**
 * Parameters for wallet_sendPreparedCalls (spec-compliant)
 */
export interface SendPreparedCallsParams {
    context: PrepareCallsContext
    signature: Hex
    /** Payment signature for third-party sponsorship (when payer != sender) */
    paymentSignature?: Hex
    capabilities?: {
        feeSignature?: Hex
    }
    /**
     * Optional echo of the quoted upgrade. When present, every field must match
     * the HMAC'd quote. The transaction is built from the quote, not from this copy.
     */
    accountUpgrade?: Partial<PaidUpgradeQuote>
    /**
     * EIP-3009 `receiveWithAuthorization` for the paid-upgrade fee.
     * The relayer checks `value`, `to`, `from`, `validBefore`, and the nonce
     * against the quote. Those fields are not taken from this object:
     * it carries the validity window, the nonce, and the signature.
     */
    feeAuthorization?: PaidUpgradeFeeAuthorization
}

/**
 * Result of wallet_sendPreparedCalls
 */
export interface SendPreparedCallsResult {
    id: string
}
