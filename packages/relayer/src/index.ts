/**
 * EIP-7702 Relayer - Cloudflare Worker Entry Point
 *
 * Provides endpoints for creating EIP-7702 delegated accounts and executing intents.
 * Uses a mnemonic-based signer pool for horizontal scaling.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Hex } from 'viem'

import type { Env } from './types/env'
import type { MonitorJob } from './types/pool'
import { validateEnv, validatePoolConfig, getChainIds } from './config'
import { requestPaidUpgradeReconcile } from './rpc/methods/shared/paid-upgrade'
import { logger, errorDetails, getErrorMessage } from './lib/logger'
import { redactRpcResponse, redactSecrets } from './lib/redact'
import { dispatch } from './rpc/dispatcher'
import { createMethods } from './rpc/methods'
import type { RpcContext } from './rpc/types'
import { getChainRpcUrl } from './lib/multi-chain-client'
import { getRpcCaller } from './auth/caller'
import { authMiddleware } from './auth/middleware'
import { identityAuthProviders } from './auth/identity-registry'
import { createErc8128Provider } from './auth/providers/erc8128'

// Re-export Durable Objects for Cloudflare
export { SignerDO } from './durable-objects/signer.do'

export { SignerPoolDO } from './durable-objects/signer-pool.do'

export { BundleStatusDO } from './durable-objects/bundle-status.do'

export { IntentNonceDO } from './durable-objects/intent-nonce.do'

export { HttpAuthNonceDO } from './durable-objects/http-auth-nonce.do'

export { WalletBindingDO } from './durable-objects/wallet-binding.do'

const MAX_MONITOR_ATTEMPTS = 30

// ============================================================================
// Hono App
// ============================================================================

const app = new Hono<{ Bindings: Env }>()

// Configurable CORS via CORS_ALLOWED_ORIGINS env variable
// If not set or set to "*", allows all origins (permissive mode for backward compatibility)
// Set to a comma-separated origin list to restrict. Unset or "*" allows every origin.
app.use('*', async (c, next) => {
    const allowedOrigins = c.env.CORS_ALLOWED_ORIGINS

    // Permissive mode: no config or explicit "*"
    if (!allowedOrigins || allowedOrigins === '*') {
        return cors()(c, next)
    }

    // Restrictive mode: parse comma-separated origins
    const origins = allowedOrigins.split(',').map((o) => o.trim())

    return cors({ origin: origins })(c, next)
})

// Environment validation middleware (skip for health check)
app.use('*', async (c, next) => {
    if (c.req.path === '/health') {
        return next()
    }

    const envCheck = validateEnv(c.env)

    if (!envCheck.valid) {
        logger.error({ missing: envCheck.missing }, 'missing required environment variables')

        return c.json(
            {
                success: false,
                error: `Missing required environment variables: ${envCheck.missing.join(', ')}`,
            },
            500,
        )
    }

    // Validate pool configuration
    const poolCheck = validatePoolConfig(c.env)

    if (!poolCheck.valid) {
        logger.error({ errors: poolCheck.errors }, 'invalid pool configuration')

        return c.json(
            {
                success: false,
                error: `Invalid pool configuration: ${poolCheck.errors.join(', ')}`,
            },
            500,
        )
    }

    await next()
})

// Shared HTTP authentication for protected JSON-RPC methods (enabled providers: Privy, OIDC, ERC-8128).
app.use(
    '*',
    authMiddleware({ providers: [...identityAuthProviders(), createErc8128Provider()] }),
)

// ============================================================================
// Routes
// ============================================================================

/**
 * JSON-RPC 2.0 Endpoint
 *
 * POST /
 * All JSON-RPC methods are dispatched through this single endpoint.
 */
app.post('/', async (c) => {
    try {
        const body = await c.req.json()
        const methods = createMethods(c.env)

        const ctx: RpcContext = {
            env: c.env,
            request: c.req.raw,
            auth: getRpcCaller(c.req.raw),
        }

        const response = await dispatch(body, methods, ctx)

        // Notifications return null - no response needed
        if (response === null) {
            return c.body(null, 204)
        }

        // Empty batch response (all notifications)
        if (Array.isArray(response) && response.length === 0) {
            return c.body(null, 204)
        }

        return c.json(redactRpcResponse(response, c.env))
    } catch (error) {
        // JSON parse error
        logger.error(errorDetails(error as Error), 'JSON-RPC parse error')

        return c.json(
            {
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32700,
                    message: 'Parse error',
                },
            },
            200, // JSON-RPC errors return 200 OK with error in body
        )
    }
})

/**
 * Health check endpoint (simple probe)
 *
 * Returns { status: "ok" } if the service is running.
 * For detailed status, use the JSON-RPC `wallet_health` or `wallet_getCapabilities` methods.
 */
