import {
    type Address,
    type Hex,
    type PublicClient,
    encodeFunctionData,
    keccak256,
    encodeAbiParameters,
    parseAbiParameters,
} from 'viem'
import { hashAuthorization, hashTypedData } from 'viem/utils'
import { accountAbi } from '@agentic-payments/contracts/abis'
import type { Env } from '../../../types/env'
import type { AuthorizeKey, SpendPeriod } from '../../schema/upgradeAccount'
import { INVALID_PARAMS, RpcError } from '../../errors'
import { getChainIds } from '../../../config'
import { parseHexChainId } from '../../../lib/rpc-utils'
import { isEip7702Delegated } from '../../../lib/viem-utils'

/**
 * Multichain nonce prefix (0xc1d0) - signals EIP-712 signing without chain ID.
 */
export const MULTICHAIN_NONCE_PREFIX = 0xc1d0n
const DELEGATION_CONFIRM_MAX_ATTEMPTS = 4
const DELEGATION_CONFIRM_INITIAL_DELAY_MS = 150
const DELEGATION_CONFIRM_MAX_DELAY_MS = 1000

/**
 * SignedCall EIP-712 types for signing.
 */
export const SIGNED_CALL_TYPES = {
    SignedCall: [
        { name: 'multichain', type: 'bool' },
        { name: 'eoa', type: 'address' },
        { name: 'calls', type: 'Call[]' },
        { name: 'nonce', type: 'uint256' },
    ],
    Call: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
    ],
} as const

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Confirm EIP-7702 delegation code with bounded retries to tolerate RPC lag.
 */
export async function waitForDelegationCode(
    publicClient: Pick<PublicClient, 'getCode'>,
    address: Address,
    blockNumber?: bigint,
    options?: {
        maxAttempts?: number
        initialDelayMs?: number
        maxDelayMs?: number
    },
): Promise<Hex | undefined> {
    const maxAttempts = options?.maxAttempts ?? DELEGATION_CONFIRM_MAX_ATTEMPTS
    const maxDelayMs = options?.maxDelayMs ?? DELEGATION_CONFIRM_MAX_DELAY_MS
    let delayMs = options?.initialDelayMs ?? DELEGATION_CONFIRM_INITIAL_DELAY_MS
    let lastCode: Hex | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let latestCode: Hex | undefined
        let blockCode: Hex | undefined

        try {
            latestCode = await publicClient.getCode({ address })
        } catch {
            // Ignore transient RPC errors and retry.
        }

        if (blockNumber !== undefined) {
            try {
                blockCode = await publicClient.getCode({ address, blockNumber })
            } catch {
                // Ignore transient RPC errors and retry.
            }
        }

        if (isEip7702Delegated(latestCode)) return latestCode
        if (isEip7702Delegated(blockCode)) return blockCode

        lastCode = latestCode ?? blockCode ?? lastCode
        if (attempt < maxAttempts) {
            await sleep(delayMs)
            delayMs = Math.min(delayMs * 2, maxDelayMs)
        }
    }

    return lastCode
}

/**
 * EIP-712 domain for SignedCall signing.
 */
export function getSignedCallDomain(chainId: number, orchestratorAddress: Address) {
    return {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId,
        verifyingContract: orchestratorAddress,
    }
}

/**
 * Compute the EIP-7702 authorization digest.
 */
export function computeAuthorizationDigest(chainId: number, address: Address, nonce: bigint): Hex {
    return hashAuthorization({
        contractAddress: address,
        chainId,
        nonce: Number(nonce),
    })
}

/**
 * Compute hash for an authorized key.
 */
export function computeKeyHash(key: AuthorizeKey): Hex {
    const keyType = key.type === 'secp256k1' ? 0 : 1
    const publicKeyHash = keccak256(key.publicKey)
    const encoded = encodeAbiParameters(parseAbiParameters('uint8, bytes32'), [
        keyType,
        publicKeyHash,
    ])
    return keccak256(encoded)
}

const SPEND_PERIOD_VALUES: Record<SpendPeriod, number> = {
    minute: 0,
    hour: 1,
    day: 2,
    week: 3,
    month: 4,
    year: 5,
    forever: 6,
}

const SPEND_PERIOD_NAMES: Record<number, SpendPeriod> = {
    0: 'minute',
    1: 'hour',
    2: 'day',
    3: 'week',
    4: 'month',
    5: 'year',
    6: 'forever',
}

