import {
    decodeEventLog,
    encodeAbiParameters,
    encodeFunctionData,
    erc20Abi,
    getAddress,
    zeroAddress,
    type Address,
    type Hex,
    type PublicClient,
    type SignedAuthorization,
    type TransactionReceipt,
} from 'viem'
import { recoverTypedDataAddress } from 'viem/utils'
import { orchestratorAbi } from '@nubl/contracts/abis'

import type { Env } from '../../../types/env'
import { getChainConfig as getChainAssetsConfig } from '../../../config/chains'
import { isLocalDevContext } from '../../../config/runtime-context'
import { deriveRelayerSignerAddress } from '../../../lib/hd-signer'
import { selectSignerForEoa } from '../../../lib/pool-utils'
import { logger } from '../../../lib/logger'
import { isEip7702Delegated } from '../../../lib/viem-utils'
import {
    RpcError,
    INVALID_PARAMS,
    INVALID_SIGNATURE,
    INSUFFICIENT_FUNDS,
    RATE_LIMITED,
    SERVICE_UNAVAILABLE,
    CONTRACT_ERROR,
    decodeOrchestratorError,
    mapErrorNameToCode,
} from '../../errors'
import type {
    PaidUpgradeAuthorization,
    PaidUpgradePreCall,
    PaidUpgradeQuote,
    Quote,
} from '../../schema/prepareCalls'
import { getSignerPool } from './signer-pool'
import { encodeIntentCalldata } from '../../../services/encode-intent'
import { getPaymentRecipient } from '../../../services/fees'
import type { IntentStruct } from '../../../types/pool'
import { INTENT_TYPES } from '../../schema/intentTypes'
import {
    assertAllowedUpgradePreCall,
    authorizationSignerMatchesAccount,
    parseSignature,
} from './account-helpers'
import { ipv6Prefix56, upgradeClientIp, type RateBucket } from './upgrade-rate-limit'

export type PaidUpgradeRateAction = 'peek' | 'commit' | 'reserve' | 'release'

/**
 * Paid-upgrade windows. These keys are not the sponsored identity buckets.
 * Address, IP, and IPv6 /56 share one 10 minute window on prepare and send.
 * The chain total counts sends only (`includeGlobal`). Prepares do not take
 * a global slot. On local, a missing IP is the `unknown` bucket. Stage and
 * prod refuse that request before a bucket is written.
 */
export function paidUpgradeRateBuckets(input: {
    chainId: number
    account: string
    ip: string
    globalLimit?: number
    /** Send reserve and release. Prepare peek and commit omit the chain bucket. */
    includeGlobal?: boolean
}): RateBucket[] {
    const globalLimit = input.globalLimit ?? DEFAULT_PAID_UPGRADE_GLOBAL_LIMIT
    const buckets: RateBucket[] = [
        {
            key: `paid-upgrade:address:${input.chainId}:${input.account.toLowerCase()}`,
            limit: PAID_UPGRADE_ADDRESS_LIMIT,
            windowSeconds: PAID_UPGRADE_WINDOW_SECONDS,
        },
        {
            key: `paid-upgrade:ip:${input.chainId}:${input.ip}`,
            limit: PAID_UPGRADE_IP_LIMIT,
            windowSeconds: PAID_UPGRADE_WINDOW_SECONDS,
        },
    ]
    const prefix56 = ipv6Prefix56(input.ip)
    if (prefix56) {
        buckets.push({
            key: `paid-upgrade:ip56:${input.chainId}:${prefix56}`,
            limit: PAID_UPGRADE_IP_LIMIT,
            windowSeconds: PAID_UPGRADE_WINDOW_SECONDS,
        })
    }
    if (input.includeGlobal) {
        buckets.push({
            key: `paid-upgrade:global:${input.chainId}`,
            limit: globalLimit,
            windowSeconds: PAID_UPGRADE_WINDOW_SECONDS,
        })
    }
    return buckets
}

/**
 * Stage and prod require `cf-connecting-ip`. Local and dev keep the shared
 * `unknown` bucket so a dev worker without the Cloudflare header still runs.
 */
