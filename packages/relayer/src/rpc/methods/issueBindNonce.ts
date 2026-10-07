import { getAddress, type Address } from 'viem'

import type { RpcContext } from '../types'
import type { Env } from '../../types/env'
import { RpcError, INVALID_PARAMS, NONCE_ERROR } from '../errors'
import { requireParam, unwrapParams, validateAddress } from '../../lib/rpc-utils'
import { currentAuthIdentity } from '../../auth/identity'
import { BIND_NONCE_TTL_SECONDS, walletBindPersonalMessage, walletBindTypedData } from '../../auth/wallet-bind'
import { walletBindingStub } from '../../auth/wallet-binding-client'
import { resolveChainId } from './shared/account-helpers'
import type { IssueBindNonceParams } from '../schema/bindAccount'

export function requireOidcCaller(): { issuer: string; subject: string } {
    const identity = currentAuthIdentity()
    if (!identity || identity.provider !== 'oidc' || !identity.issuer || !identity.userId) {
        throw new RpcError(INVALID_PARAMS, 'OIDC identity required')
    }
    return { issuer: identity.issuer, subject: identity.userId }
}

export async function issueBindNonce(
    params: unknown,
    env: Env,
    nowSeconds: number,
): Promise<{
    nonce: string
    expiry: number
    chainId: string
    address: Address
    issuer: string
    sub: string
    message: string
    typedData: ReturnType<typeof walletBindTypedData>
}> {
    const caller = requireOidcCaller()
    const typed = unwrapParams<IssueBindNonceParams>(params)
    const address = getAddress(validateAddress(requireParam(typed?.address, 'address'), 'address'))
    const chainId = resolveChainId(env, typed?.chainId)

    let issued: Awaited<ReturnType<ReturnType<typeof walletBindingStub>['issueNonce']>>
    try {
        issued = await walletBindingStub(env).issueNonce({
            issuer: caller.issuer,
            subject: caller.subject,
            address,
            chainId,
            nowSeconds,
            ttlSeconds: BIND_NONCE_TTL_SECONDS,
        })
    } catch {
        throw new RpcError(NONCE_ERROR, 'Wallet binding store unavailable')
    }

    if (!issued.ok) {
        if (issued.reason === 'address_taken') {
            throw new RpcError(INVALID_PARAMS, 'Address is bound to another identity')
        }
        throw new RpcError(INVALID_PARAMS, 'Invalid bind nonce request')
    }

    const fields = {
        account: address,
        issuer: caller.issuer,
        sub: caller.subject,
        nonce: issued.nonce,
        chainId,
        expiry: issued.expiresAt,
    }

    return {
        nonce: issued.nonce,
        expiry: issued.expiresAt,
        chainId: `0x${chainId.toString(16)}`,
        address,
        issuer: caller.issuer,
        sub: caller.subject,
        message: walletBindPersonalMessage(fields),
        typedData: walletBindTypedData(fields),
    }
}

export async function handleIssueBindNonce(params: unknown, ctx: RpcContext) {
    return issueBindNonce(params, ctx.env as Env, Math.floor(Date.now() / 1000))
}
