import {
    wrapSignature,
    type BundleStatusResponse,
    type Call,
    type PrepareCallsResponse,
} from '@agentic-payments/relayer-client'
import type { Address, Hex } from 'viem'

export type ExecuteSignedCallsParams = {
    from: Address
    calls: Call[]
    nonce: bigint
    sessionKey?: Hex
    signerPrivateKey: Hex
    signerKeyHash?: Hex
}

export type ExecuteSignedCallsDeps = {
    prepareCalls: (input: {
        from: Address
        calls: Call[]
        nonce: bigint
        sessionKey?: Hex
    }) => Promise<PrepareCallsResponse>
    signTypedData: (input: {
        privateKey: Hex
        typedData: PrepareCallsResponse['typedData']
    }) => Promise<Hex>
    sendPreparedCalls: (input: {
        context: PrepareCallsResponse['context']
        signature: Hex
    }) => Promise<{ id: string }>
    waitForBundle: (input: { id: string }) => Promise<BundleStatusResponse>
}

export async function executeSignedCalls(
    deps: ExecuteSignedCallsDeps,
    params: ExecuteSignedCallsParams,
): Promise<{ id: string; finalStatus: BundleStatusResponse }> {
    const prepared = await deps.prepareCalls({
        from: params.from,
        calls: params.calls,
        nonce: params.nonce,
        sessionKey: params.sessionKey,
    })

    const signature = await deps.signTypedData({
        privateKey: params.signerPrivateKey,
        typedData: prepared.typedData,
    })

    const effectiveSignature = params.signerKeyHash
        ? wrapSignature(signature, params.signerKeyHash)
        : signature

    const submission = await deps.sendPreparedCalls({
        context: prepared.context,
        signature: effectiveSignature,
    })

    const finalStatus = await deps.waitForBundle({ id: submission.id })

    return {
        id: submission.id,
        finalStatus,
    }
}