export function requirePaidUpgradeClientIp(
    request: Request | undefined,
    env: { CONTEXT?: string },
): string {
    const ip = upgradeClientIp(request)
    if (ip === 'unknown' && !isLocalDevContext(env)) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade client IP is required')
    }
    return ip
}

/**
 * 5 USDC in 6-decimal base units. Same ceiling as the wallet `PAID_FEE_CAP`.
 *
 * The value signed into `paymentMaxAmount` is the quoted fee plus 5%, not
 * this ceiling. A third party can still set `paymentAmount` up to that signed
 * max and choose `paymentRecipient`. Measured first-upgrade quotes are about
 * 1.15–1.40 USDC, so quote+5% stays under 5 USDC. A quote that does not fit
 * is refused and the account uses the sponsored path.
 *
 * `PAID_UPGRADE_MAX_PAYMENT` overrides the default in base units.
 */
export const DEFAULT_PAID_UPGRADE_MAX_PAYMENT = 5_000_000n

/**
 * Same 500 bps margin as `signedPaymentMaxForQuote` in relayer-client.
 * The 0.001 USDC floor matches FEE_CAP_MARGIN_FLOOR there.
 */
const PAID_UPGRADE_FEE_MARGIN_BPS = 500n
const PAID_UPGRADE_FEE_MARGIN_FLOOR = 1_000n

export function signedPaymentMaxForQuote(paymentAmount: bigint): bigint {
    if (paymentAmount <= 0n) return 0n
    const percent = (paymentAmount * PAID_UPGRADE_FEE_MARGIN_BPS + 9_999n) / 10_000n
    const margin =
        percent > PAID_UPGRADE_FEE_MARGIN_FLOOR ? percent : PAID_UPGRADE_FEE_MARGIN_FLOOR
    return paymentAmount + margin
}

export function clampPaidUpgradePaymentMax(input: {
    paymentAmount: bigint
    clientMax?: bigint
    ceiling: bigint
}): bigint {
    if (input.paymentAmount <= 0n) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee must be greater than zero')
    }
    const quoted = signedPaymentMaxForQuote(input.paymentAmount)
    if (input.paymentAmount > input.ceiling || quoted > input.ceiling) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade paymentMaxAmount exceeds cap')
    }
    if (input.clientMax === undefined) return quoted
    if (input.clientMax < input.paymentAmount) {
        throw new RpcError(
            INVALID_PARAMS,
            `Payment amount ${input.paymentAmount} exceeds max ${input.clientMax}`,
        )
    }
    return input.clientMax < quoted ? input.clientMax : quoted
}

/**
 * Per EIP-7702 authorization added to `txGas`.
 *
 * Measured on Anvil 1.5.1 (chain 31337) as the `eth_estimateGas` delta of the
 * same call with one `authorizationList` entry versus none:
 * - fresh authority, nonce 0: 25,001
 * - authority nonce 2 with short calldata: 24,952
 *
 * 25,000 is that per-authorization charge. Calldata and warm/cold noise of a
 * few dozen gas is already inside the existing tx buffers. Pre-call execution
 * is not included here: `Simulator.simulateGasUsed` runs `encodedPreCalls`, so
 * that gas is already in `simulationGas` and therefore in `txGas`.
 */
export const PAID_UPGRADE_AUTHORIZATION_GAS = 25_000n

/** Successful paid-upgrade prepares and broadcasts per address per 10 minutes. */
export const PAID_UPGRADE_ADDRESS_LIMIT = 3

/**
 * Per caller and per IPv6 /56 per 10 minutes. One NAT can rotate EOAs, so
 * this sits well under the sponsored upgrade IP ceiling of 100. There is no
 * identity on this path to bind the caller.
 */
export const PAID_UPGRADE_IP_LIMIT = 8

/**
 * Paid-upgrade sends per chain per 10 minutes. Prepares do not count.
 * Sponsored upgrades allow 2,000. Sixty sends is G's launch ceiling
 * (raised from 20 on 2026-10-07). `PAID_UPGRADE_GLOBAL_LIMIT` overrides it.
 */
export const DEFAULT_PAID_UPGRADE_GLOBAL_LIMIT = 60

