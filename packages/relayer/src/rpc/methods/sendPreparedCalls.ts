import { createPublicClient, http, type Address, type SignedAuthorization } from 'viem'
import type { RpcContext } from '../types'
import type { Env } from '../../types/env'
import type {
    IntentStruct,
    SendResult,
    ExecuteIntentTransaction,
    BatchExecuteIntentTransaction,
} from '../../types/pool'
import { getChainConfig, getChainIds } from '../../config'
import { logger, getErrorMessage } from '../../lib/logger'
import { unwrapParams } from '../../lib/rpc-utils'
import { createIntentNonceProvider } from '../../services/relayer'
import {
    RpcError,
    INVALID_PARAMS,
    INVALID_SIGNATURE,
    INSUFFICIENT_FUNDS,
    CONTRACT_ERROR,
    SERVICE_UNAVAILABLE,
    INTERNAL_ERROR,
    INTENT_EXPIRED,
} from '../errors'
import type { SendPreparedCallsParams, SendPreparedCallsResult } from '../schema/sendPreparedCalls'
import type { PaidUpgradeQuote, Quote } from '../schema/prepareCalls'
import {
    getChainIdFromContext,
    getSignerName,
    hashQuotes,
    validateQuote,
    buildIntentFromParams,
    assertErc8128BoundToQuotes,
} from './shared/calls-helpers'
import { getSignerPool } from './shared/signer-pool'
import {
    assertPaidUpgrade,
    assertPaidUpgradeIntentSigner,
    assertPaidUpgradeSimulation,
    chainUsdcAddress,
    enqueuePaidUpgradeReceipt,
    paidUpgradeFieldsMatch,
    paidUpgradeFromQuote,
    paidUpgradeMaxPayment,
    paidUpgradeReceiptOutcome,
    paidUpgradeReceiptWaitMs,
    releasePaidUpgradeGas,
    releasePaidUpgradeRateLimit,
    requirePaidUpgradeClientIp,
    reservePaidUpgradeGas,
    reservePaidUpgradeRateLimit,
    settlePaidUpgradeGas,
} from './shared/paid-upgrade'

export type { SendPreparedCallsParams, SendPreparedCallsResult } from '../schema/sendPreparedCalls'
export type { SignedQuotes, Quote, QuoteIntent } from '../schema/prepareCalls'
export { getSignerName, hashQuotes, buildIntentFromParams }

/**
 * A broadcast that already started is never a definitive pre-send expiry,
 * even when the node text contains "Intent expired". Expiry is the signer's
 * INTENT_EXPIRED code only when broadcastAttempted is not true.
 */
function rpcCodeForPoolSendFailure(error: {
    code?: string
    broadcastAttempted?: boolean
}): number {
    if (error.broadcastAttempted === true) return SERVICE_UNAVAILABLE
    if (error.code === 'INTENT_EXPIRED') return INTENT_EXPIRED
    return SERVICE_UNAVAILABLE
}

function getSeqKeyForDraftMark(
    intentNonce: string | bigint,
    seqKeyFromContext?: string,
): bigint | null {
    try {
        if (seqKeyFromContext) {
            return BigInt(seqKeyFromContext)
        }
        return BigInt(intentNonce) >> 64n
    } catch {
        return null
    }
}

function buildBundleTrackingUnavailableError(bundleId: string): RpcError {
    return new RpcError(
        SERVICE_UNAVAILABLE,
        'Intent submitted but bundle tracking unavailable; retry status lookup later',
        { bundleId },
    )
}

function echoedUpgradeMatches(
    echo: Partial<PaidUpgradeQuote> | undefined,
    quoted: PaidUpgradeQuote,
): boolean {
    if (!echo?.authorization || !echo.preCall) return false
    const authorization = echo.authorization
    const preCall = echo.preCall
    if (
        !authorization.contractAddress ||
        !Number.isInteger(authorization.chainId) ||
        !Number.isInteger(authorization.nonce) ||
        !authorization.signature ||
        !preCall.eoa ||
        !preCall.executionData ||
        preCall.nonce === undefined ||
        !preCall.signature
    ) {
        return false
    }
    return paidUpgradeFieldsMatch(
        { authorization, preCall },
        quoted,
    )
}

