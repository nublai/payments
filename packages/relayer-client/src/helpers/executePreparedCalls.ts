import { getAddress, type Address, type Hex } from 'viem'
import type { BundleStatusResponse, Call, RelayerPublicClient } from '../types'
import type { RelayerActions } from '../decorators/relayer'
import { waitForBundle } from '../actions/waitForBundle'
import type { PrepareCallsResponse } from '../actions/prepareCalls'
import {
    signPreparedCalls,
    type SignPreparedCallsResult,
    type SignPreparedCallsSigner,
} from './signPreparedCalls'
import { INTENT_EXPIRY_TTL_SECONDS, PreparedCallsBindingError } from './bindPreparedCalls'

const nonceAbi = [
    {
        type: 'function',
        name: 'getNonce',
        stateMutability: 'view',
        inputs: [{ name: 'seqKey', type: 'uint192' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
] as const

function localCombinedGasCeiling(calls: readonly { data?: Hex }[]): bigint {
    let sum = 0n
    for (const call of calls) {
        const bytes = call.data && call.data.length > 2 ? BigInt((call.data.length - 2) / 2) : 0n
        sum += 21_000n + 16n * bytes + 150_000n
    }
    if (sum === 0n) sum = 150_000n
    return sum * 8n + 500_000n
}

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
    /** Orchestrator address that must be the EIP-712 verifying contract. */
    verifyingContract?: Address
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

function readOrchestratorAddress(chainId: number): Address {
    const raw = process.env[`ORCHESTRATOR_${chainId}`]?.trim()
    if (!raw) {
        throw new PreparedCallsBindingError(
            `Refusing to sign prepared calls: set ORCHESTRATOR_${chainId} or pass verifyingContract`,
        )
    }
    return getAddress(raw)
}

/**
 * Orchestrate prepare -> sign -> send -> (optional) wait in one helper.
 */
export async function executePreparedCalls(
    params: ExecutePreparedCallsParams,
): Promise<ExecutePreparedCallsResult> {
    const chainId = params.chainId ?? params.client.chain?.id ?? params.client.relayerConfig.chainId
    if (chainId === undefined) {
        throw new PreparedCallsBindingError(
            'Refusing to sign prepared calls: chainId is required to bind the typed data',
        )
    }
    const nonce =
        params.nonce ??
        (await params.client.readContract({
            address: params.from,
            abi: nonceAbi,
            functionName: 'getNonce',
            args: [params.seqKey ?? 0n],
        }))
    const now = BigInt(Math.floor(Date.now() / 1000))
    const expiry = params.expiry ?? now + INTENT_EXPIRY_TTL_SECONDS
    const localChain = chainId === 31337 || chainId === 41337
    if (!localChain && params.paymentMaxAmount === undefined) {
        throw new PreparedCallsBindingError(
            'Refusing to sign prepared calls: paymentMaxAmount is required off local chains',
        )
    }
    const paymentMaxAmount = params.paymentMaxAmount ?? 0n

    const prepared = await params.client.prepareCalls({
        from: params.from,
        calls: params.calls,
        chainId,
        nonce,
        noncePolicy: params.noncePolicy,
        seqKey: params.seqKey,
        prepareKey: params.prepareKey,
        expiry,
        settler: params.settler,
        settlerContext: params.settlerContext,
        sessionKey: params.sessionKey,
        payer: params.payer,
        paymentToken: params.paymentToken,
        paymentMaxAmount,
    })

    const verifyingContract = params.verifyingContract ?? readOrchestratorAddress(chainId)
    const signed = await signPreparedCalls({
        prepared,
        signer: params.signer,
        expected: {
            from: params.from,
            calls: params.calls,
            chainId,
            verifyingContract,
            nonce,
            expiry,
            now,
            combinedGasCeiling: localCombinedGasCeiling(params.calls),
            settler: params.settler,
            settlerContext: params.settlerContext,
            payer: params.payer,
            paymentToken: params.paymentToken,
            paymentMaxAmount,
        },
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
