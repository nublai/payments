import {
    bindPreparedCalls,
    assertOffLocalFeeToken,
    clampPaymentCeiling,
    firstQuotePaymentAmount,
    INTENT_EXPIRY_TTL_SECONDS,
    PreparedCallsBindingError,
    refuseLonePayerOrToken,
    requirePayerAndToken,
    resolveSignedFeeCap,
    wrapSignature,
    type BundleStatusResponse,
    type Call,
    type PrepareCallsResponse,
} from '@nubl/relayer-client'
import type { Address, Hex } from 'viem'
import { estimateCombinedGasCeiling, localCombinedGasCeiling } from './gas-ceiling'
import {
    discloseFeeCap,
    PAID_FEE_CAP,
    resolveIntentPayment,
    type FeeCapDisclosure,
} from './intent-payment'
import type { EnvName } from './network-config'
import { resolveOrchestratorAddress } from './orchestrator-address'

/**
 * JSON-RPC codes wallet_sendPreparedCalls raises only before the signer broadcasts.
 *
 * Thrown before pool.fetch in handleSendPreparedCalls:
 * - -32602 INVALID_PARAMS: missing context or signature, unsupported chain id,
 *   or validateQuote refusing a zero-fee quote
 * - -32010 QUOTE_EXPIRED: validateQuote
 * - -32011 INVALID_QUOTE_SIGNATURE: validateQuote
 * - -32012 PAYMENT_EXCEEDS_MAX: validateQuote
 * - -32005 INVALID_SIGNATURE: assertErc8128BoundToQuotes
 *
 * Thrown from the signer before sendTransaction / sendRawTransaction, then mapped
 * by handleSendPreparedCalls when the signer response is not ok:
 * - -32008 INTENT_EXPIRED: signer.do.ts isIntentExpired, before either send path
 *
 * Not in this set, and therefore possibly submitted:
 * - -32002 SERVICE_UNAVAILABLE. That code is both a signer failure after the send
 *   await and "Intent submitted but bundle tracking unavailable", which is thrown
 *   only after sendTransaction or sendRawTransaction has already resolved.
 * - Any error with no JSON-RPC code, including "socket hang up" and "fetch failed".
 */
export const DEFINITIVE_PRE_BROADCAST_REFUSAL_CODES: ReadonlySet<number> = new Set([
    -32602,
    -32005,
    -32008,
    -32010,
    -32011,
    -32012,
])

export function isDefinitivePreBroadcastRefusal(error: unknown): boolean {
    const code = jsonRpcCode(error)
    return code !== undefined && DEFINITIVE_PRE_BROADCAST_REFUSAL_CODES.has(code)
}

function jsonRpcCode(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
    const code = (error as { code?: unknown }).code
    return typeof code === 'number' && Number.isInteger(code) ? code : undefined
}

function bundleIdFromSendError(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined
    const data = (error as { data?: unknown }).data
    if (typeof data !== 'object' || data === null || !('bundleId' in data)) return undefined
    const id = (data as { bundleId?: unknown }).bundleId
    return typeof id === 'string' && id.length > 0 ? id : undefined
}

function markPossiblySubmitted(error: unknown): Error {
    const bundleId = bundleIdFromSendError(error)
    const tagged = error instanceof Error ? error : new Error(String(error))
    const marked = tagged as Error & { rotationPossiblySubmitted?: boolean; bundleId?: string }
    marked.rotationPossiblySubmitted = true
    if (bundleId) marked.bundleId = bundleId
    return marked
}

export type PreparedCallRequest = {
    from: Address
    calls: Call[]
    nonce: bigint
    sessionKey?: Hex
    expiry: bigint
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: bigint
}

export type ExecuteSignedCallsParams = {
    from: Address
    calls: Call[]
    nonce: bigint
    sessionKey?: Hex
    signerPrivateKey: Hex
    signerKeyHash?: Hex
    chainId: number
    env: EnvName
    /** Overrides the orchestrator looked up for env/chainId. */
    verifyingContract?: Address
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: bigint
    expiry?: bigint
    /** Unix seconds for expiry bounds. Tests pin this. */
    now?: bigint
    /** Skip the RPC estimate and use this ceiling. */
    combinedGasCeiling?: bigint
    rpcUrl?: string
    /**
     * Called once sendPreparedCalls has returned an id, before the status wait.
     * A throw here is still a post-send error: the id is attached to it.
     */
    onBundleSubmitted?: (bundleId: string) => Promise<void>
}

