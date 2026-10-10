import type { Hex } from 'viem'
import { zeroAddress, createPublicClient, http } from 'viem'
import { hashTypedData } from 'viem/utils'
import type { RpcContext } from '../types'
import type { Env } from '../../types/env'
import { getFeeConfig, getGasConfig, getPriceOracleConfig } from '../../types/env'
import { convertToFeeToken } from '../../services/fees'
import { toHexChainId } from '../../lib/viem-utils'
import {
    RpcError,
    INVALID_PARAMS,
    SERVICE_UNAVAILABLE,
    INTERNAL_ERROR,
    DRAFT_CONFLICT,
    SIMULATION_FAILED,
} from '../errors'
import { getChainIds } from '../../config'
import { getChainConfig as getChainAssetsConfig } from '../../config/chains'
import { logger } from '../../lib/logger'
import { formatPriceForQuote } from '../../services/price-oracle'
import { isPaymentEnabled } from '../../services/relayer'
import { rpcHandlerIo } from '../handler-io'
import { isLocalDevContext, quoteSigningSecret } from '../../config/runtime-context'
import { isOnChainAccountKey } from '../../auth/erc8128/account-key'
import { sessionAddressFromEncodedKey } from '../../lib/session-address'
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
import {
    assertPaidUpgrade,
    assertPaidUpgradeEnabled,
    assertPaidUpgradeOidcOwner,
    assertPaidUpgradeRateCapacity,
    requirePaidUpgradeClientIp,
    chainUsdcAddress,
    clampPaidUpgradePaymentMax,
    encodeSignedPreCall,
    paidUpgradeMaxPayment,
    paidUpgradeSignedGas,
    recordPaidUpgradeRateLimit,
} from './shared/paid-upgrade'

/**
 * wallet_prepareCalls - Prepare calls for signing.
 */
