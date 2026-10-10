import type { JsonRpcParams, RpcContext } from '../types'
import type { Env } from '../../types/env'
import type {
    AuthorizeKeyResponse,
    Authorization,
    SignedCall,
    PrepareUpgradeResult,
    PrepareUpgradeParams,
} from '../schema/upgradeAccount'
import { getAddress } from 'viem'
import { RpcError, INTERNAL_ERROR, INVALID_PARAMS } from '../errors'
import { getChainConfig } from '../../config'
import { logger } from '../../lib/logger'
import { createRelayerPublicClient, toHexChainId } from '../../lib/viem-utils'
import { requireParam, validateAddress, unwrapParams } from '../../lib/rpc-utils'
import { authIdentityOwnsAccount, upgradeRateIdentity } from '../../auth/identity'
import {
    assertUpgradeRateCapacity,
    recordUpgradeRateLimit,
} from './shared/upgrade-rate-limit'
import {
    MULTICHAIN_NONCE_PREFIX,
    SIGNED_CALL_TYPES,
    getSignedCallDomain,
    computeAuthorizationDigest,
    computeKeyHash,
    buildKeyInitializationData,
    computeSignedCallDigest,
    resolveChainId,
} from './shared/account-helpers'

export type {
    PrepareUpgradeParams,
    PrepareUpgradeResult,
    UpgradeAccountCapabilities,
    UpgradeAccountContext,
    UpgradeAccountDigests,
    Authorization,
    SignedCall,
    AuthorizeKey,
    AuthorizeKeyResponse,
    Permission,
    CallPermission,
    SpendPermission,
    KeyType,
    SpendPeriod,
} from '../schema/upgradeAccount'

/**
 * wallet_prepareUpgradeAccount - Prepare an EOA for upgrade to EIP-7702 smart account.
 */
export async function handlePrepareUpgradeAccount(
    params: JsonRpcParams | PrepareUpgradeParams | undefined,
    ctx: RpcContext,
): Promise<PrepareUpgradeResult> {
    const env = ctx.env as Env
    const typedParams = unwrapParams<PrepareUpgradeParams>(params)

    const accountAddress = validateAddress(requireParam(typedParams?.address, 'address'), 'address')
    const delegation = validateAddress(requireParam(typedParams?.delegation, 'delegation'), 'delegation')

    const chainId = resolveChainId(env, typedParams?.chainId)
    const config = getChainConfig(env, chainId)
    const hexChainId = toHexChainId(config.chainId)

    if (!authIdentityOwnsAccount(accountAddress)) {
        throw new RpcError(INVALID_PARAMS, 'Authenticated identity is not bound to the account')
    }

    if (getAddress(delegation) !== getAddress(config.contracts.accountProxy)) {
        throw new RpcError(INVALID_PARAMS, 'Delegation target is not the account proxy')
    }

    const rateIdentity = upgradeRateIdentity(accountAddress)
    await assertUpgradeRateCapacity(env, chainId, ctx, {
        kind: 'prepare',
        account: accountAddress,
        identity: rateIdentity,
    })

    const authorizeKeys = typedParams?.capabilities?.authorizeKeys ?? []
    const publicClient = createRelayerPublicClient(config.chainId, config.rpcUrl)

    let eoaNonce: bigint

    try {
        eoaNonce = BigInt(
            await publicClient.getTransactionCount({
                address: accountAddress,
                blockTag: 'pending',
            }),
        )
    } catch (error) {
        logger.error({ error, address: accountAddress }, 'Failed to fetch nonce')
        throw new RpcError(INTERNAL_ERROR, 'Failed to fetch account nonce')
    }

    const authDigest = computeAuthorizationDigest(config.chainId, delegation, eoaNonce)
    const { calls, executionData } = buildKeyInitializationData(authorizeKeys, accountAddress)

    const PRECALL_SEQ_KEY = 1n
    const preCallNonce = (PRECALL_SEQ_KEY << 64n) | 0n

    const execDigest = computeSignedCallDigest(
        config.chainId,
        config.contracts.orchestrator,
        accountAddress,
        calls,
        preCallNonce,
    )

    const authorization: Authorization = {
        contractAddress: delegation,
        chainId: config.chainId,
        nonce: Number(eoaNonce),
    }

    const preCall: SignedCall = {
        eoa: accountAddress,
        executionData,
        nonce: preCallNonce.toString(),
        signature: '0x',
        chainId: hexChainId,
    }

    const isMultichain = preCallNonce >> 240n === MULTICHAIN_NONCE_PREFIX
    const domain = getSignedCallDomain(config.chainId, config.contracts.orchestrator)

    const typedData = {
        domain,
        types: SIGNED_CALL_TYPES,
        primaryType: 'SignedCall',
        message: {
            multichain: isMultichain,
            eoa: accountAddress,
            calls: calls.map((c) => ({
                to: c.to,
                value: c.value.toString(),
                data: c.data,
            })),
            nonce: preCallNonce.toString(),
        },
    }

    const authorizeKeyResponses: AuthorizeKeyResponse[] = authorizeKeys.map((key) => ({
        ...key,
        hash: computeKeyHash(key),
    }))

    logger.info(
        {
            address: accountAddress,
            delegation,
            nonce: eoaNonce.toString(),
            keyCount: authorizeKeys.length,
        },
        'prepared account upgrade with keys',
    )

    await recordUpgradeRateLimit(env, chainId, ctx, {
        kind: 'prepare',
        account: accountAddress,
        identity: rateIdentity,
    })

    return {
        chainId: hexChainId,
        context: {
            address: accountAddress,
            chainId: hexChainId,
            authorization,
            preCall,
        },
        digests: {
            auth: authDigest,
            exec: execDigest,
        },
        typedData,
        capabilities: {
            authorizeKeys: authorizeKeyResponses,
        },
    }
}
