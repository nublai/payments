import type { Address, Hex } from 'viem'
import { zeroAddress, createPublicClient, http } from 'viem'
import type { RpcContext } from '../types'
import type { Env } from '../../types/env'
import { getFeeConfig, getGasConfig, getPriceOracleConfig } from '../../types/env'
import { convertToFeeToken, getFeeEstimate } from '../../services/fees'
import { formatPriceForQuote, getUsdPrice } from '../../services/price-oracle'
import { toHexChainId } from '../../lib/viem-utils'
import {
    RpcError,
    INVALID_PARAMS,
    SERVICE_UNAVAILABLE,
    INTERNAL_ERROR,
    DRAFT_CONFLICT,
    SIMULATION_FAILED,
} from '../errors'
import { getChainConfig, getChainIds } from '../../config'
import { getChainConfig as getChainAssetsConfig } from '../../config/chains'
import { logger } from '../../lib/logger'
import { RelayerService, createIntentNonceProvider, isPaymentEnabled } from '../../services/relayer'
import { signQuotes } from '../../lib/quote-signing'
import { unwrapParams, parseHexChainId } from '../../lib/rpc-utils'
import type {
    PrepareCallsParams,
    QuoteIntent,
    Quote,
    SignedQuotes,
    PrepareCallsContext,
    PrepareCallsResult,
} from '../schema/prepareCalls'

/**
 * wallet_prepareCalls - Prepare calls for signing.
 */
