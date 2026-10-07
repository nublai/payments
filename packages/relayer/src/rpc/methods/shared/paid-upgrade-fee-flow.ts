import {
    createPublicClient,
    erc20Abi,
    getAddress,
    http,
    type Address,
    type Hex,
    type PublicClient,
    type SignedAuthorization,
} from 'viem'
import { recoverTypedDataAddress } from 'viem/utils'

import type { Env } from '../../../types/env'
import { logger } from '../../../lib/logger'
import {
    CONTRACT_ERROR,
    INSUFFICIENT_FUNDS,
    INVALID_PARAMS,
    INVALID_SIGNATURE,
    RATE_LIMITED,
    RpcError,
    SERVICE_UNAVAILABLE,
} from '../../errors'
import type { PaidUpgradeQuote, Quote } from '../../schema/prepareCalls'
import type { SendPreparedCallsParams } from '../../schema/sendPreparedCalls'
import {
    feeAuthorizationWindowReason,
    feePullConfirmed,
    isPaidUpgradeFeeStatus,
    paidUpgradeFeeNonce,
    paidUpgradeFeeTypedData,
    paidUpgradeQuoteKey,
    type PaidUpgradeFeeAuthorization,
    type PaidUpgradeFeeRecord,
    type PaidUpgradeFeeStatus,
} from '../../schema/paid-upgrade-fee'
import type { IntentStruct, SendResult } from '../../../types/pool'
import { getSignerPool } from './signer-pool'
import {
    assertPaidUpgrade,
    assertPaidUpgradeIntentSigner,
    assertPaidUpgradeSimulation,
    chainUsdcAddress,
    eip7702DelegationCode,
    enqueuePaidUpgradeReceipt,
    paidUpgradeFieldsMatch,
    paidUpgradeGasReservationFits,
    paidUpgradeMaxPayment,
    releasePaidUpgradeGas,
    releasePaidUpgradeRateLimit,
    reservePaidUpgradeGas,
    reservePaidUpgradeRateLimit,
    paidUpgradeReceiptOutcome,
    paidUpgradeReceiptWaitMs,
    settlePaidUpgradeGas,
    signedPaymentMaxForQuote,
} from './paid-upgrade'

const FEE_ON_FILE = new Set<PaidUpgradeFeeStatus>([
    'fee_collected',
    'upgrade_pending',
    'upgrade_confirmed',
    'upgrade_landed',
    'upgrade_failed',
    'pull_intent',
])

export interface PaidUpgradeReady {
    kind: 'ready'
    /**
     * Present for a first type-4 broadcast. Absent when a reverted upgrade
     * already applied the delegation and the retry is a plain execute.
     */
    authorization?: SignedAuthorization
    /** True only when this request holds a rate slot the pull did not consume. */
    releaseRate: boolean
    reservedAt?: number
    record: PaidUpgradeFeeRecord
}

export interface PaidUpgradeConfirmed {
    kind: 'confirmed'
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
    return paidUpgradeFieldsMatch({ authorization, preCall }, quoted)
}

export function paidUpgradeFeeRecipient(env: { FEE_RECIPIENT?: string }): Address {
    const raw = env.FEE_RECIPIENT?.trim()
    if (!raw) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade fee recipient is not configured')
    }
    try {
        return getAddress(raw)
    } catch {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade fee recipient is not configured')
    }
}

function parseFeeAuthorization(value: PaidUpgradeFeeAuthorization | undefined): {
    validAfter: bigint
    validBefore: bigint
    nonce: Hex
    signature: Hex
} {
    if (!value?.nonce || !value.signature) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee authorization is required')
    }
    let validAfter: bigint
    let validBefore: bigint
    try {
        validAfter = BigInt(value.validAfter)
        validBefore = BigInt(value.validBefore)
    } catch {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee authorization expired')
    }
    return { validAfter, validBefore, nonce: value.nonce, signature: value.signature }
}

/**
 * Checks that run before the pull is submitted. `to` is the configured fee
 * recipient. `value` is the clamped quote. The nonce is derived from the
 * quote HMAC. None of these are taken from the request.
 */
