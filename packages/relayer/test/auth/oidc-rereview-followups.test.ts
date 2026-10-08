import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { getAddress, type Address } from 'viem'

import { runWithAuthIdentity } from '../../src/auth/identity'
import { readOidcConfig } from '../../src/auth/oidc-config'
import { decideErc8128Signer } from '../../src/auth/erc8128/signer-policy'
import { walletBindingStub } from '../../src/auth/wallet-binding-client'
import { validateEnv } from '../../src/config'
import { isLocalDevContext } from '../../src/config/runtime-context'
import { handleIssueBindNonce } from '../../src/rpc/methods/issueBindNonce'
import { INVALID_PARAMS } from '../../src/rpc/errors'
import type { Env } from '../../src/types/env'
import { testEnv, workerEnv } from '../helpers/env'

const ISSUER = 'https://rereview.example'

const NOW = 1_800_000_000

function baseEnv(overrides: Partial<Env> = {}): Env {
    const worker = workerEnv(env)

    return {
        ...worker,
        PRIVY_ENABLED: 'false',
        OIDC_ENABLED: 'false',
        CONTEXT: 'local',
        CHAIN_IDS: '31337',
        WALLET_BINDING: worker.WALLET_BINDING,
        ...overrides,
    }
}

function address(n: number): Address {
    return getAddress(`0x${(0xc000 + n).toString(16).padStart(40, '0')}`)
}

describe('oidc rereview follow-ups', () => {
    it('does not spend the subject budget when the IP bucket is full', async () => {
        const store = walletBindingStub(baseEnv())
        const ip = '198.51.100.77'

        for (let subject = 0; subject < 4; subject++) {
            for (let attempt = 0; attempt < 5; attempt++) {
                await store.issueNonce({
                    issuer: ISSUER,
                    subject: `ip-filler-${subject}`,
                    address: address(subject * 5 + attempt),
                    chainId: 31337,
                    nowSeconds: NOW,
                    ttlSeconds: 60,
                    ip,
                })
            }
        }

        const victim = 'budget-victim'

        for (let attempt = 0; attempt < 5; attempt++) {
            const denied = await store.issueNonce({
                issuer: ISSUER,
                subject: victim,
                address: address(100 + attempt),
                chainId: 31337,
                nowSeconds: NOW,
                ttlSeconds: 60,
                ip,
            })

            expect(denied).toMatchObject({ ok: false, reason: 'rate_limited' })
        }

        const recovered: Array<{ ok: boolean }> = []

        for (let attempt = 0; attempt < 5; attempt++) {
            recovered.push(
                await store.issueNonce({
                    issuer: ISSUER,
                    subject: victim,
                    address: address(200 + attempt),
                    chainId: 31337,
                    nowSeconds: NOW + 2 + attempt * 2,
                    ttlSeconds: 1,
                    ip: `203.0.113.${attempt + 1}`,
                }),
            )
        }

        expect(recovered.map((result) => result.ok)).toEqual([true, true, true, true, true])

        const sixth = await store.issueNonce({
            issuer: ISSUER,
            subject: victim,
            address: address(210),
            chainId: 31337,
            nowSeconds: NOW + 20,
            ttlSeconds: 1,
            ip: '203.0.113.90',
        })

        expect(sixth).toMatchObject({ ok: false, reason: 'rate_limited' })
    })

    it('refuses wallet_issueBindNonce when CONTEXT is unset or blank', async () => {
        const account = address(400)
        const identity = { provider: 'oidc' as const, userId: 'missing-context', issuer: ISSUER }

        for (const context of [undefined, '', '   ']) {
            await expect(
                runWithAuthIdentity(identity, () =>
                    handleIssueBindNonce(
                        { address: account, chainId: '0x7a69' },
                        {
                            env: baseEnv({ CONTEXT: context, CHAIN_IDS: '31337' }),
                            request: new Request('https://relayer.local/', {
                                headers: { 'cf-connecting-ip': '203.0.113.90' },
                            }),
                        },
                    ),
                ),
            ).rejects.toMatchObject({ code: INVALID_PARAMS })
        }
    })

    it('keeps http JWKS, optional quote HMAC, and open ERC-8128 on local only', () => {
        const httpJwks = testEnv({
            OIDC_ENABLED: 'true',
            OIDC_ISSUER: 'https://issuer.example',
            OIDC_JWKS_URL: 'http://issuer.example/jwks',
            OIDC_CLIENT_ID: 'client_123',
        })

        const stranger: Address = '0x1111111111111111111111111111111111111111'
        const owner: Address = '0x2222222222222222222222222222222222222222'

        const binding = {
            accounts: [{ eoa: owner, chainId: 84532 }],
            otherProtectedMethods: [],
        }

        const devEnv = testEnv({
            RPC_URL: 'http://127.0.0.1:8545',
            CHAIN_IDS: '84532',
            CONTEXT: 'dev',
            QUOTE_SIGNING_SECRET: '',
            PRIVY_ENABLED: 'false',
        })

        expect({
            devHttp: readOidcConfig({ ...httpJwks, CONTEXT: 'dev' }).ok,
            localHttp: readOidcConfig({ ...httpJwks, CONTEXT: 'local' }).ok,
            devQuoteRequired: validateEnv(devEnv).missing.includes('QUOTE_SIGNING_SECRET'),
            devErcOpen: decideErc8128Signer({
                env: { CONTEXT: 'dev' },
                signer: stranger,
                binding,
            }).ok,
            localErcOpen: decideErc8128Signer({
                env: { CONTEXT: 'local' },
                signer: stranger,
                binding,
            }).ok,
            devIsLocal: isLocalDevContext({ CONTEXT: 'dev' }),
            localIsLocal: isLocalDevContext({ CONTEXT: 'local' }),
        }).toEqual({
            devHttp: false,
            localHttp: true,
            devQuoteRequired: true,
            devErcOpen: false,
            localErcOpen: true,
            devIsLocal: false,
            localIsLocal: true,
        })
    })
})
