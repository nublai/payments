import type { Address } from 'viem'

export interface GetCallsHistoryParams {
    address: Address
    chainIds?: string[] // hex format, e.g. ['0x2105']
    limit?: number // default 20, max 100
    offset?: number // default 0
}

export interface CallHistoryItem {
    id: string // bundle_id
    chain_id: string // hex chain ID
    created_at: number // unix ms
}

export interface GetCallsHistoryResult {
    items: CallHistoryItem[]
    total: number
}
