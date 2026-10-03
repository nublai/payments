import type { Hex } from 'viem'
import type { PrepareCallsContext } from './prepareCalls'

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
}

/**
 * Result of wallet_sendPreparedCalls
 */
export interface SendPreparedCallsResult {
    id: string
}
