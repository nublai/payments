import type { Hex } from 'viem'

/**
 * Result of wallet_getCallsStatus
 */
export interface GetCallsStatusResult {
    id: string
    status: number // 100=Pending, 200=Confirmed, 201=PreConfirmed, 300=Failed, 400=Reverted, 500=Partially Reverted
    receipts: Array<{
        chain_id: string
        transaction_hash: Hex
        status: boolean // Transaction success
        block_hash?: string
        block_number?: string
        gas_used: string
        logs: unknown[]
        /** Intent execution error (bytes4 selector, e.g., 0x9054c912 for ExceededSpendLimit) */
        intent_error?: Hex
    }>
    capabilities?: Record<string, unknown>
}
