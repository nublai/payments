import { isAddress, zeroAddress, keccak256, toBytes, fromHex, type Address, type Hex } from 'viem'
import { hashTypedData } from 'viem/utils'
import type { RelayerConfig, Env } from '../../../types/env'
import type { IntentStruct } from '../../../types/pool'
import {
    INVALID_PARAMS,
    INVALID_SIGNATURE,
    PAYMENT_EXCEEDS_MAX,
    QUOTE_EXPIRED,
    INVALID_QUOTE_SIGNATURE,
    RpcError,
} from '../../errors'
import { isLocalDevContext, quoteSigningSecret } from '../../../config/runtime-context'
import { verifyQuoteSignature } from '../../../lib/quote-signing'
import { validatePaymentAmount } from '../../../services/fees'
import { recomputeQuotePaymentAmount } from '../../../services/quote-payment'
import { signerIsAccountKey } from '../../../auth/erc8128/account-key'
import {
    authorizeErc8128Signer,
    parseChainId,
    type BoundAccount,
} from '../../../auth/erc8128/signer-policy'
import type { RpcCaller } from '../../types'
import { selectSignerForEoa } from '../../../lib/pool-utils'
import { parseHexChainId } from '../../../lib/rpc-utils'
import type { PrepareCallsContext, QuoteIntent, SignedQuotes } from '../../schema/prepareCalls'
import type { SendPreparedCallsParams } from '../../schema/sendPreparedCalls'
import { INTENT_TYPES } from '../../schema/intentTypes'

export function getChainIdFromContext(context: PrepareCallsContext): number {
    if ('quote' in context && context.quote?.quotes?.length) {
        const first = parseHexChainId(context.quote.quotes[0].chainId, 'chain_id')

        for (const quote of context.quote.quotes) {
            const chainId = parseHexChainId(quote.chainId, 'chain_id')

            if (chainId !== first) {
                throw new RpcError(INVALID_PARAMS, 'Mixed chainIds in quotes are not supported')
            }
        }

        return first
    }

    throw new RpcError(INVALID_PARAMS, 'Missing chain_id in context')
}

/**
 * Get signer name from EOA address and chain ID.
 */
export function getSignerName(eoa: Address, chainId: number, signerCount: number = 1): string {
    const index = selectSignerForEoa(eoa, signerCount)

    return `signer-${chainId}-${index}`
}

/**
 * Hash quotes to generate deterministic bundle ID.
 */
export function hashQuotes(signedQuotes: SignedQuotes, config: RelayerConfig): Hex {
    const bytes: Uint8Array[] = []

    for (const quote of signedQuotes.quotes) {
        const chainId = parseInt(quote.chainId, 16)

        if (chainId !== config.chainId) {
            throw new RpcError(
                INVALID_PARAMS,
                `Quote chainId ${chainId} does not match relayer chain ${config.chainId}`,
            )
        }

        bytes.push(toBytes(chainId, { size: 32 }))

        const domain = {
            name: 'Orchestrator',
            version: '0.5.5',
            chainId: config.chainId,
            verifyingContract: config.contracts.orchestrator,
        }

        const intentMessage = {
            multichain: false,
            eoa: quote.intent.eoa as Address,
            calls: quote.intent.calls.map((call) => ({
                to: call.to as Address,
                value: BigInt(call.value || '0'),
                data: call.data as Hex,
            })),
            nonce: BigInt(quote.intent.nonce || '0'),
            payer: (quote.intent.payer ?? zeroAddress) as Address,
            paymentToken: (quote.intent.paymentToken ?? zeroAddress) as Address,
            paymentMaxAmount: BigInt(quote.intent.paymentMaxAmount ?? '0'),
            combinedGas: BigInt(quote.intent.combinedGas || '0'),
            encodedPreCalls: (quote.intent.encodedPreCalls ?? []) as Hex[],
            encodedFundTransfers: (quote.intent.encodedFundTransfers ?? []) as Hex[],
            settler: (quote.intent.settler ?? zeroAddress) as Address,
            expiry: BigInt(quote.intent.expiry || '0'),
        }

        const intentDigest = hashTypedData({
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent',
            message: intentMessage,
        })

        bytes.push(fromHex(intentDigest, { to: 'bytes' }))

        const extraPayment = BigInt(quote.extraPayment || '0x0')
        bytes.push(toBytes(extraPayment, { size: 32 }))

        const ethPrice = BigInt(quote.ethPrice || '0x0')
        bytes.push(toBytes(ethPrice, { size: 32 }))

        bytes.push(new Uint8Array([quote.paymentTokenDecimals]))
        bytes.push(toBytes(quote.txGas, { size: 32 }))
        bytes.push(toBytes(quote.nativeFeeEstimate.maxFeePerGas, { size: 32 }))
        bytes.push(toBytes(quote.nativeFeeEstimate.maxPriorityFeePerGas, { size: 32 }))
        bytes.push(fromHex(quote.orchestrator, { to: 'bytes' }))

        const feeTokenDeficit = BigInt(quote.feeTokenDeficit || '0x0')
        const hasDeficit = feeTokenDeficit !== 0n || (quote.assetDeficits?.length ?? 0) > 0
        bytes.push(new Uint8Array([hasDeficit ? 1 : 0]))

        if (quote.accountUpgrade) {
            bytes.push(toBytes(keccak256(toBytes(JSON.stringify(quote.accountUpgrade)))))
        }
    }

    const totalLength = bytes.reduce((sum, arr) => sum + arr.length, 0)
    const concatenated = new Uint8Array(totalLength)
    let offset = 0

    for (const arr of bytes) {
        concatenated.set(arr, offset)
        offset += arr.length
    }

    return keccak256(concatenated)
}

