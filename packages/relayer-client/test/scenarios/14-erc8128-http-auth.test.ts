import { describe, expect, it } from 'vitest'
import { signRequest, type EthHttpSigner } from '@slicekit/erc8128'
import { parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { toHex } from 'viem'

import { createJsonRpcTransport, JsonRpcClientError } from '../../src/transport'
import {
    RELAYER_URL,
    TEST_CHAIN_ID,
    TEST_ACCOUNTS,
    TEST_CONTRACTS,
    testChain,
    ANVIL_RPC_URL,
} from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestClient } from '../helpers/client'
import { createEphemeralAccount, upgradeDelegatedAccount } from '../helpers/account'

const describeIfAuthEnabled = process.env.ERC8128_ENABLED === 'true' ? describe : describe.skip

function createSigner(chainId: number): EthHttpSigner {
    const account = privateKeyToAccount(TEST_ACCOUNTS.relayer.privateKey)

    return {
        chainId,
        address: account.address,
        signMessage: async (message) => account.signMessage({ message: { raw: toHex(message) } }),
    }
}

function createSignedTransport(chainId: number = TEST_CHAIN_ID) {
    return createJsonRpcTransport(RELAYER_URL, {
        httpAuth: {
            signer: createSigner(chainId),
        },
    })
}

function createFailingSigner(chainId: number): EthHttpSigner {
    const account = privateKeyToAccount(TEST_ACCOUNTS.relayer.privateKey)

    return {
        chainId,
        address: account.address,
        signMessage: async () => {
            throw new Error('forced sign failure')
        },
    }
}

type RpcErrorBody = {
    error?: { code?: number; message?: string }
}

async function postJson(request: Request): Promise<RpcErrorBody> {
    const response = await fetch(request)

    return response.json()
}