export async function assertPaidUpgradeFeeAuthorization(args: {
    authorization: PaidUpgradeFeeAuthorization | undefined
    quoteSignature: Hex
    quoteTtl: number
    chainId: number
    from: Address
    token: Address
    feeRecipient: Address
    quotePayee?: Address
    value: bigint
    now?: bigint
}): Promise<{ nonce: Hex; validAfter: bigint; validBefore: bigint; signature: Hex }> {
    const parsed = parseFeeAuthorization(args.authorization)
    if (!args.quotePayee || getAddress(args.quotePayee) !== args.feeRecipient) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee recipient does not match')
    }
    const now = args.now ?? Math.floor(Date.now() / 1000)
    const window = feeAuthorizationWindowReason({
        validAfter: parsed.validAfter,
        validBefore: parsed.validBefore,
        now: BigInt(now),
        quoteTtl: BigInt(args.quoteTtl),
    })
    if (window) throw new RpcError(INVALID_PARAMS, window)

    let expectedNonce: Hex
    try {
        expectedNonce = paidUpgradeFeeNonce({
            quoteSignature: args.quoteSignature,
            chainId: args.chainId,
            from: args.from,
            to: args.feeRecipient,
            value: args.value,
        })
    } catch {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee nonce does not match the quote')
    }
    if (parsed.nonce.toLowerCase() !== expectedNonce.toLowerCase()) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee nonce does not match the quote')
    }

    const typed = paidUpgradeFeeTypedData({
        chainId: args.chainId,
        token: args.token,
        from: args.from,
        to: args.feeRecipient,
        value: args.value,
        validAfter: parsed.validAfter,
        validBefore: parsed.validBefore,
        nonce: expectedNonce,
    })
    let recovered: Address
    try {
        recovered = await recoverTypedDataAddress({ ...typed, signature: parsed.signature })
    } catch {
        throw new RpcError(INVALID_SIGNATURE, 'Paid upgrade fee signer is not the account')
    }
    if (getAddress(recovered) !== getAddress(args.from)) {
        throw new RpcError(INVALID_SIGNATURE, 'Paid upgrade fee signer is not the account')
    }
    return { ...parsed, nonce: expectedNonce }
}

function recordFromBody(value: unknown): PaidUpgradeFeeRecord | null {
    if (!value || typeof value !== 'object') return null
    const body = value as Record<string, unknown>
    if (!isPaidUpgradeFeeStatus(body.status)) return null
    if (typeof body.fee !== 'string' || typeof body.from !== 'string' || typeof body.to !== 'string') {
        return null
    }
    if (typeof body.nonce !== 'string') return null
    try {
        return {
            status: body.status,
            fee: body.fee,
            from: getAddress(body.from),
            to: getAddress(body.to),
            nonce: body.nonce as Hex,
            pullTx: typeof body.pullTx === 'string' ? (body.pullTx as Hex) : undefined,
            upgradeTx: typeof body.upgradeTx === 'string' ? (body.upgradeTx as Hex) : undefined,
            bundleId: typeof body.bundleId === 'string' ? body.bundleId : undefined,
        }
    } catch {
        return null
    }
}