/**
 * Gas units reserved before a paid-upgrade broadcast, and the maximum
 * type-4 gas limit that broadcast may sign. Measured on Anvil for an honest
 * upgrade (type-4 `execute`, fee pulled inside that transaction): `gasUsed`
 * 279,862 and `eth_estimateGas` 456,207. Both sit under 500,000. A quote
 * whose estimate is higher is refused. The receipt settles the hold down to
 * `gasUsed`, which cannot exceed the signed limit.
 */
export const PAID_UPGRADE_GAS_HOLD = 500_000n

/**
 * Gas limit signed for a paid-upgrade type-4. Equal to the estimate when
 * that estimate fits in the reserved hold. Above the hold, refuse. The
 * sponsored path keeps the separate 1,500,000 cap.
 */
export function paidUpgradeSignedGas(estimate: bigint): bigint {
    if (estimate <= 0n || estimate > PAID_UPGRADE_GAS_HOLD) {
        throw new Error('Paid upgrade gas limit exceeds the reserved hold')
    }
    return estimate
}

/**
 * Gas units one chain may spend on paid-upgrade broadcasts per UTC day.
 * About seven honest upgrades at the measured ~280k, or about thirty 60k
 * sweep receipts. At ~1 gwei that is about $6; at the 100 gwei refusal cap
 * it is 0.2 ETH, about $600. `PAID_UPGRADE_DAILY_GAS_BUDGET` overrides it.
 * An unreadable budget refuses the broadcast.
 */
export const DEFAULT_PAID_UPGRADE_DAILY_GAS_BUDGET = 2_000_000n

export const PAID_UPGRADE_WINDOW_SECONDS = 10 * 60

/** Receipt wait before the hold is left for the reconciler. Unset is 20 seconds. */
export function paidUpgradeReceiptWaitMs(env: { PAID_UPGRADE_RECEIPT_WAIT_MS?: string }): number {
    const text = env.PAID_UPGRADE_RECEIPT_WAIT_MS?.trim()
    if (!text) return 20_000
    if (!/^[0-9]+$/.test(text)) return 20_000
    const parsed = Number(text)
    if (!Number.isSafeInteger(parsed) || parsed < 1) return 20_000
    return parsed
}

export type { PaidUpgradeAuthorization, PaidUpgradePreCall, PaidUpgradeQuote }

export function eip7702DelegationCode(accountProxy: Address): Hex {
    return `0xef0100${getAddress(accountProxy).slice(2).toLowerCase()}` as Hex
}

export function chainUsdcAddress(chainId: number): Address {
    const assets = getChainAssetsConfig(chainId)
    const usdc = assets?.assets.usdc
    if (!usdc?.feeToken || !usdc.address) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'USDC fee token is not configured')
    }
    return getAddress(usdc.address as Address)
}

export function paidUpgradeMaxPayment(env: { PAID_UPGRADE_MAX_PAYMENT?: string }): bigint {
    return readPaidUpgradeBig(env.PAID_UPGRADE_MAX_PAYMENT, DEFAULT_PAID_UPGRADE_MAX_PAYMENT, 'PAID_UPGRADE_MAX_PAYMENT')
}

export function paidUpgradeGlobalLimit(env: { PAID_UPGRADE_GLOBAL_LIMIT?: string }): number {
    const value = readPaidUpgradeBig(
        env.PAID_UPGRADE_GLOBAL_LIMIT,
        BigInt(DEFAULT_PAID_UPGRADE_GLOBAL_LIMIT),
        'PAID_UPGRADE_GLOBAL_LIMIT',
    )
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'PAID_UPGRADE_GLOBAL_LIMIT is invalid')
    }
    return Number(value)
}

export function paidUpgradeDailyGasBudget(env: { PAID_UPGRADE_DAILY_GAS_BUDGET?: string }): bigint {
    return readPaidUpgradeBig(
        env.PAID_UPGRADE_DAILY_GAS_BUDGET,
        DEFAULT_PAID_UPGRADE_DAILY_GAS_BUDGET,
        'PAID_UPGRADE_DAILY_GAS_BUDGET',
    )
}

function readPaidUpgradeBig(raw: string | undefined, fallback: bigint, label: string): bigint {
    const text = raw?.trim()
    if (!text) return fallback
    if (!/^[0-9]+$/.test(text) || text === '0') {
        throw new RpcError(SERVICE_UNAVAILABLE, `${label} is invalid`)
    }
    return BigInt(text)
}