describeIfAuthEnabled('ERC-8128 HTTP auth', () => {
    it('rejects protected method without auth and accepts signed request past auth layer', async () => {
        const unsignedTransport = createJsonRpcTransport(RELAYER_URL)

        await expect(
            unsignedTransport.request('wallet_sendPreparedCalls', {
                context: {},
                signature: '0x',
            }),
        ).rejects.toMatchObject({
            code: -32001,
            message: 'Unauthorized',
        })

        const signedTransport = createSignedTransport()

        try {
            await signedTransport.request('wallet_sendPreparedCalls', {
                context: {},
                signature: '0x',
            })
        } catch (error) {
            expect(error).toBeInstanceOf(JsonRpcClientError)

            if (!(error instanceof JsonRpcClientError)) throw error

            // Signed request should get past auth, then fail deeper validation.
            expect(error.code).not.toBe(-32001)
        }
    })

    it('allows unsigned unprotected wallet_health', async () => {
        const transport = createJsonRpcTransport(RELAYER_URL)
        const result = await transport.request<string>('wallet_health')
        expect(result).toBe('ok')
    })

    it('fails closed by default when signing fails', async () => {
        const transport = createJsonRpcTransport(RELAYER_URL, {
            httpAuth: {
                signer: createFailingSigner(TEST_CHAIN_ID),
            },
        })

        await expect(transport.request('wallet_health')).rejects.toThrow('forced sign failure')
    })

    it('rejects unsupported chain in keyid', async () => {
        const signedTransport = createSignedTransport(1)

        await expect(
            signedTransport.request('wallet_sendPreparedCalls', {
                context: {},
                signature: '0x',
            }),
        ).rejects.toMatchObject({
            code: -32001,
            message: 'Unauthorized',
        })
    })

    it('enforces auth for mixed batch and accepts signed mixed batch past auth layer', async () => {
        const unsignedTransport = createJsonRpcTransport(RELAYER_URL)

        await expect(
            unsignedTransport.requestBatch([
                { method: 'wallet_health' },
                { method: 'wallet_sendPreparedCalls', params: { context: {}, signature: '0x' } },
            ]),
        ).rejects.toMatchObject({
            code: -32001,
            message: 'Unauthorized',
        })

        const signedTransport = createSignedTransport()

        try {
            await signedTransport.requestBatch([
                { method: 'wallet_health' },
                { method: 'wallet_sendPreparedCalls', params: { context: {}, signature: '0x' } },
            ])
        } catch (error) {
            expect(error).toBeInstanceOf(JsonRpcClientError)

            if (!(error instanceof JsonRpcClientError)) throw error

            expect(error.code).not.toBe(-32001)
        }
    })

    it('rejects tampered signed request body', async () => {
        const signer = createSigner(TEST_CHAIN_ID)

        const rawBody = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'wallet_sendPreparedCalls',
            params: [{ context: {}, signature: '0x' }],
        })

        const signed = await signRequest(
            new Request(RELAYER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: rawBody,
            }),
            signer,
            {
                replay: 'non-replayable',
                binding: 'request-bound',
                contentDigest: 'auto',
            },
        )

        const tampered = new Request(RELAYER_URL, {
            method: 'POST',
            headers: signed.headers,
            // mutate request body after signature
            body: rawBody.replace('"signature":"0x"', '"signature":"0x11"'),
        })

        const response = await postJson(tampered)

        expect(response.error?.code).toBe(-32001)
        expect(response.error?.message).toBe('Unauthorized')
    })

    it('rejects replay of same signed request', async () => {
        const signer = createSigner(TEST_CHAIN_ID)
        const nonce = `replay-${Date.now()}`

        const signed = await signRequest(
            new Request(RELAYER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 7,
                    method: 'wallet_sendPreparedCalls',
                    params: [{ context: {}, signature: '0x' }],
                }),
            }),
            signer,
            {
                replay: 'non-replayable',
                binding: 'request-bound',
                contentDigest: 'auto',
                nonce,
                created: Math.floor(Date.now() / 1000),
                expires: Math.floor(Date.now() / 1000) + 60,
            },
        )

        const first = await postJson(signed.clone())
        const second = await postJson(signed)

        // First call should pass auth and fail later (invalid params/context), but not Unauthorized.
        expect(first.error?.code).not.toBe(-32001)

        // Same signed request should fail replay protection.
        expect(second.error?.code).toBe(-32001)
        expect(second.error?.message).toBe('Unauthorized')
    })

    it('accepts delegated account signer for protected request (smart-account path)', async () => {
        // 1. Create/fund a fresh account.
        const { account, privateKey } = createEphemeralAccount()
        await setBalance(account.address, parseEther('1'))

        // 2. Create relayer test client (same pattern used by scenario helpers).
        const client = createRelayerTestClient({
            chain: testChain,
            rpcUrl: ANVIL_RPC_URL,
            relayerUrl: RELAYER_URL,
        })

        // 3. Run standard delegation flow helper.
        const upgrade = await upgradeDelegatedAccount({
            client,
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: TEST_CONTRACTS.accountProxy,
            chainId: TEST_CHAIN_ID,
        })

        expect(upgrade.success).toBe(true)

        const delegatedCode = await client.getCode({ address: account.address })
        expect(delegatedCode?.startsWith('0xef0100')).toBe(true)

        // 4. Sign HTTP requests as delegated account and ensure auth path accepts it.
        const signedTransport = createJsonRpcTransport(RELAYER_URL, {
            httpAuth: {
                signer: {
                    chainId: TEST_CHAIN_ID,
                    address: account.address,
                    signMessage: async (message) =>
                        account.signMessage({ message: { raw: toHex(message) } }),
                },
            },
        })

        try {
            await signedTransport.request('wallet_sendPreparedCalls', {
                context: {},
                signature: '0x',
            })
        } catch (error) {
            expect(error).toBeInstanceOf(JsonRpcClientError)

            if (!(error instanceof JsonRpcClientError)) throw error

            // Delegated signer should pass HTTP auth; deeper validation can still fail.
            expect(error.code).not.toBe(-32001)
        }
    })
})