export async function handlePrepareCalls(
    params: unknown,
    ctx: RpcContext,
): Promise<PrepareCallsResult> {
    const env = ctx.env as Env
    const io = rpcHandlerIo(ctx)
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

    const config = io.getChainConfig(env, requestedChainId)
    const hexChainId = toHexChainId(config.chainId)

    const intentNonceProvider = io.createIntentNonceProvider(
        env.INTENT_NONCE_MANAGER,
        requestedChainId,
    )

    const gasConfig = getGasConfig(env)
    const relayerService = io.createRelayerService(config, logger, intentNonceProvider, gasConfig)

    const meta = typedParams.capabilities?.meta
    const nonce = meta?.nonce
    const seqKey = meta?.seq_key
    const prepareKey = meta?.prepare_key
    const expiry = meta?.expiry
    const payer = meta?.fee_payer
    const paymentToken = meta?.fee_token
    let paymentMaxAmount = meta?.fee_max_amount
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

    const requestedUpgrade = typedParams.capabilities?.accountUpgrade

    if (requestedUpgrade) {
        assertPaidUpgradeEnabled(env)
        assertPaidUpgradeOidcOwner(typedParams.from)
    }

    const paidUpgradeIp = requestedUpgrade
        ? requirePaidUpgradeClientIp(ctx.request, env)
        : 'unknown'

    let upgradePreCallEncoding: Hex[] | undefined

    if (requestedUpgrade) {
        await assertPaidUpgradeRateCapacity(env, config.chainId, typedParams.from, paidUpgradeIp)

        // Encode before simulation so the digest and the gas estimate include the pre-call.
        // Signature, delegation, fee, and balance are checked again once the fee is known.
        try {
            upgradePreCallEncoding = [encodeSignedPreCall(requestedUpgrade.preCall)]
        } catch (error) {
            if (error instanceof RpcError) throw error
            throw new RpcError(INVALID_PARAMS, 'Invalid authorization nonce')
        }
    }

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
        encodedPreCalls: upgradePreCallEncoding,
        paidUpgradeDelegation: requestedUpgrade
            ? config.contracts.accountProxy
            : undefined,
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

    if (requestedUpgrade) {
        try {
            paidUpgradeSignedGas(txGas)
        } catch {
            throw new RpcError(INVALID_PARAMS, 'Paid upgrade gas limit exceeds the reserved hold')
        }
    }

    let feeEstimate

    try {
        feeEstimate = await io.getFeeEstimate(publicClient, txGas, feeConfig)
    } catch (error) {
        logger.warn({ error }, 'Fee estimation failed')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Fee estimation failed')
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

    const nativeUsdPrice = await io.getUsdPrice(nativeAssetUid, priceConfig)

    if (!nativeUsdPrice) {
        throw new RpcError(
            SERVICE_UNAVAILABLE,
            `Price unavailable for native asset: ${nativeAssetUid}`,
        )
    }

    const ethPriceHex = formatPriceForQuote(nativeUsdPrice)
    // A zero-payer intent is not charged. The native gas estimate stays in
    // nativeFeeEstimate; paymentAmount is only the fee the quote will pull.
    const paymentEnabled = isPaymentEnabled(payer ?? zeroAddress, paymentToken ?? zeroAddress)
    let paymentAmount = paymentEnabled ? feeEstimate.paymentAmount : 0n
    let paymentTokenDecimals = 18
    // 1e18 means "1 fee token per 1 native token", so convertToFeeToken is the identity for native fees.
    let nativeRate = 10n ** 18n

    if (paymentEnabled && paymentToken && paymentToken !== zeroAddress) {
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
        const tokenUsdPrice = await io.getUsdPrice(assetUid, priceConfig)

        if (!tokenUsdPrice) {
            throw new RpcError(
                SERVICE_UNAVAILABLE,
                `Price unavailable for payment token: ${assetUid}`,
            )
        }

        nativeRate = (nativeUsdPrice * 10n ** 18n + tokenUsdPrice / 2n) / tokenUsdPrice
        paymentAmount = convertToFeeToken(paymentAmount, nativeRate, paymentTokenDecimals)
    }

    // A failed or zero fee must not be HMAC-signed. Outside local that quote would
    // otherwise be collected as 0 for QUOTE_TTL_SECONDS. Local may still quote 0.
    if (paymentAmount === 0n && !isLocalDevContext(env)) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Refusing to sign a zero fee quote')
    }

    const claimedSession = sessionAddressFromEncodedKey(typedParams.session_key)
    let authSigner = typedParams.from

    if (claimedSession && claimedSession.toLowerCase() !== typedParams.from.toLowerCase()) {
        const onChain = await isOnChainAccountKey(
            publicClient,
            typedParams.from,
            claimedSession,
            Math.floor(Date.now() / 1000),
        )

        if (onChain) authSigner = claimedSession
    }

    let accountUpgrade: Quote['accountUpgrade']

    if (requestedUpgrade) {
        if (paymentAmount <= 0n) {
            throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee must be greater than zero')
        }

        let clientMax: bigint | undefined

        if (paymentMaxAmount !== undefined && paymentMaxAmount !== '') {
            try {
                clientMax = BigInt(paymentMaxAmount)
            } catch {
                throw new RpcError(INVALID_PARAMS, 'Paid upgrade paymentMaxAmount is required')
            }
        }

        const clamped = clampPaidUpgradePaymentMax({
            paymentAmount,
            clientMax,
            ceiling: paidUpgradeMaxPayment(env),
        })

        paymentMaxAmount = clamped.toString()
        result.typedData.message = {
            ...result.typedData.message,
            paymentMaxAmount: clamped,
        }
        result.digest = hashTypedData({
            domain: result.typedData.domain,
            types: result.typedData.types,
            primaryType: 'Intent',
            message: result.typedData.message,
        })

        const checked = await assertPaidUpgrade({
            eoa: typedParams.from,
            payer,
            paymentToken,
            paymentMaxAmount,
            upgrade: requestedUpgrade,
            encodedPreCalls: upgradePreCallEncoding,
            chainId: config.chainId,
            orchestrator: config.contracts.orchestrator,
            accountProxy: config.contracts.accountProxy,
            usdc: chainUsdcAddress(config.chainId),
            maxPayment: paidUpgradeMaxPayment(env),
            paymentAmount,
            publicClient,
        })

        accountUpgrade = checked.quote
        upgradePreCallEncoding = checked.encodedPreCalls
    }

    const quoteIntent: QuoteIntent = {
        eoa: typedParams.from,
        calls: normalizedCalls,
        nonce: result.nonce!,
        combinedGas: result.combinedGas!,
        expiry: result.expiry!,
        encodedPreCalls: upgradePreCallEncoding,
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
        nativeRate: nativeRate.toString(),
        authSigner,
        orchestrator: config.contracts.orchestrator,
        feeTokenDeficit: '0x0',
        assetDeficits: [],
        telemetry: {
            simulationGas: result.simulationGas,
            combinedGas: result.combinedGas,
            txGas: result.txGas,
            paymentEnabled,
        },
        accountUpgrade,
    }

    const ttl = Math.floor(Date.now() / 1000) + feeConfig.quoteTtlSeconds

    const signedQuotes: SignedQuotes = {
        quotes: [quote],
        signature: '0x',
        ttl,
    }

    const quoteSecret = quoteSigningSecret(env)

    if (!quoteSecret) {
        if (!isLocalDevContext(env)) {
            throw new RpcError(
                SERVICE_UNAVAILABLE,
                'QUOTE_SIGNING_SECRET is required outside local',
            )
        }
    } else {
        signedQuotes.signature = await signQuotes(signedQuotes, quoteSecret)
    }

    if (requestedUpgrade) {
        await recordPaidUpgradeRateLimit(env, config.chainId, typedParams.from, paidUpgradeIp)
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

    const source = result.typedData.message

    const message = {
        multichain: source.multichain,
        eoa: source.eoa,
        calls: source.calls.map((c) => ({
            to: c.to,
            value: c.value.toString(),
            data: c.data,
        })),
        nonce: source.nonce.toString(),
        payer: source.payer,
        paymentToken: source.paymentToken,
        paymentMaxAmount: source.paymentMaxAmount.toString(),
        combinedGas: source.combinedGas.toString(),
        encodedPreCalls: source.encodedPreCalls,
        encodedFundTransfers: source.encodedFundTransfers,
        settler: source.settler,
        expiry: source.expiry.toString(),
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