/** `abi.encode(SignedCall)` — the bytes Orchestrator stores in `encodedPreCalls`. */
export function encodeSignedPreCall(preCall: PaidUpgradePreCall): Hex {
    return encodeAbiParameters(
        [
            {
                type: 'tuple',
                components: [
                    { name: 'eoa', type: 'address' },
                    { name: 'executionData', type: 'bytes' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'signature', type: 'bytes' },
                ],
            },
        ],
        [
            {
                eoa: getAddress(preCall.eoa),
                executionData: preCall.executionData,
                nonce: BigInt(preCall.nonce),
                signature: preCall.signature,
            },
        ],
    )
}

export function paidUpgradeFromQuote(quote: Quote | undefined): PaidUpgradeQuote | undefined {
    return quote?.accountUpgrade
}

function sameHex(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase()
}

export function paidUpgradeFieldsMatch(left: PaidUpgradeQuote, right: PaidUpgradeQuote): boolean {
    const auth = left.authorization
    const otherAuth = right.authorization
    const preCall = left.preCall
    const otherPreCall = right.preCall
    return (
        getAddress(auth.contractAddress) === getAddress(otherAuth.contractAddress) &&
        auth.chainId === otherAuth.chainId &&
        auth.nonce === otherAuth.nonce &&
        sameHex(auth.signature, otherAuth.signature) &&
        getAddress(preCall.eoa) === getAddress(otherPreCall.eoa) &&
        sameHex(preCall.executionData, otherPreCall.executionData) &&
        preCall.nonce === otherPreCall.nonce &&
        sameHex(preCall.signature, otherPreCall.signature)
    )
}

export interface CheckedPaidUpgrade {
    quote: PaidUpgradeQuote
    encodedPreCalls: Hex[]
    authorization: SignedAuthorization
    paymentAmount: bigint
}

/**
 * Checks that are true at prepare time and again at send time. The quote HMAC
 * binds the authorization and pre-call; these checks still run so a quote
 * signed with the relayer secret cannot broadcast a different delegation.
 */
