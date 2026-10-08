import type { Hex } from 'viem'
import type { ExecuteSignedCallsResult } from '../../src/lib/execute-calls'
import type { FeeCapDisclosure } from '../../src/lib/intent-payment'
import { confirmedBundle } from './bundle-status'

/** Completed executeSignedCalls result. Tests that only read id/feeCap can ignore the receipt. */
export function signedCallsResult(
    feeCap: FeeCapDisclosure,
    id = 'bundle-1',
    transactionHash?: Hex,
): ExecuteSignedCallsResult {
    return {
        id,
        finalStatus: confirmedBundle(id, transactionHash),
        feeCap,
    }
}
