import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'

import { authorizeRequest } from '../../src/auth/engine'
import {
    authIdentityOwnsAccount,
    rateLimitIdentityKey,
    runWithAuthIdentity,
    upgradeRateIdentity,
} from '../../src/auth/identity'
import { authProviderFromIdentity, type IdentityProvider } from '../../src/auth/identity-provider'
import { identityAuthProviders } from '../../src/auth/identity-registry'
import type { Env } from '../../src/types/env'

const ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address

function stubProvider(args: {
    name: string
    result:
        | { ok: true; userId: string; boundAccounts: Address[] }
        | { ok: false; code: 'INVALID_TOKEN'; message: string }
}): IdentityProvider {
    return {
        name: args.name,
        enabled: () => true,
        verify: async (input) => {
            if (typeof input !== 'string' && !(input instanceof Request)) {
                return { ok: false, code: 'INVALID_TOKEN', message: 'bad input' }
            }
            if (!args.result.ok) return args.result
            return {
                ok: true,
                provider: args.name,
                userId: args.result.userId,
                boundAccounts: args.result.boundAccounts,
            }
        },
    }
}

describe('identity provider registry', () => {
    it('registers Privy ahead of the OIDC identity provider', () => {
        const providers = identityAuthProviders()
        expect(providers.map((provider) => provider.name)).toEqual(['privy', 'oidc'])
    })

    it('accepts a stub provider beside a failing one without changing the identity gate', async () => {
        const result = await authorizeRequest({
            request: new Request('https://relayer.local/', {
                method: 'POST',
                headers: { Authorization: 'Bearer oidc-token' },
            }),
            env: {} as Env,
            nowSeconds: 1_700_000_000,
            providers: [
                authProviderFromIdentity(
                    stubProvider({
                        name: 'stub-first',
                        result: { ok: false, code: 'INVALID_TOKEN', message: 'no' },
                    }),
                ),
                authProviderFromIdentity(
                    stubProvider({
                        name: 'stub-oidc',
                        result: {
                            ok: true,
                            userId: 'user_oidc_1',
                            boundAccounts: [ACCOUNT],
                        },
                    }),
                ),
            ],
        })

        expect(result).toEqual({
            ok: true,
            provider: 'stub-oidc',
            userId: 'user_oidc_1',
            boundAccounts: [ACCOUNT],
        })
        if (!result.ok || result.provider === undefined || result.userId === undefined) {
            throw new Error('expected a stub identity')
        }
        const provider: string = result.provider
        const userId: string = result.userId

        runWithAuthIdentity(
            {
                provider,
                userId,
                boundAccounts: result.boundAccounts,
            },
            () => {
                expect(authIdentityOwnsAccount(ACCOUNT)).toBe(true)
                expect(upgradeRateIdentity(ACCOUNT)).toBe('user_oidc_1')
            },
        )
    })

    it('verifies a raw token through the identity interface', async () => {
        const provider = stubProvider({
            name: 'stub-oidc',
            result: {
                ok: true,
                userId: 'user_oidc_1',
                boundAccounts: [ACCOUNT],
            },
        })
        const result = await provider.verify('oidc-token', {
            env: {} as Env,
            nowSeconds: 1_700_000_000,
        })
        expect(result).toEqual({
            ok: true,
            provider: 'stub-oidc',
            userId: 'user_oidc_1',
            boundAccounts: [ACCOUNT],
        })
    })

    it('namespaces privy and oidc rate-limit keys', () => {
        expect(
            rateLimitIdentityKey({ provider: 'privy', userId: 'did:privy:User' }),
        ).toBe('privy:did:privy:user')
        expect(
            rateLimitIdentityKey({
                provider: 'oidc',
                userId: 'User',
                issuer: 'https://Issuer-A.Example',
            }),
        ).toBe('oidc:https://issuer-a.example:user')
        expect(
            rateLimitIdentityKey({
                provider: 'oidc',
                userId: 'User',
                issuer: 'https://Issuer-B.Example',
            }),
        ).toBe('oidc:https://issuer-b.example:user')
        expect(
            rateLimitIdentityKey({ provider: 'privy', userId: 'User' }),
        ).not.toBe(rateLimitIdentityKey({ provider: 'oidc', userId: 'User', issuer: 'https://issuer.example' }))
    })
})