async function postFeeStore(
    env: Env,
    chainId: number,
    body: Record<string, unknown>,
): Promise<{ inserted?: boolean; record: PaidUpgradeFeeRecord | null }> {
    const pool = getSignerPool(env, chainId)
    let response: Response
    try {
        response = await pool.fetch(`http://do/paid-upgrade-fee?poolName=pool-${chainId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
    } catch (error) {
        logger.error({ error, chainId }, 'paid upgrade fee store unavailable')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    if (!response.ok) {
        logger.error({ chainId, status: response.status }, 'paid upgrade fee store failed')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    const result = (await response.json()) as {
        allowed?: boolean
        inserted?: boolean
        record?: unknown
    }
    if (result.allowed !== true) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    return { inserted: result.inserted, record: recordFromBody(result.record) }
}

export async function readPaidUpgradeFee(
    env: Env,
    chainId: number,
    quoteSignature: Hex,
): Promise<PaidUpgradeFeeRecord | null> {
    const quoteKey = quoteKeyOrThrow(quoteSignature)
    const result = await postFeeStore(env, chainId, { action: 'get', quoteKey })
    return result.record
}

export async function writePaidUpgradeFee(
    env: Env,
    chainId: number,
    quoteSignature: Hex,
    record: PaidUpgradeFeeRecord,
    mode: 'insert' | 'update' | 'delete',
): Promise<{ inserted: boolean; record: PaidUpgradeFeeRecord | null }> {
    const quoteKey = quoteKeyOrThrow(quoteSignature)
    const result = await postFeeStore(env, chainId, { action: mode, quoteKey, record })
    if (mode === 'update' && !result.record) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    return { inserted: result.inserted === true, record: result.record }
}

function quoteKeyOrThrow(quoteSignature: Hex): string {
    try {
        return paidUpgradeQuoteKey(quoteSignature)
    } catch {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee nonce does not match the quote')
    }
}

function feeRecord(input: {
    status: PaidUpgradeFeeStatus
    fee: bigint
    from: Address
    to: Address
    nonce: Hex
    bundleId: string
    pullTx?: Hex
    upgradeTx?: Hex
    signerNonce?: number
    signerName?: string
}): PaidUpgradeFeeRecord {
    return {
        status: input.status,
        fee: input.fee.toString(),
        from: getAddress(input.from),
        to: getAddress(input.to),
        nonce: input.nonce,
        bundleId: input.bundleId,
        pullTx: input.pullTx,
        upgradeTx: input.upgradeTx,
        ...(input.signerNonce !== undefined ? { signerNonce: input.signerNonce } : {}),
        ...(input.signerName ? { signerName: input.signerName } : {}),
    }
}

async function sendPool(
    env: Env,
    chainId: number,
    body: unknown,
): Promise<{ ok: true; result: SendResult } | { ok: false; error: string; broadcastAttempted: boolean }> {
    const pool = getSignerPool(env, chainId)
    let response: Response
    try {
        response = await pool.fetch(`http://do/send?poolName=pool-${chainId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
    } catch (error) {
        logger.error({ error, chainId }, 'paid upgrade pool unavailable')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    if (!response.ok) {
        const errorBody = (await response.json()) as { error?: string; broadcastAttempted?: boolean }
        return {
            ok: false,
            error: errorBody.error ?? 'Paid upgrade failed',
            broadcastAttempted: errorBody.broadcastAttempted !== false,
        }
    }
    return { ok: true, result: (await response.json()) as SendResult }
}

async function authorizationUsed(
    publicClient: PublicClient,
    usdc: Address,
    from: Address,
    nonce: Hex,
): Promise<boolean> {
    try {
        return await publicClient.readContract({
            address: usdc,
            abi: [
                {
                    type: 'function',
                    name: 'authorizationState',
                    stateMutability: 'view',
                    inputs: [
                        { name: 'authorizer', type: 'address' },
                        { name: 'nonce', type: 'bytes32' },
                    ],
                    outputs: [{ name: '', type: 'bool' }],
                },
            ],
            functionName: 'authorizationState',
            args: [from, nonce],
        })
    } catch (error) {
        logger.error({ error }, 'paid upgrade fee authorization state unavailable')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
}

async function balanceOf(publicClient: PublicClient, token: Address, account: Address): Promise<bigint> {
    try {
        return await publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account],
        })
    } catch (error) {
        logger.error({ error }, 'paid upgrade fee balance unavailable')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
}

function storedSimulationError(error: unknown): boolean {
    return (
        error instanceof RpcError &&
        (error.code === INVALID_SIGNATURE ||
            error.code === INSUFFICIENT_FUNDS ||
            error.code === CONTRACT_ERROR)
    )
}

async function releaseRateSlot(
    env: Env,
    chainId: number,
    account: Address,
    ip: string,
    reservedAt: number | undefined,
    releaseRate: boolean,
): Promise<void> {
    if (releaseRate && reservedAt !== undefined) {
        await releasePaidUpgradeRateLimit(env, chainId, account, ip, reservedAt)
    }
}

async function releaseAttempt(
    env: Env,
    chainId: number,
    account: Address,
    ip: string,
    reservedAt: number | undefined,
    releaseRate: boolean,
): Promise<void> {
    await releasePaidUpgradeGas(env, chainId)
    await releaseRateSlot(env, chainId, account, ip, reservedAt, releaseRate)
}

/**
 * Reserve the paid-upgrade buckets and gas, pull the clamped fee, and return
 * only after that pull has a successful receipt. The type-4 upgrade is sent
 * by the caller.
 *
 * If the pull lands and the upgrade later reverts, the record stays keyed by
 * the quote HMAC. A later send of the same quote retries the upgrade and does
 * not pull again.
 */
export async function bindAndPullPaidUpgrade(args: {
    env: Env
    params: SendPreparedCallsParams
    intent: IntentStruct
    chainId: number
    ip: string
    config: { rpcUrl: string; contracts: { orchestrator: Address; accountProxy: Address } }
    quote: Quote
    quoteSignature: Hex
    quoteTtl: number
    bundleId: string
}): Promise<PaidUpgradeReady | PaidUpgradeConfirmed> {
    const upgrade = args.quote.accountUpgrade
    if (!upgrade) throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee authorization is required')
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
    let quotedPayment: bigint
    try {
        quotedPayment = BigInt(args.quote.paymentAmount)
    } catch {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee does not match the quote')
    }
    if (quotedPayment !== paymentAmount) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee does not match the quote')
    }
    if (paymentAmount <= 0n) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee must be greater than zero')
    }

    const fee = signedPaymentMaxForQuote(paymentAmount)
    const feeRecipient = paidUpgradeFeeRecipient(args.env)
    const usdc = chainUsdcAddress(args.chainId)
    const publicClient = createPublicClient({ transport: http(args.config.rpcUrl) })
    const proxyCode = eip7702DelegationCode(args.config.contracts.accountProxy).toLowerCase()
    let record = await readPaidUpgradeFee(args.env, args.chainId, args.quoteSignature)
    const feeOnFile = record ? FEE_ON_FILE.has(record.status) && record.status !== 'pull_intent' : false

    let code: Hex | undefined
    try {
        code = await publicClient.getCode({ address: args.intent.eoa })
    } catch (error) {
        logger.error({ error }, 'failed to read account before paid upgrade fee')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    const delegated = code?.toLowerCase() === proxyCode

    const feeAuth = await assertPaidUpgradeFeeAuthorization({
        authorization: args.params.feeAuthorization,
        quoteSignature: args.quoteSignature,
        quoteTtl: args.quoteTtl,
        chainId: args.chainId,
        from: args.intent.eoa,
        token: usdc,
        feeRecipient,
        quotePayee: args.quote.feeRecipient,
        value: fee,
    })

    if (delegated && (record?.status === 'upgrade_confirmed' || record?.status === 'upgrade_landed')) {
        await writePaidUpgradeFee(
            args.env,
            args.chainId,
            args.quoteSignature,
            feeRecord({
                status: 'upgrade_confirmed',
                fee,
                from: args.intent.eoa,
                to: feeRecipient,
                nonce: feeAuth.nonce,
                bundleId: record?.bundleId ?? args.bundleId,
                pullTx: record?.pullTx,
                upgradeTx: record?.upgradeTx,
                signerNonce: record?.signerNonce,
                signerName: record?.signerName,
            }),
            record ? 'update' : 'insert',
        )
        return { kind: 'confirmed' }
    }

    const checked = await assertPaidUpgrade({
        eoa: args.intent.eoa,
        payer: args.intent.payer,
        paymentToken: args.intent.paymentToken,
        paymentMaxAmount:
            args.intent.paymentMaxAmount === undefined ? undefined : String(args.intent.paymentMaxAmount),
        upgrade,
        encodedPreCalls: args.intent.encodedPreCalls,
        chainId: args.chainId,
        orchestrator: args.config.contracts.orchestrator,
        accountProxy: args.config.contracts.accountProxy,
        usdc,
        maxPayment: paidUpgradeMaxPayment(args.env),
        paymentAmount,
        publicClient,
        requiredBalance: feeOnFile || record?.status === 'pull_intent' ? 0n : fee,
        allowExistingDelegation: feeOnFile,
    })
    if (BigInt(args.intent.paymentMaxAmount ?? '0') !== fee) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade paymentMaxAmount exceeds the quoted fee cap')
    }
    await assertPaidUpgradeIntentSigner({
        intent: args.intent,
        chainId: args.chainId,
        orchestrator: args.config.contracts.orchestrator,
    })

    args.intent.paymentAmount = '0'

    const retryWithoutAuthorization = delegated && feeOnFile
    const simulate = () =>
        assertPaidUpgradeSimulation({
            publicClient,
            orchestrator: args.config.contracts.orchestrator,
            intent: args.intent,
            ...(retryWithoutAuthorization ? {} : { authorization: checked.authorization }),
            feeRecipient: args.env.FEE_RECIPIENT,
            env: args.env,
        })

    let releaseRate = false
    let reservedAt: number | undefined
    const needsPull = !record || record.status === 'pull_failed' || record.status === 'pull_intent'
    if (needsPull && record?.status !== 'pull_intent') {
        // A reverted pull kept its rate slot. A missing record, or a pull that
        // never left the relayer, has to take one.
        if (!record || record.status !== 'pull_failed') {
            reservedAt = await reservePaidUpgradeRateLimit(args.env, args.chainId, args.intent.eoa, args.ip)
            releaseRate = true
        }
        try {
            await simulate()
        } catch (error) {
            if (releaseRate && reservedAt !== undefined && !storedSimulationError(error)) {
                await releasePaidUpgradeRateLimit(args.env, args.chainId, args.intent.eoa, args.ip, reservedAt)
            }
            throw error
        }
    } else if (record?.status === 'upgrade_failed' || record?.status === 'fee_collected') {
        await simulate()
    }

    if (needsPull) {
        record = await ensureFeeCollected({
            env: args.env,
            chainId: args.chainId,
            publicClient,
            usdc,
            from: args.intent.eoa,
            to: feeRecipient,
            fee,
            nonce: feeAuth.nonce,
            validAfter: feeAuth.validAfter,
            validBefore: feeAuth.validBefore,
            signature: feeAuth.signature,
            bundleId: args.bundleId,
            quoteSignature: args.quoteSignature,
            existing: record?.status === 'pull_intent' || record?.status === 'pull_failed' ? record : null,
            releaseRate,
            reservedAt,
            ip: args.ip,
        })
        releaseRate = false
    }

    const feeCollected =
        record !== null &&
        (record.status === 'fee_collected' ||
            record.status === 'upgrade_pending' ||
            record.status === 'upgrade_failed' ||
            record.status === 'upgrade_confirmed' ||
            record.status === 'upgrade_landed')
    if (!feeCollected || !record) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade fee pull failed')
    }

    if (record.status === 'upgrade_pending' && record.upgradeTx) {
        const outcome = await settlePendingUpgrade(args.env, args.chainId, publicClient, args.quoteSignature, record)
        if (outcome === 'confirmed' || outcome === 'landed') return { kind: 'confirmed' }
        record = { ...record, status: 'upgrade_failed' }
    }
    if (record.status === 'upgrade_confirmed' || record.status === 'upgrade_landed') {
        return { kind: 'confirmed' }
    }

    await reservePaidUpgradeGas(args.env, args.chainId)
    return {
        kind: 'ready',
        ...(retryWithoutAuthorization ? {} : { authorization: checked.authorization }),
        releaseRate,
        reservedAt,
        record,
    }
}