export function extractIntentFromContext(context: PrepareCallsContext): QuoteIntent {
    const quote = context.quote.quotes[0]

    if (!quote) {
        throw new RpcError(INVALID_PARAMS, 'No quote found in context')
    }

    return quote.intent
}

/**
 * Validate quote TTL, signature, and payment amount.
 * The collected fee is recomputed from the quote's gas fields. The client-supplied
 * `paymentAmount` is ignored.
 */
export async function validateQuote(
    signedQuotes: SignedQuotes,
    env: Pick<Env, 'QUOTE_SIGNING_SECRET' | 'CONTEXT'>,
): Promise<RpcError | null> {
    const currentTime = Math.floor(Date.now() / 1000)

    // Boundary policy: equality is expired. A quote TTL at the current second is no longer valid.
    if (typeof signedQuotes.ttl !== 'number' || signedQuotes.ttl <= currentTime) {
        return new RpcError(
            QUOTE_EXPIRED,
            `Quote expired at ${signedQuotes.ttl}, current time is ${currentTime}`,
        )
    }

    const secret = quoteSigningSecret(env)

    if (!isLocalDevContext(env) && !secret) {
        return new RpcError(
            INVALID_QUOTE_SIGNATURE,
            'QUOTE_SIGNING_SECRET is required outside local',
        )
    }

    if (secret) {
        const isValid = await verifyQuoteSignature(signedQuotes, secret)

        if (!isValid) {
            return new RpcError(INVALID_QUOTE_SIGNATURE, 'Quote signature verification failed')
        }
    }

    const quote = signedQuotes.quotes[0]

    if (quote?.intent.payer && quote.intent.payer !== zeroAddress) {
        let paymentAmount: bigint

        try {
            paymentAmount = recomputeQuotePaymentAmount({
                txGas: quote.txGas,
                maxFeePerGas: quote.nativeFeeEstimate?.maxFeePerGas,
                paymentToken: quote.intent.paymentToken,
                paymentTokenDecimals: quote.paymentTokenDecimals,
                nativeRate: quote.nativeRate,
            })
        } catch (error) {
            if (error instanceof RpcError) return error
            throw error
        }

        const paymentMaxAmount = BigInt(quote.intent.paymentMaxAmount || '0')

        if (!isLocalDevContext(env) && paymentAmount === 0n) {
            return new RpcError(INVALID_PARAMS, 'Refusing a zero fee quote')
        }

        if (!validatePaymentAmount(paymentAmount, paymentMaxAmount)) {
            return new RpcError(
                PAYMENT_EXCEEDS_MAX,
                `Payment amount ${paymentAmount} exceeds max ${paymentMaxAmount}`,
            )
        }
    }

    return null
}