export async function assertPaidUpgrade(args: {
    eoa: Address
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: string
    upgrade: PaidUpgradeQuote
    encodedPreCalls?: Hex[]
    chainId: number
    orchestrator: Address
    accountProxy: Address
    usdc: Address
    maxPayment: bigint
    paymentAmount: bigint
    publicClient: PublicClient
}): Promise<CheckedPaidUpgrade> {
    const eoa = getAddress(args.eoa)
    const payer = args.payer ? getAddress(args.payer) : zeroAddress
    if (payer !== eoa) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade payer must be the account')
    }

    const paymentToken = args.paymentToken ? getAddress(args.paymentToken) : zeroAddress
    if (paymentToken === zeroAddress || paymentToken !== getAddress(args.usdc)) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade requires the USDC fee token')
    }

    const authorization = args.upgrade.authorization
    const delegation = getAddress(authorization.contractAddress)
    if (!Number.isInteger(authorization.chainId) || authorization.chainId !== args.chainId) {
        throw new RpcError(INVALID_PARAMS, 'Authorization chain id does not match the request')
    }
    if (!Number.isInteger(authorization.nonce) || authorization.nonce < 0) {
        throw new RpcError(INVALID_PARAMS, 'Invalid authorization nonce')
    }
    if (delegation !== getAddress(args.accountProxy)) {
        throw new RpcError(INVALID_PARAMS, 'Delegation target is not the account proxy')
    }

    let parsedAuth: { r: Hex; s: Hex; yParity: number }
    try {
        parsedAuth = parseSignature(authorization.signature)
    } catch (error) {
        if (error instanceof RpcError) throw error
        throw new RpcError(INVALID_PARAMS, 'Failed to parse auth signature')
    }

    const authorizationMatches = await authorizationSignerMatchesAccount({
        account: eoa,
        contractAddress: delegation,
        chainId: args.chainId,
        nonce: authorization.nonce,
        signature: authorization.signature,
    })
    if (!authorizationMatches) {
        throw new RpcError(INVALID_SIGNATURE, 'Invalid authorization signature')
    }

    const allowedPreCall = await assertAllowedUpgradePreCall({
        account: eoa,
        chainId: args.chainId,
        orchestrator: args.orchestrator,
        executionData: args.upgrade.preCall.executionData,
        eoa: args.upgrade.preCall.eoa,
        nonce: args.upgrade.preCall.nonce,
        execSignature: args.upgrade.preCall.signature,
    })
    if (!allowedPreCall) {
        throw new RpcError(INVALID_PARAMS, 'Upgrade preCall is not allowed')
    }

    const encoded = encodeSignedPreCall({
        eoa: allowedPreCall.eoa,
        executionData: allowedPreCall.executionData,
        nonce: allowedPreCall.nonce,
        signature: allowedPreCall.signature,
    })
    const quotedPreCalls = args.encodedPreCalls ?? []
    if (quotedPreCalls.length !== 1 || !sameHex(quotedPreCalls[0], encoded)) {
        throw new RpcError(INVALID_PARAMS, 'Authorization or pre-call does not match the quote')
    }

    let paymentMaxAmount: bigint
    try {
        paymentMaxAmount = BigInt(args.paymentMaxAmount ?? '0')
    } catch {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade paymentMaxAmount is required')
    }
    if (paymentMaxAmount <= 0n) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade paymentMaxAmount is required')
    }
    if (paymentMaxAmount > args.maxPayment) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade paymentMaxAmount exceeds cap')
    }
    if (args.paymentAmount <= 0n) {
        throw new RpcError(INVALID_PARAMS, 'Paid upgrade fee must be greater than zero')
    }
    if (args.paymentAmount > paymentMaxAmount) {
        throw new RpcError(
            INVALID_PARAMS,
            `Payment amount ${args.paymentAmount} exceeds max ${paymentMaxAmount}`,
        )
    }
    const quotedMax = signedPaymentMaxForQuote(args.paymentAmount)
    if (quotedMax > args.maxPayment || paymentMaxAmount > quotedMax) {
        throw new RpcError(
            INVALID_PARAMS,
            quotedMax > args.maxPayment
                ? 'Paid upgrade paymentMaxAmount exceeds cap'
                : 'Paid upgrade paymentMaxAmount exceeds the quoted fee cap',
        )
    }

    let code: Hex | undefined
    let pendingNonce: number
    try {
        code = await args.publicClient.getCode({ address: eoa })
        pendingNonce = await args.publicClient.getTransactionCount({
            address: eoa,
            blockTag: 'pending',
        })
    } catch (error) {
        logger.error({ error, address: eoa }, 'failed to read account before paid upgrade')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    if (isEip7702Delegated(code)) {
        throw new RpcError(INVALID_PARAMS, 'Account is already delegated')
    }
    if (pendingNonce !== authorization.nonce) {
        throw new RpcError(INVALID_PARAMS, 'Authorization nonce does not match the account nonce')
    }

    let balance: bigint
    try {
        balance = await args.publicClient.readContract({
            address: args.usdc,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [eoa],
        })
    } catch (error) {
        logger.error({ error, address: eoa }, 'failed to read USDC balance before paid upgrade')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    if (balance < args.paymentAmount) {
        throw new RpcError(INSUFFICIENT_FUNDS, 'Insufficient USDC balance')
    }

    const normalized: PaidUpgradeQuote = {
        authorization: {
            contractAddress: delegation,
            chainId: args.chainId,
            nonce: authorization.nonce,
            signature: authorization.signature,
        },
        preCall: {
            eoa: allowedPreCall.eoa,
            executionData: allowedPreCall.executionData,
            nonce: allowedPreCall.nonce,
            signature: allowedPreCall.signature,
        },
    }

    return {
        quote: normalized,
        encodedPreCalls: [encoded],
        authorization: {
            address: delegation,
            chainId: args.chainId,
            nonce: authorization.nonce,
            r: parsedAuth.r,
            s: parsedAuth.s,
            yParity: parsedAuth.yParity,
        },
        paymentAmount: args.paymentAmount,
    }
}

async function postPaidUpgradeRateLimit(
    env: Env,
    chainId: number,
    input: { action: PaidUpgradeRateAction; account: string; ip: string; reservedAt?: number },
): Promise<{ allowed: boolean; reservedAt?: number }> {
    const pool = getSignerPool(env, chainId)
    let response: Response
    try {
        response = await pool.fetch(`http://do/upgrade-rate-limit?poolName=pool-${chainId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: input.action,
                kind: 'paid-upgrade',
                chainId,
                account: input.account,
                ip: input.ip,
                ...(input.reservedAt !== undefined ? { reservedAt: input.reservedAt } : {}),
            }),
        })
    } catch (error) {
        logger.error({ error, chainId }, 'paid upgrade rate limit unavailable')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }

    if (!response.ok) {
        logger.error({ chainId, status: response.status }, 'paid upgrade rate limit failed')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }

    const result = (await response.json()) as { allowed?: boolean; reservedAt?: number }
    return {
        allowed: result.allowed === true,
        reservedAt: typeof result.reservedAt === 'number' ? result.reservedAt : undefined,
    }
}

export async function assertPaidUpgradeRateCapacity(
    env: Env,
    chainId: number,
    account: string,
    ip: string,
): Promise<void> {
    const result = await postPaidUpgradeRateLimit(env, chainId, {
        action: 'peek',
        account,
        ip,
    })
    if (!result.allowed) {
        throw new RpcError(RATE_LIMITED, 'Paid upgrade rate limit exceeded')
    }
}

export async function recordPaidUpgradeRateLimit(
    env: Env,
    chainId: number,
    account: string,
    ip: string,
): Promise<void> {
    const result = await postPaidUpgradeRateLimit(env, chainId, {
        action: 'commit',
        account,
        ip,
    })
    if (!result.allowed) {
        throw new RpcError(RATE_LIMITED, 'Paid upgrade rate limit exceeded')
    }
}

export async function reservePaidUpgradeRateLimit(
    env: Env,
    chainId: number,
    account: string,
    ip: string,
): Promise<number> {
    const result = await postPaidUpgradeRateLimit(env, chainId, {
        action: 'reserve',
        account,
        ip,
    })
    if (!result.allowed) {
        throw new RpcError(RATE_LIMITED, 'Paid upgrade rate limit exceeded')
    }
    return result.reservedAt ?? Math.floor(Date.now() / 1000)
}

export async function releasePaidUpgradeRateLimit(
    env: Env,
    chainId: number,
    account: string,
    ip: string,
    reservedAt: number,
): Promise<void> {
    try {
        await postPaidUpgradeRateLimit(env, chainId, {
            action: 'release',
            account,
            ip,
            reservedAt,
        })
    } catch (error) {
        logger.error({ error, chainId }, 'paid upgrade rate limit release failed')
    }
}

async function postPaidUpgradeGas(
    env: Env,
    chainId: number,
    body: Record<string, unknown>,
): Promise<{ allowed: boolean; gas?: number; failures?: number; overBudget?: boolean; pending?: Hex[] }> {
    const pool = getSignerPool(env, chainId)
    let response: Response
    try {
        response = await pool.fetch(`http://do/upgrade-rate-limit?poolName=pool-${chainId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'paid-upgrade', chainId, ...body }),
        })
    } catch (error) {
        logger.error({ error, chainId }, 'paid upgrade gas budget unavailable')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    if (!response.ok) {
        logger.error({ chainId, status: response.status }, 'paid upgrade gas budget failed')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    const result = (await response.json()) as {
        allowed?: boolean
        gas?: number
        failures?: number
        overBudget?: boolean
        pending?: unknown
    }
    const pending = Array.isArray(result.pending)
        ? result.pending.filter((hash): hash is Hex => typeof hash === 'string')
        : undefined
    return {
        allowed: result.allowed === true,
        gas: typeof result.gas === 'number' ? result.gas : undefined,
        failures: typeof result.failures === 'number' ? result.failures : undefined,
        overBudget: result.overBudget === true,
        pending,
    }
}

export async function reservePaidUpgradeGas(env: Env, chainId: number): Promise<void> {
    paidUpgradeDailyGasBudget(env)
    const result = await postPaidUpgradeGas(env, chainId, {
        action: 'reserve-gas',
        gas: PAID_UPGRADE_GAS_HOLD.toString(),
    })
    if (!result.allowed) {
        throw new RpcError(RATE_LIMITED, 'Paid upgrade gas budget exceeded')
    }
}

export async function releasePaidUpgradeGas(env: Env, chainId: number): Promise<void> {
    try {
        await postPaidUpgradeGas(env, chainId, {
            action: 'release-gas',
            gas: PAID_UPGRADE_GAS_HOLD.toString(),
        })
    } catch (error) {
        logger.error({ error, chainId }, 'paid upgrade gas budget release failed')
    }
}

/**
 * Settle a broadcast that landed. A success receipt whose IntentExecuted
 * error is non-zero (PaymentError, VerificationError) keeps the gas and
 * increments the failure count. The rate-limit slot is not released.
 */
export async function settlePaidUpgradeGas(
    env: Env,
    chainId: number,
    input: { gasUsed: bigint; failure: boolean; txHash?: Hex },
): Promise<void> {
    const result = await postPaidUpgradeGas(env, chainId, {
        action: 'settle-gas',
        hold: PAID_UPGRADE_GAS_HOLD.toString(),
        gas: input.gasUsed.toString(),
        failure: input.failure,
        ...(input.txHash ? { txHash: input.txHash } : {}),
    })
    if (result.overBudget) {
        logger.error(
            { chainId, gas: result.gas, txHash: input.txHash },
            'paid upgrade settle exceeded the daily gas budget',
        )
        return
    }
    if (!result.allowed) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
}

/** Remember a broadcast whose receipt was not in hand, so a later lookup can settle or release the hold. */
export async function enqueuePaidUpgradeReceipt(
    env: Env,
    chainId: number,
    txHash: Hex,
): Promise<void> {
    const result = await postPaidUpgradeGas(env, chainId, {
        action: 'enqueue-receipt',
        txHash,
    })
    if (!result.allowed) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
}

/**
 * The signer `selectSignerForEoa` will try first. Simulation uses this
 * address as `from` and as the fee-recipient fallback.
 */
export function paidUpgradeBroadcasterAddress(
    env: { RELAYER_MNEMONIC?: string; RELAYER_COUNT?: string },
    eoa: Address,
): Address {
    const mnemonic = env.RELAYER_MNEMONIC?.trim()
    if (!mnemonic) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    const signerCount = Number.parseInt(env.RELAYER_COUNT ?? '1', 10)
    if (!Number.isInteger(signerCount) || signerCount < 1 || signerCount > 100) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    try {
        return deriveRelayerSignerAddress(mnemonic, selectSignerForEoa(eoa, signerCount))
    } catch (error) {
        logger.error({ error }, 'paid upgrade signer derivation failed')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
}

/** Ask the signer pool to look up broadcasts whose receipt wait timed out. */
export async function requestPaidUpgradeReconcile(env: Env, chainId: number): Promise<void> {
    try {
        await postPaidUpgradeGas(env, chainId, { action: 'reconcile-pending' })
    } catch (error) {
        logger.error({ error, chainId }, 'paid upgrade gas reconcile failed')
    }
}

function intentDigestMessage(intent: IntentStruct) {
    return {
        multichain: false,
        eoa: getAddress(intent.eoa),
        calls: intent.calls.map((call) => ({
            to: getAddress(call.to),
            value: BigInt(call.value ?? 0),
            data: (call.data ?? '0x') as Hex,
        })),
        nonce: BigInt(intent.nonce),
        payer: getAddress(intent.payer ?? zeroAddress),
        paymentToken: getAddress(intent.paymentToken ?? zeroAddress),
        paymentMaxAmount: BigInt(intent.paymentMaxAmount ?? 0),
        combinedGas: BigInt(intent.combinedGas),
        encodedPreCalls: (intent.encodedPreCalls ?? []) as Hex[],
        encodedFundTransfers: (intent.encodedFundTransfers ?? []) as Hex[],
        settler: getAddress(intent.settler ?? zeroAddress),
        expiry: BigInt(intent.expiry),
    }
}

/** The intent digest signer must be the EOA. A bad signature is not broadcast. */
export async function assertPaidUpgradeIntentSigner(args: {
    intent: IntentStruct
    chainId: number
    orchestrator: Address
}): Promise<void> {
    const signature = args.intent.signature
    if (!signature || signature === '0x') {
        throw new RpcError(INVALID_SIGNATURE, 'Intent signer is not the account')
    }
    let recovered: Address
    try {
        recovered = await recoverTypedDataAddress({
            domain: {
                name: 'Orchestrator',
                version: '0.5.5',
                chainId: args.chainId,
                verifyingContract: args.orchestrator,
            },
            types: INTENT_TYPES,
            primaryType: 'Intent',
            message: intentDigestMessage(args.intent),
            signature,
        })
    } catch (error) {
        if (error instanceof RpcError) throw error
        throw new RpcError(INVALID_SIGNATURE, 'Intent signer is not the account')
    }
    if (getAddress(recovered) !== getAddress(args.intent.eoa)) {
        throw new RpcError(INVALID_SIGNATURE, 'Intent signer is not the account')
    }
}

function storedExecuteSelector(data: Hex | undefined): Hex | undefined {
    if (!data || data === '0x' || data.length < 10) return undefined
    return `0x${data.slice(2, 10)}` as Hex
}

/**
 * `eth_call` the execute the signer will send, including authorizationList.
 * `from` is the relayer signer that will broadcast. Execution mode returns
 * the stored selector instead of reverting. Anything other than 0x00000000
 * is refused before broadcast.
 */
export async function assertPaidUpgradeSimulation(args: {
    publicClient: PublicClient
    orchestrator: Address
    intent: IntentStruct
    authorization: SignedAuthorization
    feeRecipient: string | undefined
    env: { RELAYER_MNEMONIC?: string; RELAYER_COUNT?: string }
}): Promise<void> {
    const broadcaster = paidUpgradeBroadcasterAddress(args.env, getAddress(args.intent.eoa))
    const intentForBroadcast: IntentStruct = {
        ...args.intent,
        paymentRecipient: getPaymentRecipient(args.feeRecipient, broadcaster),
    }
    const data = encodeFunctionData({
        abi: orchestratorAbi,
        functionName: 'execute',
        args: [encodeIntentCalldata(intentForBroadcast)],
    })
    let returned: Hex | undefined
    try {
        const result = await args.publicClient.call({
            account: broadcaster,
            to: args.orchestrator,
            data,
            authorizationList: [args.authorization],
        })
        returned = result.data
    } catch (error) {
        logger.error({ error }, 'paid upgrade simulation failed')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    const selector = storedExecuteSelector(returned)
    if (!selector) {
        throw new RpcError(SERVICE_UNAVAILABLE, 'Paid upgrade failed')
    }
    if (selector === '0x00000000') return
    const decoded = decodeOrchestratorError(selector)
    const name = decoded?.errorName ?? 'Unknown'
    const code = decoded ? mapErrorNameToCode(name) : CONTRACT_ERROR
    throw new RpcError(code, `Paid upgrade simulation failed: ${name}`, { selector })
}

export interface PaidUpgradeReceiptOutcome {
    failure: boolean
    errorName?: string
    selector?: Hex
    gasUsed: bigint
}

/**
 * A type-4 receipt with status success can still be unpaid. Orchestrator
 * emits IntentExecuted with the stored selector and does not revert.
 */
export function paidUpgradeReceiptOutcome(receipt: {
    status: TransactionReceipt['status']
    gasUsed: bigint
    logs: TransactionReceipt['logs']
}): PaidUpgradeReceiptOutcome {
    const gasUsed = receipt.gasUsed
    if (receipt.status !== 'success') {
        return { failure: true, errorName: 'Reverted', gasUsed }
    }
    for (const log of receipt.logs) {
        try {
            const decoded = decodeEventLog({
                abi: orchestratorAbi,
                data: log.data,
                topics: log.topics,
            })
            if (decoded.eventName !== 'IntentExecuted') continue
            const err = (decoded.args as { err?: Hex }).err
            if (!err || err === '0x00000000') {
                return { failure: false, gasUsed }
            }
            const named = decodeOrchestratorError(err)
            return {
                failure: true,
                errorName: named?.errorName ?? 'Unknown',
                selector: err,
                gasUsed,
            }
        } catch {
            continue
        }
    }
    return { failure: false, gasUsed }
}