async function ensureFeeCollected(args: {
    env: Env
    chainId: number
    publicClient: PublicClient
    usdc: Address
    from: Address
    to: Address
    fee: bigint
    nonce: Hex
    validAfter: bigint
    validBefore: bigint
    signature: Hex
    bundleId: string
    quoteSignature: Hex
    existing: PaidUpgradeFeeRecord | null
    releaseRate: boolean
    reservedAt?: number
    ip: string
}): Promise<PaidUpgradeFeeRecord> {
    const used = await authorizationUsed(args.publicClient, args.usdc, args.from, args.nonce)
    if (used && !args.existing?.pullTx) {
        await releasePaidUpgradeGas(args.env, args.chainId)
        const collected = feeRecord({
            status: 'fee_collected',
            fee: args.fee,
            from: args.from,
            to: args.to,
            nonce: args.nonce,
            bundleId: args.bundleId,
            pullTx: args.existing?.pullTx,
        })
        const wrote = await writePaidUpgradeFee(
            args.env,
            args.chainId,
            args.quoteSignature,
            collected,
            args.existing ? 'update' : 'insert',
        )
        return wrote.record ?? collected
    }

    if (args.existing?.status === 'pull_intent' && args.existing.pullTx) {
        return resumePull(args, args.existing.pullTx, args.existing)
    }

    const intent = feeRecord({
        status: 'pull_intent',
        fee: args.fee,
        from: args.from,
        to: args.to,
        nonce: args.nonce,
        bundleId: args.bundleId,
    })
    const inserted = await writePaidUpgradeFee(
        args.env,
        args.chainId,
        args.quoteSignature,
        intent,
        args.existing ? 'update' : 'insert',
    )
    if (!args.existing && !inserted.inserted) {
        if (args.releaseRate && args.reservedAt !== undefined) {
            await releasePaidUpgradeRateLimit(args.env, args.chainId, args.from, args.ip, args.reservedAt)
        }
        const current = inserted.record ?? (await readPaidUpgradeFee(args.env, args.chainId, args.quoteSignature))
        if (!current) throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
        if (current.status === 'fee_collected' || current.status === 'upgrade_failed' || current.status === 'upgrade_pending' || current.status === 'upgrade_confirmed' || current.status === 'upgrade_landed') {
            return current
        }
        if (current.pullTx) return resumePull(args, current.pullTx, current)
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }

    try {
        const fits = await paidUpgradeGasReservationFits(args.env, args.chainId)
        if (!fits) {
            throw new RpcError(RATE_LIMITED, 'Paid upgrade gas budget exceeded')
        }
    } catch (error) {
        await writePaidUpgradeFee(args.env, args.chainId, args.quoteSignature, intent, 'delete')
        await releaseRateSlot(
            args.env,
            args.chainId,
            args.from,
            args.ip,
            args.reservedAt,
            args.releaseRate,
        )
        throw error
    }

    try {
        await reservePaidUpgradeGas(args.env, args.chainId)
    } catch (error) {
        await writePaidUpgradeFee(args.env, args.chainId, args.quoteSignature, intent, 'delete')
        if (error instanceof RpcError && error.code === RATE_LIMITED) {
            await releaseRateSlot(
                args.env,
                args.chainId,
                args.from,
                args.ip,
                args.reservedAt,
                args.releaseRate,
            )
        } else {
            await releaseAttempt(
                args.env,
                args.chainId,
                args.from,
                args.ip,
                args.reservedAt,
                args.releaseRate,
            )
        }
        throw error
    }
    const balanceBefore = await balanceOf(args.publicClient, args.usdc, args.to)
    const sent = await sendPool(args.env, args.chainId, {
        id: `${args.bundleId}:fee`,
        type: 'pull-paid-upgrade-fee',
        account: args.from,
        usdc: args.usdc,
        from: args.from,
        to: args.to,
        value: args.fee.toString(),
        validAfter: args.validAfter.toString(),
        validBefore: args.validBefore.toString(),
        nonce: args.nonce,
        signature: args.signature,
    })
    if (!sent.ok) {
        if (!sent.broadcastAttempted) {
            await writePaidUpgradeFee(args.env, args.chainId, args.quoteSignature, intent, 'delete')
            await releaseAttempt(args.env, args.chainId, args.from, args.ip, args.reservedAt, args.releaseRate)
        }
        throw new RpcError(SERVICE_UNAVAILABLE, sent.error || 'Paid upgrade failed')
    }

    const withHash = {
        ...intent,
        pullTx: sent.result.txHash,
        signerNonce: sent.result.nonce,
        signerName: sent.result.signerName,
    }
    await writePaidUpgradeFee(args.env, args.chainId, args.quoteSignature, withHash, 'update')
    return finishPull(args, sent.result.txHash, balanceBefore, withHash)
}