/**
 * Re-check a quoted user-paid upgrade and reserve its per-address slot.
 * The authorization on the execute-intent transaction comes from the HMAC'd
 * quote. A side-field echo has to match that quote or send refuses.
 */
async function bindPaidUpgrade(args: {
    env: Env
    params: SendPreparedCallsParams
    intent: IntentStruct
    chainId: number
    ip: string
    config: { rpcUrl: string; contracts: { orchestrator: Address; accountProxy: Address } }
    quote: Quote
}): Promise<{ reservedAt: number; authorization: SignedAuthorization } | undefined> {
    const upgrade = paidUpgradeFromQuote(args.quote)
    if (!upgrade) return undefined

    if (
        args.params.accountUpgrade !== undefined &&
        !echoedUpgradeMatches(args.params.accountUpgrade, upgrade)
    ) {
        throw new RpcError(INVALID_PARAMS, 'Authorization or pre-call does not match the quote')
    }

    let paymentAmount: bigint
    try {
        paymentAmount = BigInt(args.intent.paymentAmount ?? '0')
    } catch {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee must be greater than zero')
    }

    const publicClient = createPublicClient({ transport: http(args.config.rpcUrl) })
    const checked = await assertPaidUpgrade({
        eoa: args.intent.eoa,
        payer: args.intent.payer,
        paymentToken: args.intent.paymentToken,
        paymentMaxAmount:
            args.intent.paymentMaxAmount === undefined
                ? undefined
                : String(args.intent.paymentMaxAmount),
        upgrade,
        encodedPreCalls: args.intent.encodedPreCalls,
        chainId: args.chainId,
        orchestrator: args.config.contracts.orchestrator,
        accountProxy: args.config.contracts.accountProxy,
        usdc: chainUsdcAddress(args.chainId),
        maxPayment: paidUpgradeMaxPayment(args.env),
        paymentAmount,
        publicClient,
    })

    await assertPaidUpgradeIntentSigner({
        intent: args.intent,
        chainId: args.chainId,
        orchestrator: args.config.contracts.orchestrator,
    })

    const reservedAt = await reservePaidUpgradeRateLimit(
        args.env,
        args.chainId,
        args.intent.eoa,
        args.ip,
    )
    try {
        await assertPaidUpgradeSimulation({
            publicClient,
            orchestrator: args.config.contracts.orchestrator,
            intent: args.intent,
            authorization: checked.authorization,
            feeRecipient: args.env.FEE_RECIPIENT,
            env: args.env,
        })
        await reservePaidUpgradeGas(args.env, args.chainId)
    } catch (error) {
        const stored =
            error instanceof RpcError &&
            (error.code === INVALID_SIGNATURE ||
                error.code === INSUFFICIENT_FUNDS ||
                error.code === CONTRACT_ERROR)
        if (!stored) {
            await releasePaidUpgradeRateLimit(
                args.env,
                args.chainId,
                args.intent.eoa,
                args.ip,
                reservedAt,
            )
        }
        throw error
    }
    return { reservedAt, authorization: checked.authorization }
}

/**
 * wallet_sendPreparedCalls - Submit signed calls for execution.
 */
