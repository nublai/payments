/**
 * Prepare calls for signing via the relayer
 */

import type { Address, Hex } from 'viem'
import type { RelayerPublicClient, Call, EIP712Domain, INTENT_TYPES } from '../types'
import { createRelayerTransport } from '../transport'
import type { RpcPrepareCallsContext, RpcPrepareCallsResult } from '../rpc-schema'

const getNonceAbi = [
    {
        type: 'function',
        name: 'getNonce',
        stateMutability: 'view',
        inputs: [{ name: 'seqKey', type: 'uint192' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
] as const

export interface PrepareCallsParams {
    /** The address of the delegated account */
    from: Address
    /** Optional chain ID override (defaults to client chain) */
    chainId?: number
    /** Calls to execute */
    calls: Call[]
    /** Optional nonce override */
    nonce?: bigint
    /**
     * Nonce resolution behavior when `nonce` is not provided.
     * - `latest` (default): read `getNonce(seqKey)` from chain and pass it explicitly.
     * - `draft`: let relayer allocate/replay nonce drafts.
     */
    noncePolicy?: 'latest' | 'draft'
    /** Optional sequence key for 2D nonce */
    seqKey?: bigint
    /** Optional idempotency key for prepare replay on a lane */
    prepareKey?: string
    /** Optional expiry override */
    expiry?: bigint
    /** Settler address (optional) */
    settler?: Address
    /** Settler context for cross-chain settlement (optional) */
    settlerContext?: Hex
    /** Session key's public key for gas simulation accuracy */
    sessionKey?: Hex
    /** Payer address for gas reimbursement */
    payer?: Address
    /** Payment token for reimbursement */
    paymentToken?: Address
    /** Maximum payment amount */
    paymentMaxAmount?: bigint
}

/**
 * Prepared calls context - opaque to the client, passed to sendPreparedCalls
 */
export type PrepareCallsContext = RpcPrepareCallsContext

/**
 * Response from prepareCalls
 */
export interface PrepareCallsResponse {
    /** Context to pass to sendPreparedCalls */
    context: PrepareCallsContext
    /** The EIP-712 digest to sign */
    digest: Hex
    /** The EIP-712 typed data for signing (ready to pass to viem signTypedData) */
    typedData: {
        domain: EIP712Domain
        types: typeof INTENT_TYPES
        primaryType: 'Intent'
        message: {
            multichain: boolean
            eoa: Address
            calls: readonly { to: Address; value: bigint; data: Hex }[]
            nonce: bigint
            payer: Address
            paymentToken: Address
            paymentMaxAmount: bigint
            combinedGas: bigint
            encodedPreCalls: readonly Hex[]
            encodedFundTransfers: readonly Hex[]
            settler: Address
            expiry: bigint
        }
    }
}

/**
 * Prepare calls for signing
 *
 * Uses JSON-RPC `wallet_prepareCalls` method.
 *
 * Returns EIP-712 typed data and computed values (nonce, gas estimate, digest)
 * for the client to sign.
 *
 * @example
 * ```typescript
 * const prepared = await client.prepareCalls({
 *   from: accountAddress,
 *   calls: [{ target, value: 0n, data }]
 * })
 *
 * // Sign with viem
 * const signature = await walletClient.signTypedData(prepared.typedData)
 *
 * // Submit
 * const { id } = await client.sendPreparedCalls({
 *   context: prepared.context,
 *   signature
 * })
 * ```
 */
export async function prepareCalls(
    client: RelayerPublicClient,
    params: PrepareCallsParams,
): Promise<PrepareCallsResponse> {
    const transport = createRelayerTransport(client)
    const chainId = params.chainId ?? client.relayerConfig.chainId ?? client.chain?.id ?? 1
    let resolvedNonce = params.nonce

    if (resolvedNonce === undefined && params.noncePolicy !== 'draft') {
        const nonceSeqKey = params.seqKey ?? 0n
        const connectedChainId = await client.getChainId().catch(() => undefined)

        const isTargetChainConnected =
            connectedChainId === undefined || connectedChainId === chainId

        if (isTargetChainConnected) {
            try {
                resolvedNonce = (await client.readContract({
                    address: params.from,
                    abi: getNonceAbi,
                    functionName: 'getNonce',
                    args: [nonceSeqKey],
                })) as bigint
            } catch {
                // Fallback to relayer-side nonce handling when on-chain read is unavailable.
                resolvedNonce = undefined
            }
        }
    }

    // Convert to JSON-RPC format
    const rpcParams = {
        from: params.from,
        chain_id: `0x${chainId.toString(16)}`,
        calls: params.calls.map((call) => ({
            to: call.target,
            data: call.data,
            value: `0x${call.value.toString(16)}`,
        })),
        session_key: params.sessionKey,
        capabilities: {
            meta: {
                nonce: resolvedNonce?.toString(),
                seq_key: params.seqKey?.toString(),
                prepare_key: params.prepareKey,
                expiry: params.expiry?.toString(),
                fee_payer: params.payer,
                fee_token: params.paymentToken,
                fee_max_amount: params.paymentMaxAmount?.toString(),
                settler: params.settler,
                settler_context: params.settlerContext,
            },
        },
    }

    const result = await transport.request<RpcPrepareCallsResult>('wallet_prepareCalls', rpcParams)

    const rawMessage = result.typedData.message

    const message: PrepareCallsResponse['typedData']['message'] = {
        multichain: rawMessage.multichain,
        eoa: rawMessage.eoa,
        calls: rawMessage.calls.map((c) => ({
            to: c.to,
            value: BigInt(c.value),
            data: c.data,
        })),
        nonce: BigInt(rawMessage.nonce),
        payer: rawMessage.payer,
        paymentToken: rawMessage.paymentToken,
        paymentMaxAmount: BigInt(rawMessage.paymentMaxAmount),
        combinedGas: BigInt(rawMessage.combinedGas),
        encodedPreCalls: rawMessage.encodedPreCalls,
        encodedFundTransfers: rawMessage.encodedFundTransfers,
        settler: rawMessage.settler,
        expiry: BigInt(rawMessage.expiry),
    }

    return {
        context: result.context,
        digest: result.digest,
        typedData: {
            domain: result.typedData.domain,
            types: result.typedData.types,
            primaryType: result.typedData.primaryType,
            message,
        },
    }
}