async function resumePull(
    args: {
        env: Env
        chainId: number
        publicClient: PublicClient
        usdc: Address
        from: Address
        to: Address
        fee: bigint
        nonce: Hex
        bundleId: string
        quoteSignature: Hex
    },
    hash: Hex,
    record: PaidUpgradeFeeRecord,
): Promise<PaidUpgradeFeeRecord> {
    const balanceNow = await balanceOf(args.publicClient, args.usdc, args.to)
    return finishPull(args, hash, balanceNow, record)
}

async function finishPull(
    args: {
        env: Env
        chainId: number
        publicClient: PublicClient
        usdc: Address
        from: Address
        to: Address
        fee: bigint
        nonce: Hex
        bundleId: string
        quoteSignature: Hex
    },
    hash: Hex,
    balanceBefore: bigint,
    record: PaidUpgradeFeeRecord,
): Promise<PaidUpgradeFeeRecord> {
    let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
    try {
        receipt = await args.publicClient.waitForTransactionReceipt({
            hash,
            timeout: paidUpgradeReceiptWaitMs(args.env),
        })
    } catch (error) {
        logger.error({ error, hash }, 'paid upgrade fee pull receipt unavailable')
        try {
            await enqueuePaidUpgradeReceipt(args.env, args.chainId, hash, {
                nonce: record.signerNonce,
                signerName: record.signerName,
            })
        } catch (enqueueError) {
            logger.error({ error: enqueueError, hash }, 'paid upgrade fee pull was not queued for reconcile')
        }
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade fee pull failed')
    }
    const balanceAfter = await balanceOf(args.publicClient, args.usdc, args.to)
    const ok = feePullConfirmed({
        status: receipt.status,
        logs: receipt.logs,
        usdc: args.usdc,
        from: args.from,
        to: args.to,
        value: args.fee,
        balanceBefore,
        balanceAfter,
    })
    if (!ok) {
        const failed = feeRecord({
            status: 'pull_failed',
            fee: args.fee,
            from: args.from,
            to: args.to,
            nonce: args.nonce,
            bundleId: args.bundleId,
            pullTx: hash,
            signerNonce: record.signerNonce,
            signerName: record.signerName,
        })
        await writePaidUpgradeFee(args.env, args.chainId, args.quoteSignature, failed, 'update')
        await settlePaidUpgradeGas(args.env, args.chainId, {
            gasUsed: receipt.gasUsed,
            failure: true,
            txHash: hash,
        })
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade fee pull failed')
    }
    const collected = feeRecord({
        status: 'fee_collected',
        fee: args.fee,
        from: args.from,
        to: args.to,
        nonce: args.nonce,
        bundleId: args.bundleId,
        pullTx: hash,
        signerNonce: record.signerNonce,
        signerName: record.signerName,
    })
    await writePaidUpgradeFee(args.env, args.chainId, args.quoteSignature, collected, 'update')
    await settlePaidUpgradeGas(args.env, args.chainId, {
        gasUsed: receipt.gasUsed,
        failure: false,
        txHash: hash,
    })
    return collected
}