export type ExecuteSignedCallsDeps = {
    prepareCalls: (input: PreparedCallRequest) => Promise<PrepareCallsResponse>
    /**
     * Runs after the prepared calls are bound to the exact calls about to be
     * signed, and before `signTypedData`.
     */
    beforeSign?: (input: { calls: Call[]; nonce: bigint }) => Promise<void>
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

export type ExecuteSignedCallsResult = {
    id: string
    finalStatus: BundleStatusResponse
    feeCap: FeeCapDisclosure
}

export async function executeSignedCalls(
    deps: ExecuteSignedCallsDeps,
    params: ExecuteSignedCallsParams,
): Promise<ExecuteSignedCallsResult> {
    const now = params.now ?? BigInt(Math.floor(Date.now() / 1000))
    const expiry = params.expiry ?? now + INTENT_EXPIRY_TTL_SECONDS
    const policy = resolveIntentPayment(params.env, params.chainId, params.from)
    // An explicit cap is a ceiling, not the signed value, and it cannot exceed
    // the policy ceiling. Payer and token are required together. Off the local
    // chain ids they must be a non-zero payer and that chain's native USDC, so
    // a zero pair cannot sign native ETH and a raw 5_000_000 cap cannot apply
    // to WBTC. Omitting the cap still uses the policy ceiling when both payer
    // and token are passed, or when neither is.
    // A zero quote and an unclamped caller cap are legal only on local chain ids.
    // env "dev" on Base still uses the 5 USDC clamp.
    const localFeeChain = params.chainId === 31337 || params.chainId === 41337
    const zeroFee = localFeeChain
    refuseLonePayerOrToken(params.payer, params.paymentToken, params.paymentMaxAmount)
    if (params.paymentMaxAmount !== undefined) {
        requirePayerAndToken(params.payer, params.paymentToken)
    }
    const ceiling =
        params.paymentMaxAmount === undefined
            ? policy.paymentMaxAmount
            : zeroFee
              ? params.paymentMaxAmount
              : clampPaymentCeiling(params.paymentMaxAmount, PAID_FEE_CAP)
    const payer = params.payer ?? policy.payer
    const paymentToken = params.paymentToken ?? policy.paymentToken
    if (!localFeeChain) assertOffLocalFeeToken(params.chainId, payer, paymentToken)
    const payment = { payer, paymentToken, paymentMaxAmount: ceiling }
    const combinedGasCeiling =
        params.combinedGasCeiling ??
        (process.env.NODE_ENV === 'test' || !params.rpcUrl
            ? localCombinedGasCeiling(params.calls)
            : await estimateCombinedGasCeiling({
                  rpcUrl: params.rpcUrl,
                  chainId: params.chainId,
                  from: params.from,
                  calls: params.calls,
              }))

    const prepare = (paymentMaxAmount: bigint) =>
        deps.prepareCalls({
            from: params.from,
            calls: params.calls,
            nonce: params.nonce,
            sessionKey: params.sessionKey,
            expiry,
            payer: payment.payer,
            paymentToken: payment.paymentToken,
            paymentMaxAmount,
        })

    let prepared = await prepare(ceiling)
    let signedCap = resolveSignedFeeCap({
        paymentAmount: firstQuotePaymentAmount(prepared),
        ceiling,
        zeroFee,
    })
    if (signedCap !== ceiling) {
        prepared = await prepare(signedCap)
        const again = resolveSignedFeeCap({
            paymentAmount: firstQuotePaymentAmount(prepared),
            ceiling,
            zeroFee,
        })
        if (again !== signedCap) {
            throw new PreparedCallsBindingError(
                'Refusing to sign prepared calls: fee cap does not match the quote',
            )
        }
    }

    const verifyingContract =
        params.verifyingContract ?? resolveOrchestratorAddress(params.env, params.chainId)
    const bound = bindPreparedCalls(prepared, {
        from: params.from,
        calls: params.calls,
        chainId: params.chainId,
        verifyingContract,
        nonce: params.nonce,
        payer: payment.payer,
        paymentToken: payment.paymentToken,
        paymentMaxAmount: signedCap,
        paymentCeiling: ceiling,
        expiry,
        now,
        combinedGasCeiling,
    })

    if (deps.beforeSign) {
        await deps.beforeSign({ calls: params.calls, nonce: params.nonce })
    }

    const signature = await deps.signTypedData({
        privateKey: params.signerPrivateKey,
        typedData: bound.typedData,
    })

    const effectiveSignature = params.signerKeyHash
        ? wrapSignature(signature, params.signerKeyHash)
        : signature

    // The signed intent is handed to the relayer here. After this call, only a
    // definitive pre-broadcast refusal means the transaction was not broadcast.
    let submission: { id: string }
    try {
        submission = await deps.sendPreparedCalls({
            context: prepared.context,
            signature: effectiveSignature,
        })
    } catch (error) {
        if (isDefinitivePreBroadcastRefusal(error)) throw error
        throw markPossiblySubmitted(error)
    }

    const tagBundle = (error: unknown): unknown => {
        if (error instanceof Error) {
            ;(error as Error & { bundleId?: string }).bundleId = submission.id
            return error
        }
        const wrapped = new Error(String(error)) as Error & { bundleId?: string }
        wrapped.bundleId = submission.id
        return wrapped
    }

    try {
        if (params.onBundleSubmitted) {
            await params.onBundleSubmitted(submission.id)
        }
    } catch (error) {
        throw tagBundle(error)
    }

    let finalStatus: BundleStatusResponse
    try {
        finalStatus = await deps.waitForBundle({ id: submission.id })
    } catch (error) {
        throw tagBundle(error)
    }

    return {
        id: submission.id,
        finalStatus,
        feeCap: discloseFeeCap(paymentToken, signedCap),
    }
}
