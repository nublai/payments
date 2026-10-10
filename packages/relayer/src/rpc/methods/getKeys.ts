/**
 * Keys RPC Method
 *
 * Returns authorized keys and their permissions for an Account.
 */

import { type Address, type Hex, numberToHex } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import type { JsonRpcParams, RpcContext } from '../types'
import type { Env } from '../../types/env'
import type { ContractKey } from '../../types/contract'
import { RpcError, ACCOUNT_NOT_DELEGATED, CONTRACT_ERROR } from '../errors'
import { logger } from '../../lib/logger'
import { toHexChainId, hasCode } from '../../lib/viem-utils'
import { parseHexChainId, requireParam, validateAddress, unwrapParams } from '../../lib/rpc-utils'
import { getChainIds } from '../../config'
import { rpcHandlerIo } from '../handler-io'
import type { KeyType } from '../schema/upgradeAccount'
import {
    type PermissionResponse,
    type AuthorizedKeyResponse,
    type GetKeysParams,
    type GetKeysResult,
} from '../schema/getKeys'
import { spendPeriodFromNumber } from './shared/account-helpers'

// =============================================================================
// Types
// =============================================================================

export type {
    SpendPermissionResponse,
    PermissionResponse,
    AuthorizedKeyResponse,
    GetKeysParams,
    GetKeysResult,
} from '../schema/getKeys'

// =============================================================================
// Constants
// =============================================================================

const KEY_TYPE_MAP: Record<number, KeyType> = {
    0: 'secp256k1',
    1: 'external',
    2: 'p256',
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Decode packed canExecute value (bytes32) into target and selector
 * Format: target (upper 20 bytes) | selector (lower 4 bytes)
 */
function decodePackedCanExecute(packed: Hex): { target: Address; selector: Hex } {
    const value = BigInt(packed)
    const target = `0x${(value >> 96n).toString(16).padStart(40, '0')}` as Address
    const selector = `0x${(value & 0xffffffffn).toString(16).padStart(8, '0')}` as Hex

    return { target, selector }
}

// =============================================================================
// Contract Types (matching ABI output)
// =============================================================================

interface ContractSpendInfo {
    token: Address
    period: number
    limit: bigint
    spent: bigint
    lastUpdated: bigint
    currentSpent: bigint
    current: bigint
}

// =============================================================================
// Method Handler
// =============================================================================

/**
 * wallet_getKeys - Returns authorized keys and their permissions for an Account
 *
 * @param params - { address: Address, chainIds?: string[] }
 * @param ctx - RPC context
 * @returns Keys keyed by hex chain ID
 */
export async function handleGetKeys(params: JsonRpcParams | GetKeysParams | undefined, ctx: RpcContext): Promise<GetKeysResult> {
    const env = ctx.env as Env
    const io = rpcHandlerIo(ctx)

    // Parse params (JSON-RPC array format)
    const typedParams = unwrapParams<GetKeysParams>(params)

    // Validate required params
    const address = validateAddress(requireParam(typedParams?.address, 'address'), 'address')

    let chainIdsToCheck: number[] = []

    if (typedParams?.chainIds && typedParams.chainIds.length > 0) {
        chainIdsToCheck = typedParams.chainIds.map((value) => parseHexChainId(value, 'chainId'))
    } else {
        chainIdsToCheck = getChainIds(env)
    }

    const results: GetKeysResult = {}
    const strictSingleChain = chainIdsToCheck.length === 1

    for (const chainId of chainIdsToCheck) {
        const config = io.getChainConfig(env, chainId)
        const hexChainId = toHexChainId(config.chainId)
        const publicClient = io.createRelayerPublicClient(config.chainId, config.rpcUrl)

        // Check if account is delegated (has code)
        let code: Hex | undefined

        try {
            code = await publicClient.getCode({ address })
        } catch (error) {
            logger.error({ error, address, chainId }, 'Failed to check account code')
            throw new RpcError(CONTRACT_ERROR, 'Failed to check account delegation status')
        }

        if (!hasCode(code)) {
            if (strictSingleChain) {
                throw new RpcError(
                    ACCOUNT_NOT_DELEGATED,
                    `Account ${address} is not delegated to an Account. Use wallet_prepareUpgradeAccount and wallet_upgradeAccount to upgrade first.`,
                )
            }

            results[hexChainId] = []
            continue
        }

        // Fetch keys from contract
        let keys: readonly ContractKey[]
        let keyHashes: readonly Hex[]

        try {
            const result = await publicClient.readContract({
                address,
                abi: accountAbi,
                functionName: 'getKeys',
            })

            keys = result[0] as readonly ContractKey[]
            keyHashes = result[1] as readonly Hex[]
        } catch (error) {
            logger.error({ error, address, chainId }, 'Failed to read account keys')

            if (strictSingleChain) {
                throw new RpcError(
                    ACCOUNT_NOT_DELEGATED,
                    `Account ${address} is not delegated to an Account. Use wallet_prepareUpgradeAccount and wallet_upgradeAccount to upgrade first.`,
                )
            }

            results[hexChainId] = []
            continue
        }

        // If no keys, return empty array for this chain
        if (keys.length === 0) {
            results[hexChainId] = []
            continue
        }

        // Fetch permissions for all keys in one call
        let spends: readonly (readonly ContractSpendInfo[])[] = []
        let executes: readonly (readonly Hex[])[] = []

        try {
            const result = await publicClient.readContract({
                address,
                abi: accountAbi,
                functionName: 'spendAndExecuteInfos',
                args: [keyHashes as readonly `0x${string}`[]],
            })

            spends = result[0] as readonly (readonly ContractSpendInfo[])[]
            executes = result[1] as readonly (readonly Hex[])[]
        } catch (error) {
            logger.error({ error, address, chainId }, 'Failed to read key permissions')
            throw new RpcError(CONTRACT_ERROR, 'Failed to read key permissions')
        }

        // Transform keys with permissions
        const authorizedKeys: AuthorizedKeyResponse[] = keys.map((key, index) => {
            const keyHash = keyHashes[index]
            const keySpends = spends[index] ?? []
            const keyExecutes = executes[index] ?? []

            // Build permissions array
            const permissions: PermissionResponse[] = []

            // Add call permissions
            for (const packed of keyExecutes) {
                const { target, selector } = decodePackedCanExecute(packed)
                permissions.push({
                    type: 'call',
                    to: target,
                    selector,
                })
            }

            // Add spend permissions
            for (const spend of keySpends) {
                permissions.push({
                    type: 'spend',
                    token: spend.token,
                    period: spendPeriodFromNumber(spend.period),
                    limit: numberToHex(spend.limit),
                    spent: numberToHex(spend.currentSpent),
                })
            }

            return {
                hash: keyHash,
                expiry: numberToHex(key.expiry),
                type: KEY_TYPE_MAP[key.keyType] ?? 'secp256k1',
                role: key.isSuperAdmin ? 'admin' : 'normal',
                publicKey: key.publicKey,
                permissions,
            }
        })

        logger.info(
            {
                address,
                keyCount: authorizedKeys.length,
                chainId: config.chainId,
            },
            'Retrieved account keys',
        )

        results[hexChainId] = authorizedKeys
    }

    return results
}