async function settlePendingUpgrade(
    env: Env,
    chainId: number,
    publicClient: PublicClient,
    quoteSignature: Hex,
    record: PaidUpgradeFeeRecord,
): Promise<'confirmed' | 'landed' | 'failed' | 'pending'> {
    if (!record.upgradeTx) return 'pending'
    let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
    try {
        receipt = await publicClient.waitForTransactionReceipt({
            hash: record.upgradeTx,
            timeout: paidUpgradeReceiptWaitMs(env),
        })
    } catch (error) {
        logger.error({ error, hash: record.upgradeTx }, 'paid upgrade pending receipt unavailable')
        try {
            await enqueuePaidUpgradeReceipt(env, chainId, record.upgradeTx, {
                nonce: record.signerNonce,
                signerName: record.signerName,
            })
        } catch (enqueueError) {
            logger.error(
                { error: enqueueError, hash: record.upgradeTx },
                'paid upgrade receipt was not queued for reconcile',
            )
        }
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    return notePaidUpgradeReceipt(env, chainId, quoteSignature, record, receipt.status, receipt.gasUsed, receipt)
}

export async function notePaidUpgradeSubmitted(
    env: Env,
    chainId: number,
    quoteSignature: Hex,
    record: PaidUpgradeFeeRecord,
    upgradeTx: Hex,
    broadcast?: { nonce?: number; signerName?: string },
): Promise<void> {
    await writePaidUpgradeFee(
        env,
        chainId,
        quoteSignature,
        {
            ...record,
            status: 'upgrade_pending',
            upgradeTx,
            ...(broadcast?.nonce !== undefined ? { signerNonce: broadcast.nonce } : {}),
            ...(broadcast?.signerName ? { signerName: broadcast.signerName } : {}),
        },
        'update',
    )
}

export async function notePaidUpgradeReceipt(
    env: Env,
    chainId: number,
    quoteSignature: Hex,
    record: PaidUpgradeFeeRecord,
    status: string,
    gasUsed: bigint,
    receipt: { logs: ReadonlyArray<{ data: Hex; topics: readonly Hex[] }> },
): Promise<'confirmed' | 'landed' | 'failed'> {
    const outcome = paidUpgradeReceiptOutcome({
        status: status === 'success' ? 'success' : 'reverted',
        gasUsed,
        logs: receipt.logs as never,
    })
    const landed = status === 'success'
    const next: PaidUpgradeFeeStatus = !landed
        ? 'upgrade_failed'
        : outcome.failure
          ? 'upgrade_landed'
          : 'upgrade_confirmed'
    await writePaidUpgradeFee(
        env,
        chainId,
        quoteSignature,
        { ...record, status: next, upgradeTx: record.upgradeTx },
        'update',
    )
    await settlePaidUpgradeGas(env, chainId, {
        gasUsed,
        failure: outcome.failure || !landed,
        ...(record.upgradeTx ? { txHash: record.upgradeTx } : {}),
    })
    if (!landed) return 'failed'
    return outcome.failure ? 'landed' : 'confirmed'
}
