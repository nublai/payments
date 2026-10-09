import { beforeEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { bytesToHex, encodeAbiParameters } from 'viem'
import { signRequest, type EthHttpSigner } from '@slicekit/erc8128'

import {
    verifyErc8128Request as verifyErc8128RequestImpl,
    type Erc8128Config,
    type Erc8128VerificationContext,
    type NonceStore,
} from '../../src/auth/erc8128/verify'
import { mockedErc8128ChainClient } from '../helpers/fakes'

const { client, mockGetCode, mockReadContract, mockVerifyMessage } = mockedErc8128ChainClient()

function verifyErc8128Request(ctx: Erc8128VerificationContext, cfg: Erc8128Config) {
    return verifyErc8128RequestImpl(ctx, {
        ...cfg,
        getChainClient: () => client,
    })
}

const account = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945382db9f6c0b4b7f3adf8f13e9f5b5b6c5a5',
)

function createSigner(chainId: number): EthHttpSigner {
    return {
        chainId,
        address: account.address,
        signMessage: async (message) =>
            account.signMessage({ message: { raw: bytesToHex(message) } }),
    }
}

async function createSignedRequest(args?: {
    method?: string
    url?: string
    body?: string
    nonce?: string
    created?: number
    expires?: number
    binding?: 'request-bound' | 'class-bound'
    components?: string[]
}): Promise<Request> {
    const method = args?.method ?? 'POST'
    const url = args?.url ?? 'https://relayer.example.com/'
    const body = args?.body ?? '{"hello":"world"}'
    const created = args?.created ?? Math.floor(Date.now() / 1000) - 5
    const expires = args?.expires ?? created + 60
    const nonce = args?.nonce ?? 'nonce-1'

    const req = new Request(url, {
        method,
        body,
        headers: { 'content-type': 'application/json' },
    })

    return signRequest(req, createSigner(8453), {
        label: 'eth',
        binding: args?.binding ?? 'request-bound',
        components: args?.components,
        replay: 'non-replayable',
        created,
        expires,
        nonce,
        contentDigest: 'auto',
    })
}

