import type { Env } from '../types/env'
import type { Address } from 'viem'

export type AuthFailureCode =
    | 'MISSING_HEADERS'
    | 'BAD_FORMAT'
    | 'BAD_KEYID'
    | 'SIGNER_NOT_ALLOWED'
    | 'UNSUPPORTED_CHAIN'
    | 'INVALID_TIME'
    | 'INVALID_COVERAGE'
    | 'MISSING_NONCE'
    | 'REPLAYED_NONCE'
    | 'BAD_CONTENT_DIGEST'
    | 'BAD_SIGNATURE'
    | 'INVALID_TOKEN'
    | 'EXPIRED_TOKEN'
    | 'NO_LINKED_WALLET'
    | 'PRIVY_API_UNAVAILABLE'

export interface AuthFailure {
    ok: false
    code: AuthFailureCode
    message: string
}

export interface AuthSuccess {
    ok: true
    userId?: Address | string
    provider?: string
    /** Accounts this identity may upgrade. Set for Privy after the wallet link check. */
    boundAccounts?: Address[]
}

export type AuthResult = AuthSuccess | AuthFailure

export interface AuthProvider {
    name: string
    enabled(env: Env): boolean
    verify(req: Request, ctx: { env: Env; nowSeconds: number }): Promise<AuthResult>
}
