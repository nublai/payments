import { getAddress, type Address, type Hex } from 'viem'
import type { JsonRpcParams, RpcContext } from '../types'
import type { Env } from '../../types/env'
import type { CreateAccountTransaction, SendResult } from '../../types/pool'
import type { UpgradeAccountParams, UpgradeAccountResult } from '../schema/upgradeAccount'
import {
    RpcError,
    INVALID_PARAMS,
    INVALID_SIGNATURE,
    SERVICE_UNAVAILABLE,
    INTERNAL_ERROR,
} from '../errors'
import { getChainConfig } from '../../config'
import { logger } from '../../lib/logger'
import { createRelayerPublicClient, isEip7702Delegated } from '../../lib/viem-utils'
import { requireParam, unwrapParams, validateAddress } from '../../lib/rpc-utils'
import { authIdentityOwnsAccount, upgradeRateIdentity } from '../../auth/identity'
import {
    waitForDelegationCode,
    parseSignature,
    resolveChainId,
    authorizationSignerMatchesAccount,
    assertAllowedUpgradePreCall,
} from './shared/account-helpers'
import { getSignerPool } from './shared/signer-pool'
import { releaseUpgradeRateLimit, reserveUpgradeRateLimit } from './shared/upgrade-rate-limit'

export type {
    UpgradeAccountParams,
    UpgradeAccountResult,
    UpgradeAccountSignatures,
} from '../schema/upgradeAccount'

export { waitForDelegationCode }

/**
 * wallet_upgradeAccount - Execute the EOA upgrade after user signing.
 */
