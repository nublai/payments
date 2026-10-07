import type { Hex } from 'viem'
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
}

/**
 * Result of wallet_sendPreparedCalls
 */
export interface SendPreparedCallsResult {
    id: string
}