app.get('/health', async (c) => {
    return c.json({ status: 'ok' })
})

// ============================================================================
// Error Handling
// ============================================================================

app.onError((err, c) => {
    logger.error(
        {
            errorName: err.name,
            errorMessage: redactSecrets(err.message, c.env),
            errorStack: err.stack && redactSecrets(err.stack, c.env),
        },
        'unhandled worker error',
    )

    const message = err.message ? redactSecrets(err.message, c.env) : 'Internal server error'

    return c.json({ success: false, error: message }, 500)
})

app.notFound((c) => {
    return c.json({ success: false, error: 'Not found' }, 404)
})

// ============================================================================
// Queue Consumer - Transaction Monitoring
// ============================================================================

/**
 * Process queue jobs (monitor, fulfillment, settlement, refund)
 */
async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
        const job = msg.body

        try {
            const jobType = resolveQueueJobType(job)

            switch (jobType) {
                case 'monitor':
                    // SAFETY: resolveQueueJobType only checks that the body is a non-null object whose type is absent or "monitor"; it does not check MonitorJob fields. Message id/timestamp/attempts/ack/retry are already on msg.
                    await handleMonitorJob(msg as Message<MonitorJob>, env)
                    break
                default:
                    logger.warn({ job, attempts: msg.attempts }, 'queue invalid job payload')
                    msg.ack()
            }
        } catch (error) {
            logger.error(
                { job, attempts: msg.attempts, error: getErrorMessage(error) },
                'queue processing error',
            )
            msg.retry({ delaySeconds: 30 })
        }
    }
}

function resolveQueueJobType(job: unknown): 'monitor' | 'unknown' {
    if (!job || typeof job !== 'object') return 'unknown'

    if (!('type' in job)) return 'monitor'

    return job.type === 'monitor' ? 'monitor' : 'unknown'
}

function getMonitorAttempt(msg: Message<MonitorJob>): number {
    // Message.attempts is managed by Cloudflare Queues and increments across retries.
    // Fall back to the legacy body field for backward compatibility with old payloads.
    return msg.attempts ?? msg.body.attempt ?? 0
}

