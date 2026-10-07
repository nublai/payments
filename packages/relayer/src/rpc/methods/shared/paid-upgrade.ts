import {
    encodeAbiParameters,
    erc20Abi,
    getAddress,
    zeroAddress,
    type Address,
    type Hex,
    type PublicClient,
    type SignedAuthorization,
} from 'viem'

import type { Env } from '../../../types/env'
import { getChainConfig as getChainAssetsConfig } from '../../../config/chains'
import { logger } from '../../../lib/logger'
import { isEip7702Delegated } from '../../../lib/viem-utils'
import {
    RpcError,
    INVALID_PARAMS,
    INVALID_SIGNATURE,
    INSUFFICIENT_FUNDS,
    RATE_LIMITED,
    SERVICE_UNAVAILABLE,
} from '../../errors'
import type {
    PaidUpgradeAuthorization,
    PaidUpgradePreCall,
    PaidUpgradeQuote,
    Quote,
} from '../../schema/prepareCalls'
import { getSignerPool } from './signer-pool'
import {
    assertAllowedUpgradePreCall,
    authorizationSignerMatchesAccount,
    parseSignature,
} from './account-helpers'
import type { RateBucket } from './upgrade-rate-limit'

export type PaidUpgradeRateAction = 'peek' | 'commit' | 'reserve' | 'release'

/**
 * Per-address buckets for the user-paid first upgrade.
 * These keys are not the sponsored identity buckets. A new address gets a
 * fresh window, so the limit is sybil-able; it only stops one address from
 * looping the relayer.
 */
export function paidUpgradeRateBuckets(input: { chainId: number; account: string }): RateBucket[] {
    return [
        {
            key: `paid-upgrade:address:${input.chainId}:${input.account.toLowerCase()}`,
            limit: PAID_UPGRADE_ADDRESS_LIMIT,
            windowSeconds: PAID_UPGRADE_WINDOW_SECONDS,
        },
    ]
}

/**
 * 10 USDC in 6-decimal base units.
 *
 * A third party can rebroadcast the signed intent with its own
 * `paymentRecipient` and with `paymentAmount` set up to `paymentMaxAmount`
 * (the intent digest does not cover either field). This cap is the most USDC
 * that broadcast can pull. A first upgrade on Base is well under $1 at
 * observed gas; 10 USDC sits about an order of magnitude above that quote and
 * far below a typical balance. If the honest quote exceeds the cap, prepare
 * refuses and the account uses the sponsored path.
 *
 * `PAID_UPGRADE_MAX_PAYMENT` overrides the default in base units.
 */
export const DEFAULT_PAID_UPGRADE_MAX_PAYMENT = 10_000_000n

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

export const PAID_UPGRADE_WINDOW_SECONDS = 10 * 60

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
    const raw = env.PAID_UPGRADE_MAX_PAYMENT?.trim()
    if (!raw) return DEFAULT_PAID_UPGRADE_MAX_PAYMENT
    if (!/^[0-9]+$/.test(raw) || raw === '0') {
        throw new RpcError(SERVICE_UNAVAILABLE, 'PAID_UPGRADE_MAX_PAYMENT is invalid')
    }
    return BigInt(raw)
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
    input: { action: PaidUpgradeRateAction; account: string; reservedAt?: number },
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
): Promise<void> {
    const result = await postPaidUpgradeRateLimit(env, chainId, {
        action: 'peek',
        account,
    })
    if (!result.allowed) {
        throw new RpcError(RATE_LIMITED, 'Paid upgrade rate limit exceeded')
    }
}

export async function recordPaidUpgradeRateLimit(
    env: Env,
    chainId: number,
    account: string,
): Promise<void> {
    try {
        const result = await postPaidUpgradeRateLimit(env, chainId, {
            action: 'commit',
            account,
        })
        if (!result.allowed) {
            logger.warn({ chainId, account }, 'paid upgrade rate limit commit rejected')
        }
    } catch (error) {
        logger.error({ error, chainId }, 'paid upgrade rate limit commit failed')
    }
}

export async function reservePaidUpgradeRateLimit(
    env: Env,
    chainId: number,
    account: string,
): Promise<number> {
    const result = await postPaidUpgradeRateLimit(env, chainId, {
        action: 'reserve',
        account,
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
    reservedAt: number,
): Promise<void> {
    try {
        await postPaidUpgradeRateLimit(env, chainId, {
            action: 'release',
            account,
            reservedAt,
        })
    } catch (error) {
        logger.error({ error, chainId }, 'paid upgrade rate limit release failed')
    }
}