/**
 * Convert SpendPeriod string to contract enum value.
 */
export function spendPeriodToNumber(period: SpendPeriod): number {
    return SPEND_PERIOD_VALUES[period]
}

/**
 * Convert contract enum value to SpendPeriod string.
 */
export function spendPeriodFromNumber(value: number): SpendPeriod {
    return SPEND_PERIOD_NAMES[value] ?? 'day'
}

/**
 * Build execution data for key initialization.
 */
export function buildKeyInitializationData(
    keys: AuthorizeKey[],
    accountAddress: Address,
): { calls: Array<{ to: Address; value: bigint; data: Hex }>; executionData: Hex } {
    if (keys.length === 0) {
        return { calls: [], executionData: '0x' }
    }

    const calls: Array<{ to: Address; value: bigint; data: Hex }> = []

    for (const key of keys) {
        const authorizeCallData = encodeFunctionData({
            abi: accountAbi,
            functionName: 'authorize',
            args: [
                {
                    expiry: Number(key.expiry),
                    keyType: key.type === 'secp256k1' ? 0 : 1,
                    isSuperAdmin: key.role === 'admin',
                    publicKey: key.publicKey,
                },
            ],
        })

        calls.push({
            to: accountAddress,
            value: 0n,
            data: authorizeCallData,
        })

        if (key.permissions.length > 0 && key.role !== 'admin') {
            const keyHash = computeKeyHash(key)

            for (const permission of key.permissions) {
                if (permission.type === 'call') {
                    const setCanExecuteData = encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'setCanExecute',
                        args: [keyHash, permission.to, permission.selector as `0x${string}`, true],
                    })

                    calls.push({
                        to: accountAddress,
                        value: 0n,
                        data: setCanExecuteData,
                    })
                } else if (permission.type === 'spend') {
                    const setSpendLimitData = encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'setSpendLimit',
                        args: [
                            keyHash,
                            permission.token,
                            spendPeriodToNumber(permission.period),
                            BigInt(permission.limit),
                        ],
                    })

                    calls.push({
                        to: accountAddress,
                        value: 0n,
                        data: setSpendLimitData,
                    })
                }
            }
        }
    }

    const executionData = encodeAbiParameters(
        parseAbiParameters('(address to, uint256 value, bytes data)[]'),
        [calls],
    )

    return { calls, executionData }
}

/**
 * Compute the SignedCall execution digest using EIP-712.
 */
export function computeSignedCallDigest(
    chainId: number,
    orchestratorAddress: Address,
    eoa: Address,
    calls: Array<{ to: Address; value: bigint; data: Hex }>,
    nonce: bigint,
): Hex {
    const isMultichain = nonce >> 240n === MULTICHAIN_NONCE_PREFIX
    const domain = getSignedCallDomain(chainId, orchestratorAddress)

    return hashTypedData({
        domain,
        types: SIGNED_CALL_TYPES,
        primaryType: 'SignedCall',
        message: {
            multichain: isMultichain,
            eoa,
            calls,
            nonce,
        },
    })
}

/**
 * Parse a 65-byte signature into r, s, yParity.
 */
export function parseSignature(signature: Hex): { r: Hex; s: Hex; yParity: number } {
    const sig = signature.slice(2)

    if (sig.length !== 130) {
        throw new RpcError(
            INVALID_PARAMS,
            `Invalid signature length: expected 130 hex chars, got ${sig.length}`,
        )
    }

    const r = `0x${sig.slice(0, 64)}` as Hex
    const s = `0x${sig.slice(64, 128)}` as Hex
    const v = parseInt(sig.slice(128, 130), 16)
    const yParity = v >= 27 ? v - 27 : v

    return { r, s, yParity }
}

export function resolveChainId(env: Env, chainIdHex?: string): number {
    if (chainIdHex) {
        const chainId = parseHexChainId(chainIdHex, 'chainId')
        const supported = getChainIds(env)
        if (supported.length > 0 && !supported.includes(chainId)) {
            throw new RpcError(INVALID_PARAMS, `Unsupported chainId: ${chainId}`)
        }
        return chainId
    }

    const chainIds = getChainIds(env)
    if (chainIds.length === 1) {
        return chainIds[0]
    }

    throw new RpcError(INVALID_PARAMS, 'Missing chainId')
}