export async function handleUpgradeAccount(
    params: JsonRpcParams | UpgradeAccountParams | undefined,
    ctx: RpcContext,
): Promise<UpgradeAccountResult> {
    const env = ctx.env as Env
    const typedParams = unwrapParams<UpgradeAccountParams>(params)

    const context = requireParam(typedParams?.context, 'context')
    const signatures = requireParam(typedParams?.signatures, 'signatures')
    requireParam(signatures.auth, 'signatures.auth')
    requireParam(signatures.exec, 'signatures.exec')

    if (!context.address || !context.authorization || !context.preCall) {
        throw new RpcError(
            INVALID_PARAMS,
            'Invalid context: missing address, authorization, or preCall',
        )
    }

    const accountAddress = validateAddress(context.address, 'context.address')

    const delegation = validateAddress(
        context.authorization.contractAddress,
        'context.authorization.contractAddress',
    )

    if (!Number.isInteger(context.authorization.nonce) || context.authorization.nonce < 0) {
        throw new RpcError(INVALID_PARAMS, 'Invalid authorization nonce')
    }

    const chainId = resolveChainId(env, context.chainId)
    const config = getChainConfig(env, chainId)

    let parsedAuthSig: { r: Hex; s: Hex; yParity: number }

    try {
        parsedAuthSig = parseSignature(signatures.auth)
    } catch (error) {
        if (error instanceof RpcError) throw error
        throw new RpcError(INVALID_PARAMS, 'Failed to parse auth signature')
    }

    const authorizationMatches = await authorizationSignerMatchesAccount({
        account: accountAddress,
        contractAddress: delegation,
        chainId: config.chainId,
        nonce: context.authorization.nonce,
        signature: signatures.auth,
    })

    if (!authorizationMatches) {
        throw new RpcError(INVALID_SIGNATURE, 'Invalid authorization signature')
    }

    if (!authIdentityOwnsAccount(accountAddress)) {
        throw new RpcError(INVALID_PARAMS, 'Authenticated identity is not bound to the account')
    }

    if (getAddress(delegation) !== getAddress(config.contracts.accountProxy)) {
        throw new RpcError(INVALID_PARAMS, 'Delegation target is not the account proxy')
    }

    const publicClient = createRelayerPublicClient(config.chainId, config.rpcUrl)
    let pendingNonce: number

    try {
        pendingNonce = await publicClient.getTransactionCount({
            address: accountAddress,
            blockTag: 'pending',
        })
    } catch (error) {
        logger.error({ error, address: accountAddress }, 'failed to fetch account nonce')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Account upgrade failed')
    }

    if (pendingNonce !== context.authorization.nonce) {
        throw new RpcError(INVALID_PARAMS, 'Authorization nonce does not match the account nonce')
    }

    const allowedPreCall = await assertAllowedUpgradePreCall({
        account: accountAddress,
        chainId: config.chainId,
        orchestrator: config.contracts.orchestrator,
        executionData: context.preCall.executionData,
        eoa: context.preCall.eoa,
        nonce: context.preCall.nonce,
        execSignature: signatures.exec,
    })

    const rateIdentity = upgradeRateIdentity(accountAddress)

    const reservedAt = await reserveUpgradeRateLimit(env, chainId, ctx, {
        kind: 'upgrade',
        account: accountAddress,
        identity: rateIdentity,
    })

    const signedAuth = {
        address: delegation,
        chainId: config.chainId,
        nonce: context.authorization.nonce,
        r: parsedAuthSig.r,
        s: parsedAuthSig.s,
        yParity: parsedAuthSig.yParity,
    }

    const tx: CreateAccountTransaction = {
        id: crypto.randomUUID(),
        type: 'create-account',
        accountAddress,
        ownerAddress: accountAddress,
        authorization: signedAuth,
        preCall: allowedPreCall,
    }

    const pool = getSignerPool(env, chainId)
    let response: Response

    try {
        response = await pool.fetch(`http://do/send?poolName=pool-${chainId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tx),
        })
    } catch (error) {
        logger.error({ error, address: accountAddress }, 'account upgrade pool unavailable')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Account upgrade failed')
    }

    if (!response.ok) {
        let detail = 'unknown'
        let broadcastAttempted = true

        try {
            const errorBody = (await response.json()) as {
                error?: unknown
                broadcastAttempted?: unknown
            }

            broadcastAttempted = errorBody.broadcastAttempted !== false
            detail =
                typeof errorBody.error === 'string' ? errorBody.error : JSON.stringify(errorBody)
        } catch (parseError) {
            detail = parseError instanceof Error ? parseError.message : 'unreadable pool error'
        }

        if (!broadcastAttempted) {
            await releaseUpgradeRateLimit(env, chainId, ctx, {
                kind: 'upgrade',
                account: accountAddress,
                identity: rateIdentity,
                reservedAt,
            })
        }

        logger.warn({ address: accountAddress, error: detail }, 'account upgrade failed')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Account upgrade failed')
    }

    const result = (await response.json()) as SendResult
    logger.info(
        {
            address: context.address,
            txHash: result.txHash,
            signer: result.signer,
        },
        'account upgrade submitted, waiting for confirmation',
    )

    try {
        const receipt = await publicClient.waitForTransactionReceipt({
            hash: result.txHash as Hex,
            timeout: 60_000,
        })

        if (receipt.status !== 'success') {
            logger.error(
                { address: context.address, txHash: result.txHash },
                'account upgrade tx reverted',
            )
            throw new RpcError(INTERNAL_ERROR, 'Account upgrade transaction reverted')
        }

        const code = await waitForDelegationCode(
            publicClient,
            context.address as Address,
            receipt.blockNumber,
        )

        if (!isEip7702Delegated(code)) {
            logger.error(
                {
                    address: context.address,
                    txHash: result.txHash,
                    blockNumber: receipt.blockNumber.toString(),
                    code,
                },
                'delegation not confirmed after tx mined',
            )
            throw new RpcError(INTERNAL_ERROR, 'Delegation not confirmed after transaction mined')
        }

        logger.info(
            { address: context.address, txHash: result.txHash },
            'account upgrade confirmed',
        )

        return {
            success: true,
            txHash: result.txHash,
        }
    } catch (error) {
        if (error instanceof RpcError) throw error
        logger.error(
            { address: context.address, txHash: result.txHash, error },
            'failed waiting for confirmation',
        )
        throw new RpcError(INTERNAL_ERROR, 'Failed to confirm account upgrade')
    }
}
