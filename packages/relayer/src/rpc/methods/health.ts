/**
 * Health RPC Methods
 *
 * Methods for checking service health, liveness, and readiness.
 */

import type { RpcContext } from '../types'
import type { Env } from '../../types/env'
import { getChainConfig, getChainIds } from '../../config'
import { jsonRpcRequest } from '../../lib/json-rpc'

/**
 * wallet_health - Health check endpoint
 *
 * @param _params - No parameters required
 * @param _ctx - RPC context
 * @returns "ok" string
 */
export async function handleHealth(_params: unknown, _ctx: RpcContext): Promise<string> {
    return 'ok'
}

/**
 * wallet_live - Liveness probe for container orchestration
 *
 * Returns true if the service is running. This is a simple check
 * that doesn't verify external dependencies.
 *
 * @param _params - No parameters required
 * @param _ctx - RPC context
 * @returns true boolean
 */
export async function handleLive(_params: unknown, _ctx: RpcContext): Promise<boolean> {
    return true
}

/**
 * wallet_ready - Readiness probe
 *
 * Checks if the service is ready to handle requests.
 * In the future, this could verify:
 * - RPC endpoint connectivity
 * - Database/KV accessibility
 * - Signer pool availability
 *
 * @param _params - No parameters required
 * @param _ctx - RPC context
 * @returns true boolean if ready, throws error otherwise
 */
export async function handleReady(_params: unknown, _ctx: RpcContext): Promise<boolean> {
    const env = _ctx.env as Env
    const chainIds = getChainIds(env)

    if (chainIds.length === 0) {
        throw new Error('No configured chain IDs')
    }

    for (const chainId of chainIds) {
        const { rpcUrl } = getChainConfig(env, chainId)
        await checkRpc(rpcUrl, chainId)
        await checkSignerPool(env, chainId)
    }

    return true
}

async function checkRpc(rpcUrl: string, expectedChainId: number): Promise<void> {
    const chainIdHex = await jsonRpcRequest<string>(rpcUrl, 'eth_chainId', [], {
        timeoutMs: 3000,
    })

    const rpcChainId = parseInt(String(chainIdHex), 16)

    if (Number.isNaN(rpcChainId)) {
        throw new Error('RPC_URL returned invalid chainId')
    }

    if (rpcChainId !== expectedChainId) {
        throw new Error(`RPC_URL chainId mismatch: ${rpcChainId} != ${expectedChainId}`)
    }
}

async function checkSignerPool(env: Env, chainId: number): Promise<void> {
    const poolId = env.SIGNER_POOL.idFromName(`pool-${chainId}`)
    const pool = env.SIGNER_POOL.get(poolId)
    const response = await pool.fetch(`http://do/status?poolName=pool-${chainId}`)

    if (!response.ok) {
        throw new Error(`SignerPool status check failed: ${response.status} ${response.statusText}`)
    }

    // Ensure response is valid JSON to catch DO errors
    await response.json()
}
