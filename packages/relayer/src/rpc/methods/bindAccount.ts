import { getAddress, type Hex } from 'viem'

import type { RpcContext } from '../types'
import type { Env } from '../../types/env'
import { RpcError, INVALID_PARAMS, INVALID_SIGNATURE, NONCE_ERROR, RATE_LIMITED } from '../errors'
import { requireParam, unwrapParams, validateAddress } from '../../lib/rpc-utils'
import {
    parseWalletBindScheme,
    verifyWalletBindSignature,
    walletBindEnvironment,
} from '../../auth/wallet-bind'
import { upgradeClientIp } from './shared/upgrade-rate-limit'
import { walletBindingStub } from '../../auth/wallet-binding-client'
import { resolveChainId } from './shared/account-helpers'
import { requireOidcCaller } from './issueBindNonce'
import type { BindAccountParams } from '../schema/bindAccount'

export async function bindAccount(
    params: unknown,
    env: Env,
    nowSeconds: number,
    ip?: string,
): Promise<{ address: string; issuer: string; sub: string }> {
    const caller = requireOidcCaller()
    const typed = unwrapParams<BindAccountParams>(params)
    const address = getAddress(validateAddress(requireParam(typed?.address, 'address'), 'address'))
    const chainId = resolveChainId(env, typed?.chainId)
    const nonce = requireParam(typed?.nonce, 'nonce')
    const expiry = typed?.expiry
    const signature = requireParam(typed?.signature, 'signature')
    const scheme = parseWalletBindScheme(typed?.scheme ?? 'eip712')

    if (!scheme) {
        throw new RpcError(INVALID_PARAMS, 'Invalid bind scheme')
    }
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) {
        throw new RpcError(INVALID_PARAMS, 'Invalid bind nonce')
    }
    if (typeof expiry !== 'number' || !Number.isInteger(expiry) || expiry < 0) {
        throw new RpcError(INVALID_PARAMS, 'Invalid bind expiry')
    }
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new RpcError(INVALID_SIGNATURE, 'Invalid bind signature')
    }

    let charged: Awaited<ReturnType<ReturnType<typeof walletBindingStub>['chargeBind']>>
    try {
        charged = await walletBindingStub(env).chargeBind({
            issuer: caller.issuer,
            subject: caller.subject,
            ip,
            nowSeconds,
        })
    } catch {
        throw new RpcError(NONCE_ERROR, 'Wallet binding store unavailable')
    }
    if (!charged.ok) {
        throw new RpcError(RATE_LIMITED, 'Bind rate limit exceeded')
    }

    const signed = await verifyWalletBindSignature({
        fields: {
            account: address,
            issuer: caller.issuer,
            sub: caller.subject,
            nonce,
            chainId,
            expiry,
            environment: walletBindEnvironment(env),
        },
        signature: signature as Hex,
        scheme,
    })
    if (!signed) {
        throw new RpcError(INVALID_SIGNATURE, 'Invalid bind signature')
    }

    let outcome: Awaited<ReturnType<ReturnType<typeof walletBindingStub>['bind']>>
    try {
        outcome = await walletBindingStub(env).bind({
            nonce,
            issuer: caller.issuer,
            subject: caller.subject,
            address,
            chainId,
            expiry,
            nowSeconds,
            ip,
            charged: true,
        })
    } catch {
        throw new RpcError(NONCE_ERROR, 'Wallet binding store unavailable')
    }

    if (!outcome.ok) {
        if (outcome.reason === 'address_taken') {
            throw new RpcError(INVALID_PARAMS, 'Address is bound to another identity')
        }
        if (outcome.reason === 'rate_limited' || outcome.reason === 'subject_cap') {
            throw new RpcError(RATE_LIMITED, 'Wallet binding cap exceeded')
        }
        if (outcome.reason === 'nonce_expired') {
            throw new RpcError(NONCE_ERROR, 'Bind nonce expired')
        }
        if (outcome.reason === 'nonce_used') {
            throw new RpcError(NONCE_ERROR, 'Bind nonce already used')
        }
        throw new RpcError(NONCE_ERROR, 'Bind nonce rejected')
    }

    return { address, issuer: caller.issuer, sub: caller.subject }
}

export async function handleBindAccount(params: unknown, ctx: RpcContext) {
    return bindAccount(
        params,
        ctx.env as Env,
        Math.floor(Date.now() / 1000),
        upgradeClientIp(ctx.request),
    )
}
