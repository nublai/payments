import { zeroAddress, type Hex } from 'viem'
import type { ExecuteSignedCallsResult } from '../../src/lib/execute-calls'
import type { FeeCapDisclosure } from '../../src/lib/intent-payment'
import { confirmedBundle } from './bundle-status'

export function testFeeCap(overrides?: Partial<FeeCapDisclosure>): FeeCapDisclosure {
    return {
        token: overrides?.token ?? zeroAddress,
        symbol: overrides?.symbol ?? 'none',
        amountUsdc: overrides?.amountUsdc ?? '0',
        expiresIn: overrides?.expiresIn ?? '1h',
    }
}

/** Completed executeSignedCalls result. Tests that only read id/feeCap can ignore the receipt. */
export function signedCallsResult(
    feeCap: FeeCapDisclosure = testFeeCap(),
    id = 'bundle-1',
    transactionHash?: Hex,
): ExecuteSignedCallsResult {
    return {
        id,
        finalStatus: confirmedBundle(id, transactionHash),
        feeCap,
    }
}
