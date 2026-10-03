import type { Address, Hex } from 'viem'
import type { BundleStatusResponse, Call, RelayerPublicClient } from '../types'
import type { RelayerActions } from '../decorators/relayer'
import { waitForBundle } from '../actions/waitForBundle'
import type { PrepareCallsResponse } from '../actions/prepareCalls'
import {
    signPreparedCalls,
    type SignPreparedCallsResult,
    type SignPreparedCallsSigner,
} from './signPreparedCalls'

export interface ExecutePreparedCallsParams {
    client: RelayerPublicClient & RelayerActions
    from: Address
    calls: Call[]
    chainId?: number
    nonce?: bigint
    noncePolicy?: 'latest' | 'draft'
    seqKey?: bigint
    prepareKey?: string
    expiry?: bigint
    settler?: Address
    settlerContext?: Hex
    sessionKey?: Hex
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: bigint
    paymentSignature?: Hex
    signer: SignPreparedCallsSigner
    skipWait?: boolean
    waitIntervalMs?: number
    waitTimeoutMs?: number
}

export interface ExecutePreparedCallsResult {
    id: string
    prepared: PrepareCallsResponse
    signed: SignPreparedCallsResult
    finalStatus?: BundleStatusResponse
}

/**
 * Orchestrate prepare -> sign -> send -> (optional) wait in one helper.
 */
export async function executePreparedCalls(
    params: ExecutePreparedCallsParams,
): Promise<ExecutePreparedCallsResult> {
    const prepared = await params.client.prepareCalls({
        from: params.from,
        calls: params.calls,
        chainId: params.chainId,
        nonce: params.nonce,
        noncePolicy: params.noncePolicy,
        seqKey: params.seqKey,
        prepareKey: params.prepareKey,
        expiry: params.expiry,
        settler: params.settler,
        settlerContext: params.settlerContext,
        sessionKey: params.sessionKey,
        payer: params.payer,
        paymentToken: params.paymentToken,
        paymentMaxAmount: params.paymentMaxAmount,
    })

    const signed = await signPreparedCalls({
        prepared,
        signer: params.signer,
    })

    const submitted = await params.client.sendPreparedCalls({
        context: prepared.context,
        signature: signed.signature,
        paymentSignature: params.paymentSignature,
    })

    if (params.skipWait) {
        return {
            id: submitted.id,
            prepared,
            signed,
        }
    }

    const finalStatus = await waitForBundle(params.client, {
        id: submitted.id,
        chainId: params.chainId,
        intervalMs: params.waitIntervalMs,
        timeoutMs: params.waitTimeoutMs,
    })

    return {
        id: submitted.id,
        prepared,
        signed,
        finalStatus,
    }
}