export async function handleSendPreparedCalls(
    params: unknown,
    ctx: RpcContext,
): Promise<SendPreparedCallsResult> {
    const env = ctx.env as Env
    const typedParams = unwrapParams<SendPreparedCallsParams>(params)

    if (!typedParams?.context) {
        throw new RpcError(INVALID_PARAMS, 'Missing required parameter: context')
    }
    if (!typedParams?.signature) {
        throw new RpcError(INVALID_PARAMS, 'Missing required parameter: signature')
    }

    const { context } = typedParams

    if ('quote' in context && context.quote) {
        const quoteError = await validateQuote(context.quote, env)
        if (quoteError) throw quoteError
        const callerError = await assertErc8128BoundToQuotes(env, ctx.auth, context.quote.quotes)
        if (callerError) throw callerError
    }

    const chainId = getChainIdFromContext(context)
    const supportedChainIds = getChainIds(env)
    if (supportedChainIds.length > 0 && !supportedChainIds.includes(chainId)) {
        throw new RpcError(INVALID_PARAMS, `Unsupported chain ID: ${chainId}`)
    }
    const config = getChainConfig(env, chainId)

    let bundleId: string
    if ('quote' in context && context.quote) {
        bundleId = hashQuotes(context.quote, config)
    } else {
        bundleId = crypto.randomUUID()
    }

    const intent = buildIntentFromParams(typedParams)

    const tx: ExecuteIntentTransaction = {
        id: bundleId,
        type: 'execute-intent',
        intent,
    }

    const quoted = 'quote' in context && context.quote ? context.quote.quotes[0] : undefined
    const paidUpgradeIp =
        quoted && paidUpgradeFromQuote(quoted)
            ? requirePaidUpgradeClientIp(ctx.request, env)
            : 'unknown'
    const paidUpgrade = quoted
        ? await bindPaidUpgrade({
              env,
              params: typedParams,
              intent,
              chainId,
              ip: paidUpgradeIp,
              config,
              quote: quoted,
          })
        : undefined
    if (paidUpgrade) {
        tx.authorization = paidUpgrade.authorization
    }

    const pool = getSignerPool(env, chainId)
    let response: Response
    try {
        response = await pool.fetch(`http://do/send?poolName=pool-${chainId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tx),
        })
    } catch (error) {
        if (paidUpgrade) {
            await releasePaidUpgradeRateLimit(
                env,
                chainId,
                intent.eoa,
                paidUpgradeIp,
                paidUpgrade.reservedAt,
            )
            await releasePaidUpgradeGas(env, chainId)
            logger.error({ error, eoa: intent.eoa }, 'paid upgrade pool unavailable')
            throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
        }
        throw error
    }

    if (!response.ok) {
        const error = (await response.json()) as {
            error: string
            code?: string
            broadcastAttempted?: boolean
        }
        if (paidUpgrade && error.broadcastAttempted === false) {
            await releasePaidUpgradeRateLimit(
                env,
                chainId,
                intent.eoa,
                paidUpgradeIp,
                paidUpgrade.reservedAt,
            )
            await releasePaidUpgradeGas(env, chainId)
        }
        logger.warn({ eoa: intent.eoa, error: error.error }, 'intent execution failed')

        throw new RpcError(rpcCodeForPoolSendFailure(error), error.error)
    }

    const result = (await response.json()) as SendResult
    if (paidUpgrade) {
        try {
            const receiptClient = createPublicClient({ transport: http(config.rpcUrl) })
            const receipt = await receiptClient.waitForTransactionReceipt({
                hash: result.txHash,
                timeout: paidUpgradeReceiptWaitMs(env),
            })
            const outcome = paidUpgradeReceiptOutcome(receipt)
            if (outcome.failure) {
                logger.warn(
                    {
                        eoa: intent.eoa,
                        txHash: result.txHash,
                        errorName: outcome.errorName,
                        selector: outcome.selector,
                        gasUsed: outcome.gasUsed.toString(),
                    },
                    'paid upgrade receipt stored an intent error',
                )
            }
            await settlePaidUpgradeGas(env, chainId, {
                gasUsed: outcome.gasUsed,
                failure: outcome.failure,
                txHash: result.txHash,
            })
        } catch (error) {
            logger.error(
                { error, eoa: intent.eoa, txHash: result.txHash },
                'paid upgrade receipt was not settled; gas hold remains until reconcile',
            )
            try {
                await enqueuePaidUpgradeReceipt(env, chainId, result.txHash, {
                    nonce: result.nonce,
                    signerName: result.signerName,
                })
            } catch (enqueueError) {
                logger.error(
                    { error: enqueueError, eoa: intent.eoa, txHash: result.txHash },
                    'paid upgrade receipt was not queued for reconcile',
                )
            }
        }
    }
    logger.info(
        { eoa: intent.eoa, txHash: result.txHash, signer: result.signer, bundleId },
        'intent submitted successfully',
    )

    if ('quote' in context && context.draft?.id) {
        const seqKey = getSeqKeyForDraftMark(intent.nonce, context.draft.seqKey)
        if (seqKey !== null) {
            const intentNonceProvider = createIntentNonceProvider(env.INTENT_NONCE_MANAGER, chainId)
            try {
                const draftStatus = await intentNonceProvider.markSubmitted(
                    intent.eoa,
                    seqKey,
                    context.draft.id,
                )
                logger.debug(
                    { eoa: intent.eoa, bundleId, draftId: context.draft.id, draftStatus },
                    'intent draft submit transition applied',
                )
            } catch (error) {
                logger.warn(
                    {
                        eoa: intent.eoa,
                        bundleId,
                        draftId: context.draft.id,
                        error: getErrorMessage(error),
                    },
                    'intent submitted but failed to finalize draft state; reconciliation required',
                )
            }
        } else {
            logger.warn(
                { eoa: intent.eoa, bundleId, draftId: context.draft.id },
                'intent submitted but skipped draft finalization due to invalid seqKey',
            )
        }
    }

    if (env.BUNDLE_STATUS_DO) {
        try {
            const bundleStatusId = env.BUNDLE_STATUS_DO.idFromName(`bundle-status-${chainId}`)
            const bundleStatus = env.BUNDLE_STATUS_DO.get(bundleStatusId)

            const addBundleResponse = await bundleStatus.fetch('http://do/add_bundle_tx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    bundleId,
                    txId: tx.id,
                    signerName: result.signerName,
                }),
            })
            if (!addBundleResponse.ok) {
                logger.error(
                    {
                        category: 'bundle_tracking_persist_failed',
                        bundleId,
                        chainId,
                        txId: tx.id,
                        signerName: result.signerName,
                        status: addBundleResponse.status,
                        statusText: addBundleResponse.statusText,
                    },
                    'bundle tracking persistence failed',
                )
                throw buildBundleTrackingUnavailableError(bundleId)
            }

            if ('quote' in context && context.quote?.quotes?.length) {
                const quote = context.quote.quotes[0]
                const telemetry = quote?.telemetry
                if (telemetry?.combinedGas || telemetry?.simulationGas || telemetry?.txGas) {
                    try {
                        const telemetryResponse = await bundleStatus.fetch(
                            'http://do/upsert_bundle_telemetry',
                            {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    bundleId,
                                    chainId,
                                    eoa: intent.eoa.toLowerCase(),
                                    paymentEnabled: telemetry.paymentEnabled ?? false,
                                    simulationGas: telemetry.simulationGas,
                                    combinedGas: telemetry.combinedGas,
                                    txGas: telemetry.txGas,
                                }),
                            },
                        )
                        if (!telemetryResponse.ok) {
                            logger.warn(
                                {
                                    category: 'bundle_telemetry_persist_failed',
                                    bundleId,
                                    chainId,
                                    txId: tx.id,
                                    signerName: result.signerName,
                                    status: telemetryResponse.status,
                                    statusText: telemetryResponse.statusText,
                                },
                                'bundle telemetry persistence failed',
                            )
                        }
                    } catch (error) {
                        logger.warn(
                            {
                                category: 'bundle_telemetry_persist_failed',
                                error: getErrorMessage(error),
                                bundleId,
                                chainId,
                                txId: tx.id,
                                signerName: result.signerName,
                            },
                            'failed to persist bundle telemetry',
                        )
                    }
                }
            }
        } catch (error) {
            if (error instanceof RpcError) {
                throw error
            }
            logger.warn(
                {
                    category: 'bundle_tracking_persist_failed',
                    error: getErrorMessage(error),
                    bundleId,
                    chainId,
                    txId: tx.id,
                    signerName: result.signerName,
                },
                'failed to persist bundle tracking',
            )
            throw buildBundleTrackingUnavailableError(bundleId)
        }
    }

    return { id: bundleId }
}

/**
 * Handle batch wallet_sendPreparedCalls optimization.
 */
export async function handleBatchSendPreparedCalls(
    requests: Array<{ id: string | number | null; params: unknown }>,
    ctx: RpcContext,
): Promise<
    Array<{ id: string | number | null; result?: SendPreparedCallsResult; error?: unknown }>
> {
    const env = ctx.env as Env

    const parsedRequests: Array<{
        id: string | number | null
        params: SendPreparedCallsParams
        intent: IntentStruct
        bundleId: string
        chainId: number
        draftId?: string
        draftSeqKey?: bigint
    }> = []
    const validationErrors: Map<string | number | null, RpcError> = new Map()

    for (const req of requests) {
        const typedParams = unwrapParams<SendPreparedCallsParams>(req.params)

        if (!typedParams?.context) {
            validationErrors.set(
                req.id,
                new RpcError(INVALID_PARAMS, 'Missing required parameter: context'),
            )
            continue
        }
        if (!typedParams?.signature) {
            validationErrors.set(
                req.id,
                new RpcError(INVALID_PARAMS, 'Missing required parameter: signature'),
            )
            continue
        }

        if ('quote' in typedParams.context && typedParams.context.quote) {
            const quoteError = await validateQuote(typedParams.context.quote, env)
            if (quoteError) {
                validationErrors.set(req.id, quoteError)
                continue
            }
            const callerError = await assertErc8128BoundToQuotes(
                env,
                ctx.auth,
                typedParams.context.quote.quotes,
            )
            if (callerError) {
                validationErrors.set(req.id, callerError)
                continue
            }
            if (typedParams.context.quote.quotes.some((quote) => quote.accountUpgrade)) {
                validationErrors.set(
                    req.id,
                    new RpcError(INVALID_PARAMS, 'Paid upgrade cannot be batched'),
                )
                continue
            }
        }

        const chainId = getChainIdFromContext(typedParams.context)
        const supportedChainIds = getChainIds(env)
        if (supportedChainIds.length > 0 && !supportedChainIds.includes(chainId)) {
            validationErrors.set(
                req.id,
                new RpcError(INVALID_PARAMS, `Unsupported chain ID: ${chainId}`),
            )
            continue
        }

        const intent = buildIntentFromParams(typedParams)
        const config = getChainConfig(env, chainId)
        const bundleId =
            'quote' in typedParams.context && typedParams.context.quote
                ? hashQuotes(typedParams.context.quote, config)
                : crypto.randomUUID()

        parsedRequests.push({
            id: req.id,
            params: typedParams,
            intent,
            bundleId,
            chainId,
            draftId:
                'quote' in typedParams.context && typedParams.context.draft?.id
                    ? typedParams.context.draft.id
                    : undefined,
            draftSeqKey:
                'quote' in typedParams.context && typedParams.context.draft?.id
                    ? (getSeqKeyForDraftMark(intent.nonce, typedParams.context.draft.seqKey) ??
                      undefined)
                    : undefined,
        })
    }

    if (parsedRequests.length === 0) {
        return requests.map((r) => ({
            id: r.id,
            error: validationErrors.get(r.id) ?? new RpcError(INVALID_PARAMS, 'Validation failed'),
        }))
    }

    const distinctChainIds = Array.from(new Set(parsedRequests.map((r) => r.chainId)))
    if (distinctChainIds.length > 1) {
        return requests.map((r) => ({
            id: r.id,
            error: new RpcError(INVALID_PARAMS, 'Mixed chainIds in batch not supported'),
        }))
    }
    const batchChainId = distinctChainIds[0]

    const batchTx: BatchExecuteIntentTransaction = {
        id: crypto.randomUUID(),
        type: 'batch-execute-intent',
        intents: parsedRequests.map((r) => r.intent),
    }

    const pool = getSignerPool(env, batchChainId)
    const response = await pool.fetch(`http://do/send?poolName=pool-${batchChainId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchTx),
    })

    if (!response.ok) {
        const error = (await response.json()) as {
            error: string
            code?: string
            broadcastAttempted?: boolean
        }
        logger.warn(
            { count: parsedRequests.length, error: error.error },
            'batch intent execution failed',
        )

        const errorCode = rpcCodeForPoolSendFailure(error)

        return requests.map((req) => {
            const validationError = validationErrors.get(req.id)
            if (validationError) {
                return { id: req.id, error: validationError }
            }
            return { id: req.id, error: new RpcError(errorCode, error.error) }
        })
    }

    const result = (await response.json()) as SendResult
    logger.info(
        {
            count: parsedRequests.length,
            txHash: result.txHash,
            signer: result.signer,
        },
        'batch intents submitted successfully',
    )

    const intentNonceProvider = createIntentNonceProvider(env.INTENT_NONCE_MANAGER, batchChainId)
    for (const request of parsedRequests) {
        if (!request.draftId || request.draftSeqKey === undefined) {
            continue
        }

        try {
            const draftStatus = await intentNonceProvider.markSubmitted(
                request.intent.eoa,
                request.draftSeqKey,
                request.draftId,
            )
            logger.debug(
                {
                    eoa: request.intent.eoa,
                    bundleId: request.bundleId,
                    draftId: request.draftId,
                    draftStatus,
                },
                'batch intent draft submit transition applied',
            )
        } catch (error) {
            logger.warn(
                {
                    eoa: request.intent.eoa,
                    bundleId: request.bundleId,
                    draftId: request.draftId,
                    error: getErrorMessage(error),
                },
                'batch intent submitted but failed to finalize draft state; reconciliation required',
            )
        }
    }

    const bundleTrackingErrors = new Map<string | number | null, RpcError>()

    if (env.BUNDLE_STATUS_DO) {
        const bundleStatusId = env.BUNDLE_STATUS_DO.idFromName(`bundle-status-${batchChainId}`)
        const bundleStatus = env.BUNDLE_STATUS_DO.get(bundleStatusId)

        for (const req of parsedRequests) {
            try {
                const addBundleResponse = await bundleStatus.fetch('http://do/add_bundle_tx', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        bundleId: req.bundleId,
                        txId: batchTx.id,
                        signerName: result.signerName,
                    }),
                })
                if (!addBundleResponse.ok) {
                    logger.error(
                        {
                            category: 'bundle_tracking_persist_failed',
                            bundleId: req.bundleId,
                            chainId: batchChainId,
                            txId: batchTx.id,
                            signerName: result.signerName,
                            status: addBundleResponse.status,
                            statusText: addBundleResponse.statusText,
                        },
                        'bundle tracking persistence failed for batch request',
                    )
                    bundleTrackingErrors.set(
                        req.id,
                        buildBundleTrackingUnavailableError(req.bundleId),
                    )
                }
            } catch (error) {
                logger.warn(
                    {
                        category: 'bundle_tracking_persist_failed',
                        error: getErrorMessage(error),
                        bundleId: req.bundleId,
                        chainId: batchChainId,
                        txId: batchTx.id,
                        signerName: result.signerName,
                    },
                    'failed to persist bundle tracking for batch request',
                )
                bundleTrackingErrors.set(
                    req.id,
                    buildBundleTrackingUnavailableError(req.bundleId),
                )
            }
        }
    }

    return requests.map((req) => {
        const validationError = validationErrors.get(req.id)
        if (validationError) {
            return { id: req.id, error: validationError }
        }
        const bundleTrackingError = bundleTrackingErrors.get(req.id)
        if (bundleTrackingError) {
            return { id: req.id, error: bundleTrackingError }
        }

        const successResult = parsedRequests.find((r) => r.id === req.id)
        if (successResult) {
            return { id: req.id, result: { id: successResult.bundleId } }
        }

        return { id: req.id, error: new RpcError(INTERNAL_ERROR, 'Unexpected processing error') }
    })
}

/**
 * Check if a batch of requests can be optimized.
 */
export function canOptimizeBatch(requests: Array<{ method: string; params?: unknown }>): boolean {
    if (requests.length <= 1) return false
    return requests.every((r) => r.method === 'wallet_sendPreparedCalls')
}