export async function handlePrepareCalls(
    params: unknown,
    ctx: RpcContext,
): Promise<PrepareCallsResult> {
    const env = ctx.env as Env
    const typedParams = unwrapParams<PrepareCallsParams>(params)

    if (!typedParams?.from) {
        throw new RpcError(INVALID_PARAMS, 'Missing required parameter: from')
    }
    if (!typedParams?.calls || !Array.isArray(typedParams.calls)) {
        throw new RpcError(INVALID_PARAMS, 'Missing or invalid parameter: calls')
    }
    if (!typedParams?.chain_id) {
        throw new RpcError(INVALID_PARAMS, 'Missing required parameter: chain_id')
    }

    const requestedChainId = parseHexChainId(typedParams.chain_id, 'chain_id')
    const supportedChainIds = getChainIds(env)
    if (supportedChainIds.length > 0 && !supportedChainIds.includes(requestedChainId)) {
        throw new RpcError(INVALID_PARAMS, `Unsupported chain ID: ${requestedChainId}`)
    }

    const config = getChainConfig(env, requestedChainId)
    const hexChainId = toHexChainId(config.chainId)

    const intentNonceProvider = createIntentNonceProvider(
        env.INTENT_NONCE_MANAGER,
        requestedChainId,
    )
    const gasConfig = getGasConfig(env)
    const relayerService = new RelayerService(config, logger, intentNonceProvider, gasConfig)

    const meta = typedParams.capabilities?.meta
    const nonce = meta?.nonce
    const seqKey = meta?.seq_key
    const prepareKey = meta?.prepare_key
    const expiry = meta?.expiry
    const payer = meta?.fee_payer
    const paymentToken = meta?.fee_token
    const paymentMaxAmount = meta?.fee_max_amount
    const settler = meta?.settler
    const settlerContext = meta?.settler_context

    if (settler || settlerContext) {
        logger.info({ settler, settlerContext }, 'prepareCalls received settler params')
    }

    const normalizedCalls = typedParams.calls.map((c) => ({
        to: c.to,
        value: c.value ?? '0x0',
        data: c.data ?? '0x',
    }))

    const result = await relayerService.prepareIntent({
        eoa: typedParams.from,
        calls: normalizedCalls,
        nonce,
        seqKey,
        expiry,
        settler,
        payer,
        paymentToken,
        paymentMaxAmount,
        prepareKey,
        sessionKey: typedParams.session_key,
    })

    if (!result.success || !result.typedData || !result.digest) {
        if (result.conflictDraftId) {
            throw new RpcError(DRAFT_CONFLICT, result.error ?? 'Draft conflict', {
                conflictDraftId: result.conflictDraftId,
            })
        }

        const rawError = result.error ?? 'Failed to prepare calls'
        if (rawError.toLowerCase().startsWith('simulation failed')) {
            const cause = rawError.replace(/^simulation failed:\s*/i, '').trim()
            throw new RpcError(SIMULATION_FAILED, 'Simulation failed', {
                cause: cause.length > 0 ? cause : undefined,
            })
        }

        throw new RpcError(INTERNAL_ERROR, result.error ?? 'Failed to prepare calls')
    }

    const feeConfig = getFeeConfig(env)
    const publicClient = createPublicClient({ transport: http(config.rpcUrl) })

    const txGas = BigInt(result.txGas ?? '100000')
    let feeEstimate
    try {
        feeEstimate = await getFeeEstimate(publicClient, txGas, feeConfig)
    } catch (error) {
        logger.warn({ error }, 'Fee estimation failed, using zero fees')
        feeEstimate = {
            baseFeePerGas: 0n,
            maxPriorityFeePerGas: 0n,
            maxFeePerGas: 0n,
            totalGas: txGas,
            paymentAmount: 0n,
        }
    }

    const priceConfig = getPriceOracleConfig(env)
    const chainAssetsConfig = getChainAssetsConfig(config.chainId)
    if (!chainAssetsConfig) {
        throw new RpcError(SERVICE_UNAVAILABLE, `Missing assets config for chain ${config.chainId}`)
    }

    const nativeAssetUid = Object.entries(chainAssetsConfig.assets).find(
        ([, asset]) => asset.address === zeroAddress,
    )?.[0]
    if (!nativeAssetUid) {
        throw new RpcError(
            SERVICE_UNAVAILABLE,
            `Native fee asset not configured for chain ${config.chainId}`,
        )
    }

    const nativeUsdPrice = await getUsdPrice(nativeAssetUid, priceConfig)
    if (!nativeUsdPrice) {
        throw new RpcError(
            SERVICE_UNAVAILABLE,
            `Price unavailable for native asset: ${nativeAssetUid}`,
        )
    }

    const ethPriceHex = formatPriceForQuote(nativeUsdPrice)
    let paymentAmount = feeEstimate.paymentAmount
    let paymentTokenDecimals = 18

    if (paymentToken && paymentToken !== zeroAddress) {
        const normalizedPaymentToken = paymentToken.toLowerCase()
        const assetEntry = Object.entries(chainAssetsConfig.assets ?? {}).find(
            ([, asset]) => asset.address.toLowerCase() === normalizedPaymentToken,
        )

        if (!assetEntry) {
            throw new RpcError(INVALID_PARAMS, `Unsupported payment token: ${paymentToken}`)
        }

        const [assetUid, assetConfig] = assetEntry
        if (!assetConfig.feeToken) {
            throw new RpcError(
                INVALID_PARAMS,
                `Payment token not enabled for fees: ${paymentToken}`,
            )
        }

        paymentTokenDecimals = assetConfig.decimals
        const tokenUsdPrice = await getUsdPrice(assetUid, priceConfig)
        if (!tokenUsdPrice) {
            throw new RpcError(
                SERVICE_UNAVAILABLE,
                `Price unavailable for payment token: ${assetUid}`,
            )
        }

        const nativeRate = (nativeUsdPrice * 10n ** 18n + tokenUsdPrice / 2n) / tokenUsdPrice
        paymentAmount = convertToFeeToken(paymentAmount, nativeRate, paymentTokenDecimals)
    }

    const quoteIntent: QuoteIntent = {
        eoa: typedParams.from,
        calls: normalizedCalls,
        nonce: result.nonce!,
        combinedGas: result.combinedGas!,
        expiry: result.expiry!,
        payer,
        paymentToken,
        paymentMaxAmount,
        settler,
        settlerContext,
    }

    const quote: Quote = {
        chainId: hexChainId,
        intent: quoteIntent,
        extraPayment: '0x0',
        ethPrice: ethPriceHex,
        paymentTokenDecimals,
        txGas: Number(feeEstimate.totalGas),
        nativeFeeEstimate: {
            maxFeePerGas: Number(feeEstimate.maxFeePerGas),
            maxPriorityFeePerGas: Number(feeEstimate.maxPriorityFeePerGas),
        },
        paymentAmount: paymentAmount.toString(),
        orchestrator: config.contracts.orchestrator,
        feeTokenDeficit: '0x0',
        assetDeficits: [],
        telemetry: {
            simulationGas: result.simulationGas,
            combinedGas: result.combinedGas,
            txGas: result.txGas,
            paymentEnabled: isPaymentEnabled(payer ?? zeroAddress, paymentToken ?? zeroAddress),
        },
    }

    const ttl = Math.floor(Date.now() / 1000) + feeConfig.quoteTtlSeconds
    const signedQuotes: SignedQuotes = {
        quotes: [quote],
        signature: '0x',
        ttl,
    }

    if (env.QUOTE_SIGNING_SECRET) {
        signedQuotes.signature = await signQuotes(signedQuotes, env.QUOTE_SIGNING_SECRET)
    }

    const preparedContext: PrepareCallsContext = {
        quote: signedQuotes,
        draft:
            result.draftId && result.seqKey && typeof result.draftExpiresAtMs === 'number'
                ? {
                      id: result.draftId,
                      seqKey: result.seqKey,
                      expiresAtMs: result.draftExpiresAtMs,
                      fromCache: result.draftFromCache ?? false,
                  }
                : undefined,
    }

    const message: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(result.typedData.message)) {
        if (typeof value === 'bigint') {
            message[key] = value.toString()
        } else if (Array.isArray(value) && key === 'calls') {
            message[key] = (value as Array<{ to: Address; value: bigint; data: Hex }>).map((c) => ({
                to: c.to,
                value: c.value.toString(),
                data: c.data,
            }))
        } else {
            message[key] = value
        }
    }

    return {
        context: preparedContext,
        digest: result.digest,
        typedData: {
            domain: result.typedData.domain,
            types: result.typedData.types,
            primaryType: result.typedData.primaryType,
            message,
        },
        capabilities: {
            feeTotals: {},
            assetDiffs: {},
        },
        signature: signedQuotes.signature,
    }
}