/**
 * Called only after the quote HMAC has been checked.
 * The HTTP signer must be allowlisted, the intent EOA, or an on-chain key of that account.
 * `authSigner` on the quote is not accepted by itself.
 */
export async function assertErc8128BoundToQuotes(
    env: Pick<Env, 'CONTEXT' | 'ERC8128_ALLOWED_SIGNERS' | 'RPC_URL'> & Partial<Env>,
    auth: RpcCaller | undefined,
    quotes: Array<{ chainId?: string; intent?: { eoa?: string }; authSigner?: string }>,
): Promise<RpcError | null> {
    if (isLocalDevContext(env)) return null

    if (auth?.provider !== 'erc8128') return null

    const signer = auth.userId

    if (!signer || !isAddress(signer)) {
        return new RpcError(INVALID_SIGNATURE, 'ERC-8128 signer is missing')
    }

    const accounts: BoundAccount[] = []

    for (const quote of quotes) {
        const eoa =
            quote.intent?.eoa && isAddress(quote.intent.eoa)
                ? (quote.intent.eoa as Address)
                : undefined

        if (!eoa) {
            return new RpcError(
                INVALID_SIGNATURE,
                'ERC-8128 signer is not allowlisted and is not bound to the intent account',
            )
        }

        accounts.push({ eoa, chainId: parseChainId(quote.chainId) })
    }

    const nowSeconds = Math.floor(Date.now() / 1000)

    const decision = await authorizeErc8128Signer({
        env,
        signer,
        binding: { accounts, otherProtectedMethods: [] },
        isAccountKey: (account, chainId, accountSigner) =>
            signerIsAccountKey(env, account, chainId, accountSigner, nowSeconds),
    })

    if (!decision.ok) {
        return new RpcError(INVALID_SIGNATURE, decision.message)
    }

    return null
}

/**
 * Build an IntentStruct from sendPreparedCalls params.
 */
export function buildIntentFromParams(params: SendPreparedCallsParams): IntentStruct {
    const { context, signature, paymentSignature: paramsPaymentSig, capabilities } = params
    const explicitPaymentSignature = paramsPaymentSig ?? capabilities?.feeSignature

    const quoteIntent = extractIntentFromContext(context)
    const quote = context.quote.quotes[0]
    const payer = quoteIntent.payer ?? zeroAddress

    const paymentAmount =
        payer !== zeroAddress && quote
            ? recomputeQuotePaymentAmount({
                  txGas: quote.txGas,
                  maxFeePerGas: quote.nativeFeeEstimate?.maxFeePerGas,
                  paymentToken: quote.intent.paymentToken,
                  paymentTokenDecimals: quote.paymentTokenDecimals,
                  nativeRate: quote.nativeRate,
              }).toString()
            : '0'

    return {
        eoa: quoteIntent.eoa,
        calls: quoteIntent.calls.map((call) => ({
            to: call.to,
            value: call.value,
            data: call.data,
        })),
        nonce: quoteIntent.nonce,
        combinedGas: quoteIntent.combinedGas,
        expiry: quoteIntent.expiry,
        signature,
        encodedPreCalls: quoteIntent.encodedPreCalls ?? [],
        funder: quoteIntent.funder ?? zeroAddress,
        encodedFundTransfers: quoteIntent.encodedFundTransfers ?? [],
        funderSignature: '0x',
        settler: quoteIntent.settler ?? zeroAddress,
        settlerContext: quoteIntent.settlerContext ?? '0x',
        isMultichain: false,
        payer: quoteIntent.payer ?? zeroAddress,
        paymentToken: quoteIntent.paymentToken ?? zeroAddress,
        paymentMaxAmount: quoteIntent.paymentMaxAmount ?? '0',
        paymentAmount,
        paymentRecipient: zeroAddress,
        paymentSignature:
            explicitPaymentSignature ??
            quoteIntent.paymentSignature ??
            (quoteIntent.payer === quoteIntent.eoa ? signature : '0x'),
        supportedAccountImplementation: zeroAddress,
    }
}
