/**
 * Verify Signature RPC Method
 *
 * Verifies that a signature over a digest was produced by an authorized
 * superAdmin key on a account, supporting EIP-7702 delegated accounts.
 */

import { type Hex } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import type { JsonRpcParams, RpcContext } from '../types'
import type { Env } from '../../types/env'
import type { ContractKey } from '../../types/contract'
import type { VerifySignatureParams, VerifySignatureResult } from '../schema/verifySignature'
import { RpcError, INVALID_PARAMS, INTERNAL_ERROR } from '../errors'
import { computeErc1271Digest, wrapSignature } from '../../lib/erc1271'
import { logger } from '../../lib/logger'
import { hasCode } from '../../lib/viem-utils'
import { parseHexChainId, requireParam, validateAddress, unwrapParams } from '../../lib/rpc-utils'
import { getChainIds } from '../../config'
import { rpcHandlerIo } from '../handler-io'

// =============================================================================
// Types
// =============================================================================

export type {
    VerifySignatureParams,
    ValidSignatureProof,
    VerifySignatureResult,
} from '../schema/verifySignature'

// =============================================================================
// Method Handler
// =============================================================================

/**
 * wallet_verifySignature - Verifies a signature against an account
 *
 * Algorithm:
 * 1. Key Resolution - Query account's authorized keys, filter for superAdmin
 * 2. Signature Wrapping - Wrap signature with keyHash for each superAdmin key
 * 3. Delegation Status Check - Check if EOA has EIP-7702 delegation bytecode
 * 4. ERC-1271 Digest Transformation - Compute replay-safe digest
 * 5. On-Chain Validation - Call unwrapAndValidateSignature for each key
 * 6. Response Construction - Return valid + proof or invalid
 */
export async function handleVerifySignature(
    params: JsonRpcParams | VerifySignatureParams | undefined,
    ctx: RpcContext,
): Promise<VerifySignatureResult> {
    const env = ctx.env as Env
    const io = rpcHandlerIo(ctx)

    // Parse params (JSON-RPC array format)
    const typedParams = unwrapParams<VerifySignatureParams>(params)

    // Validate required params
    const address = validateAddress(requireParam(typedParams?.address, 'address'), 'address')
    const originalDigest = requireParam(typedParams?.digest, 'digest')
    const signature = requireParam(typedParams?.signature, 'signature')
    const chainIdParam = requireParam(typedParams?.chain_id, 'chain_id')

    // Validate digest is 32 bytes
    if (!/^0x[a-fA-F0-9]{64}$/.test(originalDigest)) {
        throw new RpcError(INVALID_PARAMS, 'Invalid digest format: must be 32 bytes')
    }

    const requestedChainId = parseHexChainId(chainIdParam, 'chain_id')
    const supportedChainIds = getChainIds(env)

    if (supportedChainIds.length > 0 && !supportedChainIds.includes(requestedChainId)) {
        throw new RpcError(INVALID_PARAMS, `Unsupported chain ID: ${requestedChainId}`)
    }

    const config = io.getChainConfig(env, requestedChainId)
    const publicClient = io.createRelayerPublicClient(config.chainId, config.rpcUrl)

    // Step 3: Delegation Status Check
    // Check if account is delegated (has EIP-7702 delegation bytecode)
    let code: Hex | undefined

    try {
        code = await publicClient.getCode({ address })
    } catch (error) {
        logger.error({ error, address }, 'Failed to check account code')
        throw new RpcError(INTERNAL_ERROR, 'Failed to check account delegation status')
    }

    // If not delegated, return valid: false with null proof
    if (!hasCode(code)) {
        logger.info({ address }, 'Account not delegated, signature invalid')

        return { valid: false, proof: null }
    }

    // Step 1: Key Resolution
    // Fetch keys from contract and filter for superAdmin
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
        // If getKeys fails, account might not be a valid Account
        logger.warn({ error, address }, 'Failed to read account keys')

        return { valid: false, proof: null }
    }

    // Filter for superAdmin keys only
    const superAdminKeys: Array<{ key: ContractKey; hash: Hex }> = []

    for (let i = 0; i < keys.length; i++) {
        if (keys[i].isSuperAdmin) {
            superAdminKeys.push({ key: keys[i], hash: keyHashes[i] })
        }
    }

    if (superAdminKeys.length === 0) {
        logger.info({ address }, 'No superAdmin keys found')

        return { valid: false, proof: null }
    }

    // Step 4: ERC-1271 Digest Transformation
    // Transform the input digest into an ERC-1271 replay-safe digest
    const erc1271Digest = computeErc1271Digest(originalDigest, address)

    // Step 5: On-Chain Validation
    // Call unwrapAndValidateSignature for each superAdmin key concurrently
    const validationPromises = superAdminKeys.map(async ({ hash: keyHash }) => {
        try {
            // Step 2: Signature Wrapping
            const wrappedSignature = wrapSignature(signature, keyHash, false)

            const result = await publicClient.readContract({
                address,
                abi: accountAbi,
                functionName: 'unwrapAndValidateSignature',
                args: [erc1271Digest, wrappedSignature],
            })

            const [isValid, returnedKeyHash] = result as [boolean, Hex]

            return { isValid, keyHash: returnedKeyHash, attemptedKeyHash: keyHash }
        } catch (error) {
            logger.debug({ error, keyHash }, 'Signature validation failed for key')

            return { isValid: false, keyHash: '0x' as Hex, attemptedKeyHash: keyHash }
        }
    })

    const validationResults = await Promise.all(validationPromises)

    // Find the first valid result
    const validResult = validationResults.find((r) => r.isValid)

    // Step 6: Response Construction
    if (validResult) {
        logger.info({ address, keyHash: validResult.keyHash }, 'Signature verified successfully')

        return {
            valid: true,
            proof: {
                account: address,
                key_hash: validResult.keyHash,
            },
        }
    }

    logger.info({ address }, 'Signature verification failed for all superAdmin keys')

    return { valid: false, proof: null }
}