async function notifySignerFinalization(
    env: Env,
    signerName: string,
    txId: string,
    txHash: Hex,
    status: 'confirmed' | 'failed',
): Promise<boolean> {
    try {
        const signerId = env.SIGNER.idFromName(signerName)
        const signer = env.SIGNER.get(signerId)

        const response = await signer.fetch(`http://do/finalized?signerName=${signerName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txId, txHash, status }),
        })

        return response.ok
    } catch {
        return false
    }
}

async function finalizeMonitorAsFailed(
    msg: Message<MonitorJob>,
    env: Env,
    reason: string,
): Promise<boolean> {
    const { txId, txHash, signerName } = msg.body
    const finalized = await notifySignerFinalization(env, signerName, txId, txHash, 'failed')

    if (finalized) {
        logger.error(
            { txId, txHash, signerName, attempts: getMonitorAttempt(msg), reason },
            'monitor job finalized as failed',
        )

        return true
    }

    logger.error(
        { txId, txHash, signerName, attempts: getMonitorAttempt(msg), reason },
        'failed to finalize monitor job as failed',
    )

    return false
}

/**
 * Handle transaction monitoring job
 */
async function handleMonitorJob(msg: Message<MonitorJob>, env: Env): Promise<void> {
    const { txId, txHash, signerName } = msg.body
    const attempt = getMonitorAttempt(msg)
    const fallbackChainIds = getChainIds(env)

    const chainId =
        msg.body.chainId ?? (fallbackChainIds.length === 1 ? fallbackChainIds[0] : undefined)

    if (!chainId) {
        logger.error({ txId, txHash, signerName }, 'monitor job missing chainId')
        msg.ack()

        return
    }

    // Check transaction receipt
    const receipt = await getTransactionReceipt(getChainRpcUrl(chainId, env), txHash)

    if (receipt) {
        await logBundleGasTelemetry(env, txId, chainId, txHash, receipt.gasUsed)

        const finalStatus = receipt.status === '0x1' ? 'confirmed' : 'failed'
        const finalized = await notifySignerFinalization(env, signerName, txId, txHash, finalStatus)

        if (!finalized) {
            msg.retry({ delaySeconds: 30 })
            logger.error(
                { txId, txHash, signerName, attempt },
                'failed to notify signer finalization, retrying',
            )

            return
        }

        msg.ack()
        logger.info({ txId, txHash, status: finalStatus }, 'transaction finalized')
    } else {
        if (attempt >= MAX_MONITOR_ATTEMPTS) {
            const finalized = await finalizeMonitorAsFailed(
                msg,
                env,
                'monitor retries exhausted without receipt',
            )

            if (finalized) {
                msg.ack()
            } else {
                msg.retry({ delaySeconds: 30 })
            }

            return
        }

        // Not yet confirmed - retry with exponential backoff
        const delaySeconds = Math.min(Math.pow(2, attempt), 60)
        msg.retry({ delaySeconds })
        logger.debug({ txId, txHash, attempt, delaySeconds }, 'transaction pending, retrying')
    }
}

async function logBundleGasTelemetry(
    env: Env,
    txId: string,
    chainId: number,
    txHash: Hex,
    actualGasUsedHex?: string,
): Promise<void> {
    if (!env.BUNDLE_STATUS_DO || !actualGasUsedHex) return

    try {
        const bundleStatusId = env.BUNDLE_STATUS_DO.idFromName(`bundle-status-${chainId}`)
        const bundleStatus = env.BUNDLE_STATUS_DO.get(bundleStatusId)

        const bundleLookupResponse = await bundleStatus.fetch(
            `http://do/get_bundle_id_by_tx?txId=${encodeURIComponent(txId)}`,
        )

        if (!bundleLookupResponse.ok) return
        const bundleLookup = (await bundleLookupResponse.json()) as { bundleId: string | null }

        if (!bundleLookup.bundleId) return

        const telemetryResponse = await bundleStatus.fetch(
            `http://do/get_bundle_telemetry?bundleId=${encodeURIComponent(bundleLookup.bundleId)}`,
        )

        if (!telemetryResponse.ok) return

        const telemetry = (await telemetryResponse.json()) as {
            simulationGas?: string
            combinedGas?: string
            txGas?: string
            paymentEnabled?: boolean
        } | null

        if (!telemetry) return

        const actualGasUsed = BigInt(actualGasUsedHex)
        const simulationGas = telemetry.simulationGas ? BigInt(telemetry.simulationGas) : undefined
        const combinedGas = telemetry.combinedGas ? BigInt(telemetry.combinedGas) : undefined
        const estimatedTxGas = telemetry.txGas ? BigInt(telemetry.txGas) : undefined

        logger.info(
            {
                bundleId: bundleLookup.bundleId,
                txId,
                txHash,
                chainId,
                paymentEnabled: telemetry.paymentEnabled ?? false,
                simulationGas: simulationGas?.toString(),
                combinedGas: combinedGas?.toString(),
                estimatedTxGas: estimatedTxGas?.toString(),
                actualGasUsed: actualGasUsed.toString(),
                simulationDelta:
                    simulationGas !== undefined
                        ? (actualGasUsed - simulationGas).toString()
                        : undefined,
                combinedDelta:
                    combinedGas !== undefined
                        ? (actualGasUsed - combinedGas).toString()
                        : undefined,
                txEstimateDelta:
                    estimatedTxGas !== undefined
                        ? (actualGasUsed - estimatedTxGas).toString()
                        : undefined,
            },
            'bundle gas telemetry',
        )
    } catch (error) {
        logger.debug(
            { txId, chainId, error: getErrorMessage(error) },
            'bundle telemetry lookup failed',
        )
    }
}

/**
 * Fetch transaction receipt from RPC with full details
 */
async function getTransactionReceipt(
    rpcUrl: string,
    txHash: Hex,
): Promise<{
    status: string
    blockNumber?: string
    gasUsed?: string
    blockHash?: string
    logs?: unknown[]
} | null> {
    const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_getTransactionReceipt',
            params: [txHash],
            id: 1,
        }),
    })

    const data = (await response.json()) as {
        result: {
            status: string
            blockNumber?: string
            gasUsed?: string
            blockHash?: string
            logs?: unknown[]
        } | null
    }

    return data.result
}

// ============================================================================
// Scheduled Handler - Cron Maintenance
// ============================================================================

/**
 * Get the SignerPoolDO stub for maintenance operations
 */
function getSignerPool(env: Env, chainId: number): DurableObjectStub {
    const poolId = env.SIGNER_POOL.idFromName(`pool-${chainId}`)

    return env.SIGNER_POOL.get(poolId)
}

/**
 * Run maintenance on all signers via cron
 */
async function handleScheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    logger.info('Running scheduled maintenance')

    const chainIds = getChainIds(env)

    for (const chainId of chainIds) {
        // Run signer pool maintenance
        const pool = getSignerPool(env, chainId)

        const response = await pool.fetch(`http://do/maintenance?poolName=pool-${chainId}`, {
            method: 'POST',
        })

        if (!response.ok) {
            logger.error({ chainId }, 'Scheduled signer maintenance failed')
        } else {
            const result = await response.json()
            logger.info({ chainId, result }, 'Signer maintenance completed')
        }

        await requestPaidUpgradeReconcile(env, chainId)
    }
}

// ============================================================================
// Export
// ============================================================================

export default {
    fetch: app.fetch,
    queue: handleQueue,
    scheduled: handleScheduled,
}