describe('verifyErc8128Request', () => {
    let nonceSeen: Set<string>
    let nonceStore: NonceStore

    beforeEach(() => {
        mockGetCode.mockReset()
        mockGetCode.mockResolvedValue(undefined)
        mockReadContract.mockReset()
        mockReadContract.mockRejectedValue(new Error('missing key'))
        mockVerifyMessage.mockReset()
        mockVerifyMessage.mockResolvedValue(false)
        nonceSeen = new Set<string>()
        nonceStore = {
            consumeNonce: vi.fn(async (replayKey: string) => {
                if (nonceSeen.has(replayKey)) return false
                nonceSeen.add(replayKey)

                return true
            }),
        }
    })

    it('accepts valid request-bound, non-replayable EOA signature', async () => {
        const req = await createSignedRequest()

        const result = await verifyErc8128Request(
            {
                env: { CHAIN_IDS: '8453', CONTEXT: 'local' },
                request: req,
                nowSeconds: Math.floor(Date.now() / 1000),
            },
            {
                maxValiditySeconds: 120,
                clockSkewSeconds: 30,
                requireRequestBound: true,
                requireNonReplayable: true,
                nonceStore,
            },
        )

        expect(result.ok).toBe(true)

        if (result.ok) {
            expect(result.signerType).toBe('EOA')
            expect(result.keyId.chainId).toBe(8453)
            expect(result.keyId.address.toLowerCase()).toBe(account.address.toLowerCase())
        }
    })

    it('rejects when required request-bound components are missing', async () => {
        const req = await createSignedRequest({
            url: 'https://relayer.example.com/?a=1',
            binding: 'class-bound',
            components: ['@authority'],
        })

        const result = await verifyErc8128Request(
            {
                env: { CHAIN_IDS: '8453', CONTEXT: 'local' },
                request: req,
                nowSeconds: Math.floor(Date.now() / 1000),
            },
            {
                maxValiditySeconds: 120,
                clockSkewSeconds: 30,
                requireRequestBound: true,
                requireNonReplayable: true,
                nonceStore,
            },
        )

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'INVALID_COVERAGE',
            }),
        )
    })

    it('rejects replayed nonce for same keyid', async () => {
        const req = await createSignedRequest({ nonce: 'same-nonce' })

        const first = await verifyErc8128Request(
            {
                env: { CHAIN_IDS: '8453', CONTEXT: 'local' },
                request: req.clone(),
                nowSeconds: Math.floor(Date.now() / 1000),
            },
            {
                maxValiditySeconds: 120,
                clockSkewSeconds: 30,
                requireRequestBound: true,
                requireNonReplayable: true,
                nonceStore,
            },
        )

        const second = await verifyErc8128Request(
            {
                env: { CHAIN_IDS: '8453', CONTEXT: 'local' },
                request: req,
                nowSeconds: Math.floor(Date.now() / 1000),
            },
            {
                maxValiditySeconds: 120,
                clockSkewSeconds: 30,
                requireRequestBound: true,
                requireNonReplayable: true,
                nonceStore,
            },
        )

        expect(first.ok).toBe(true)
        expect(second).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'REPLAYED_NONCE',
            }),
        )
    })

    it('rejects expired signatures', async () => {
        const now = Math.floor(Date.now() / 1000)

        const req = await createSignedRequest({
            created: now - 90,
            expires: now - 10,
        })

        const result = await verifyErc8128Request(
            {
                env: { CHAIN_IDS: '8453', CONTEXT: 'local' },
                request: req,
                nowSeconds: now,
            },
            {
                maxValiditySeconds: 120,
                clockSkewSeconds: 5,
                requireRequestBound: true,
                requireNonReplayable: true,
                nonceStore,
            },
        )

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'INVALID_TIME',
            }),
        )
    })

    it('rejects tampered body when content-digest is covered', async () => {
        const req = await createSignedRequest()
        req.headers.set('content-digest', 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:')

        const result = await verifyErc8128Request(
            {
                env: { CHAIN_IDS: '8453', CONTEXT: 'local' },
                request: req,
                nowSeconds: Math.floor(Date.now() / 1000),
            },
            {
                maxValiditySeconds: 120,
                clockSkewSeconds: 30,
                requireRequestBound: true,
                requireNonReplayable: true,
                nonceStore,
            },
        )

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'BAD_CONTENT_DIGEST',
            }),
        )
    })

    it('rejects unsupported chain in keyid', async () => {
        const req = await signRequest(
            new Request('https://relayer.example.com/', {
                method: 'POST',
                body: '{"hello":"world"}',
                headers: { 'content-type': 'application/json' },
            }),
            createSigner(1),
            {
                replay: 'non-replayable',
                nonce: 'nonce-chain',
                binding: 'request-bound',
                contentDigest: 'auto',
            },
        )

        const result = await verifyErc8128Request(
            {
                env: { CHAIN_IDS: '8453', CONTEXT: 'local' },
                request: req,
                nowSeconds: Math.floor(Date.now() / 1000),
            },
            {
                maxValiditySeconds: 120,
                clockSkewSeconds: 30,
                requireRequestBound: true,
                requireNonReplayable: true,
                nonceStore,
            },
        )

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'UNSUPPORTED_CHAIN',
            }),
        )
    })
})

