import {
    bindPreparedCalls,
    firstQuotePaymentAmount,
    INTENT_EXPIRY_TTL_SECONDS,
    PreparedCallsBindingError,
    resolveSignedFeeCap,
    wrapSignature,
    type BundleStatusResponse,
    type Call,
    type PrepareCallsResponse,
} from '@nubl/relayer-client'
import { zeroAddress, type Address, type Hex } from 'viem'
import { estimateCombinedGasCeiling, localCombinedGasCeiling } from './gas-ceiling'
import { discloseFeeCap, isLocalFeeChain, resolveIntentPayment, type FeeCapDisclosure } from './intent-payment'
import type { EnvName } from './network-config'
import { resolveOrchestratorAddress } from './orchestrator-address'

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
}

export type ExecuteSignedCallsDeps = {
    prepareCalls: (input: PreparedCallRequest) => Promise<PrepareCallsResponse>
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
    // An explicit cap is a ceiling, not the signed value. Passing payer or token
    // without a cap still uses the policy ceiling, so the omitted cap cannot be
    // signed as 0. Passing only a cap leaves payer and token unset.
    const callerSetPayment =
        params.paymentMaxAmount !== undefined ||
        params.payer !== undefined ||
        params.paymentToken !== undefined
    const ceiling = params.paymentMaxAmount ?? policy.paymentMaxAmount
    const payer = callerSetPayment ? (params.payer ?? zeroAddress) : policy.payer
    const paymentToken = callerSetPayment ? (params.paymentToken ?? zeroAddress) : policy.paymentToken
    const zeroFee = isLocalFeeChain(params.env, params.chainId)
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

    const signature = await deps.signTypedData({
        privateKey: params.signerPrivateKey,
        typedData: bound.typedData,
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
        feeCap: discloseFeeCap(paymentToken, signedCap),
    }
}
