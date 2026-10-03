import type { Address, Hex } from 'viem'
import type { RpcContext } from '../types'
import type { Env } from '../../types/env'
import type { CreateAccountTransaction, SendResult } from '../../types/pool'
import type {
    SignedCall,
    UpgradeAccountParams,
    UpgradeAccountResult,
} from '../schema/upgradeAccount'
import { RpcError, INVALID_PARAMS, SERVICE_UNAVAILABLE, INTERNAL_ERROR } from '../errors'
import { getChainConfig } from '../../config'
import { logger } from '../../lib/logger'
import { createRelayerPublicClient, isEip7702Delegated } from '../../lib/viem-utils'
import { requireParam, unwrapParams } from '../../lib/rpc-utils'
import { waitForDelegationCode, parseSignature, resolveChainId } from './shared/account-helpers'
import { getSignerPool } from './shared/signer-pool'

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
    params: unknown,
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

    const chainId = resolveChainId(env, context.chainId)
    const config = getChainConfig(env, chainId)

    let parsedAuthSig: { r: Hex; s: Hex; yParity: number }
    try {
        parsedAuthSig = parseSignature(signatures.auth)
    } catch (error) {
        if (error instanceof RpcError) throw error
        throw new RpcError(INVALID_PARAMS, 'Failed to parse auth signature')
    }

    const signedAuth = {
        address: context.authorization.contractAddress,
        chainId: config.chainId,
        nonce: context.authorization.nonce,
        r: parsedAuthSig.r,
        s: parsedAuthSig.s,
        yParity: parsedAuthSig.yParity,
    }

    const signedPreCall: SignedCall = {
        ...context.preCall,
        signature: signatures.exec,
    }

    const tx: CreateAccountTransaction = {
        id: crypto.randomUUID(),
        type: 'create-account',
        accountAddress: context.address,
        ownerAddress: context.address,
        authorization: signedAuth,
        preCall:
            signedPreCall.executionData !== '0x'
                ? {
                      eoa: signedPreCall.eoa,
                      executionData: signedPreCall.executionData,
                      nonce: signedPreCall.nonce,
                      signature: signedPreCall.signature,
                  }
                : undefined,
    }

    const pool = getSignerPool(env, chainId)
    const response = await pool.fetch(`http://do/send?poolName=pool-${chainId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tx),
    })

    if (!response.ok) {
        const error = (await response.json()) as { error: string }
        logger.warn({ address: context.address, error: error.error }, 'account upgrade failed')
        throw new RpcError(SERVICE_UNAVAILABLE, error.error)
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

    const publicClient = createRelayerPublicClient(config.chainId, config.rpcUrl)

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
        throw new RpcError(INTERNAL_ERROR, `Failed to confirm account upgrade: ${error}`)
    }
}