describe('verifyErc8128Request signer binding', () => {
    let nonceStore: NonceStore

    beforeEach(() => {
        mockGetCode.mockReset()
        mockGetCode.mockResolvedValue(undefined)
        mockReadContract.mockReset()
        mockReadContract.mockRejectedValue(new Error('missing key'))
        mockVerifyMessage.mockReset()
        mockVerifyMessage.mockResolvedValue(false)
        const nonceSeen = new Set<string>()
        nonceStore = {
            consumeNonce: vi.fn(async (replayKey: string) => {
                if (nonceSeen.has(replayKey)) return false
                nonceSeen.add(replayKey)

                return true
            }),
        }
    })

    const limits = {
        maxValiditySeconds: 120,
        clockSkewSeconds: 30,
        requireRequestBound: true,
        requireNonReplayable: true,
    }

    async function verify(req: Request, env: Record<string, string>) {
        return verifyErc8128Request(
            {
                env,
                request: req,
                nowSeconds: Math.floor(Date.now() / 1000),
            },
            { ...limits, nonceStore },
        )
    }

    function sendBody(account: { eoa?: string; authSigner?: string; chainId?: string }): string {
        return JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'wallet_sendPreparedCalls',
            params: [
                {
                    context: {
                        quote: {
                            quotes: [
                                {
                                    chainId: account.chainId,
                                    intent: { eoa: account.eoa },
                                    authSigner: account.authSigner,
                                },
                            ],
                        },
                    },
                    signature: '0x',
                },
            ],
        })
    }

    it('rejects a self-recovering key that is not allowlisted and not the intent account', async () => {
        const req = await createSignedRequest()
        const result = await verify(req, { CHAIN_IDS: '8453', CONTEXT: 'prod' })

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'SIGNER_NOT_ALLOWED',
            }),
        )
    })

    it('rejects every chain when CHAIN_IDS is empty', async () => {
        const req = await createSignedRequest()
        const result = await verify(req, { CHAIN_IDS: '', CONTEXT: 'prod' })

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'UNSUPPORTED_CHAIN',
            }),
        )
    })

    it('accepts the intent EOA outside local', async () => {
        const req = await createSignedRequest({
            body: sendBody({ eoa: account.address }),
        })

        const result = await verify(req, { CHAIN_IDS: '8453', CONTEXT: 'prod' })

        expect(result.ok).toBe(true)
    })

    it('rejects a key that is not the intent EOA or the quote authSigner', async () => {
        const req = await createSignedRequest({
            body: sendBody({
                eoa: '0x2222222222222222222222222222222222222222',
                authSigner: '0x3333333333333333333333333333333333333333',
            }),
        })

        const result = await verify(req, { CHAIN_IDS: '8453', CONTEXT: 'stage' })

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'SIGNER_NOT_ALLOWED',
            }),
        )
    })

    it('rejects a client-supplied authSigner that is not an on-chain key of the account', async () => {
        const req = await createSignedRequest({
            body: sendBody({
                eoa: '0x2222222222222222222222222222222222222222',
                authSigner: account.address,
                chainId: '0x2105',
            }),
        })

        const result = await verify(req, { CHAIN_IDS: '8453', CONTEXT: 'prod' })

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'SIGNER_NOT_ALLOWED',
            }),
        )
    })

    it('accepts a live on-chain key of the intent account without a client authSigner', async () => {
        const publicKey = encodeAbiParameters([{ type: 'address' }], [account.address])
        mockReadContract.mockResolvedValue({
            expiry: 0n,
            keyType: 0,
            isSuperAdmin: false,
            publicKey,
        })

        const req = await createSignedRequest({
            body: sendBody({
                eoa: '0x2222222222222222222222222222222222222222',
                chainId: '0x2105',
            }),
        })

        const result = await verify(req, { CHAIN_IDS: '8453', CONTEXT: 'prod' })

        expect(result.ok).toBe(true)
        expect(mockReadContract).toHaveBeenCalled()
    })

    it('rejects a prepare that only names the signer in session_key', async () => {
        const sessionKey = encodeAbiParameters([{ type: 'address' }], [account.address])

        const req = await createSignedRequest({
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'wallet_prepareCalls',
                params: [
                    {
                        from: '0x2222222222222222222222222222222222222222',
                        chain_id: '0x2105',
                        calls: [],
                        session_key: sessionKey,
                    },
                ],
            }),
        })

        const result = await verify(req, { CHAIN_IDS: '8453', CONTEXT: 'prod' })

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'SIGNER_NOT_ALLOWED',
            }),
        )
    })

    it('requires the allowlist for another protected method in the same batch', async () => {
        const req = await createSignedRequest({
            body: JSON.stringify([
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'wallet_sendPreparedCalls',
                    params: [
                        {
                            context: {
                                quote: {
                                    quotes: [
                                        {
                                            chainId: '0x2105',
                                            intent: { eoa: account.address },
                                        },
                                    ],
                                },
                            },
                            signature: '0x',
                        },
                    ],
                },
                {
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'wallet_getKeys',
                    params: [{ address: '0x2222222222222222222222222222222222222222' }],
                },
            ]),
        })

        const result = await verify(req, {
            CHAIN_IDS: '8453',
            CONTEXT: 'prod',
            AUTH_PROTECTED_METHODS: 'wallet_sendPreparedCalls,wallet_getKeys',
        })

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'SIGNER_NOT_ALLOWED',
            }),
        )
    })

    it('accepts an allowlisted signer that is not the intent EOA', async () => {
        const req = await createSignedRequest()

        const result = await verify(req, {
            CHAIN_IDS: '8453',
            CONTEXT: 'prod',
            ERC8128_ALLOWED_SIGNERS: account.address,
        })

        expect(result.ok).toBe(true)
    })

    it('rejects a signer missing from the allowlist even on local when the list is set', async () => {
        const req = await createSignedRequest()

        const result = await verify(req, {
            CHAIN_IDS: '8453',
            CONTEXT: 'local',
            ERC8128_ALLOWED_SIGNERS: '0x2222222222222222222222222222222222222222',
        })

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'SIGNER_NOT_ALLOWED',
            }),
        )
    })
})
