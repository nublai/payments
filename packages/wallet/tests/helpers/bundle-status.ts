import type { BundleStatusResponse } from '@nubl/relayer-client'
import type { Hex } from 'viem'
import { hex } from './hex'

const DEFAULT_TX_HASH = hex('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

/** Confirmed bundle status. Tests that only read id/statusCode can ignore the receipt. */
export function confirmedBundle(
    id = 'bundle-1',
    transactionHash: Hex = DEFAULT_TX_HASH,
): BundleStatusResponse {
    return {
        success: true,
        id,
        status: 'confirmed',
        statusCode: 200,
        receipt: {
            transactionHash,
            blockNumber: '1',
            gasUsed: '1',
            status: 'success',
        },
    }
}
