import { env as workerEnv } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import type { JsonRpcRequest } from '../src/rpc/types'

const FAKE_KEY = 'fake-alchemy-key-0123456789abcdef'

const RPC_URL = `http://127.0.0.1:1/v2/${FAKE_KEY}`

const QUOTE_SIGNING_SECRET = 'quote-secret-do-not-leak-4242'

const EOA = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const env = {
    ...workerEnv,
    RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
    CHAIN_IDS: '31337',
    CONTEXT: 'local',
    RPC_URL,
    QUOTE_SIGNING_SECRET,
    ORCHESTRATOR_31337: '0x1000000000000000000000000000000000000001',
    SIMPLE_FUNDER_31337: '0x1000000000000000000000000000000000000002',
    SIMULATOR_31337: '0x1000000000000000000000000000000000000003',
    ACCOUNT_31337: '0x1000000000000000000000000000000000000004',
    ACCOUNT_PROXY_31337: '0x1000000000000000000000000000000000000005',
    SIMPLE_SETTLER_31337: '0x1000000000000000000000000000000000000006',
    ESCROW_31337: '0x1000000000000000000000000000000000000007',
    MULTI_SIG_SIGNER_31337: '0x1000000000000000000000000000000000000008',
}

const prepareCallsRequest: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'wallet_prepareCalls',
    params: [{ from: EOA, chain_id: '0x7a69', calls: [{ to: EOA, value: '0x0' }] }],
}

async function post(
    request: JsonRpcRequest,
    bindings: typeof env,
): Promise<{ status: number; text: string }> {
    const response = await worker.fetch(
        new Request('https://relayer.example.com/', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
        }),
        bindings,
    )

    return { status: response.status, text: await response.text() }
}

function expectNoSecrets(text: string) {
    expect(text).not.toContain(FAKE_KEY)
    expect(text).not.toContain('127.0.0.1:1')
    expect(text).not.toContain(QUOTE_SIGNING_SECRET)
}

describe('client-facing error text', () => {
    it('JSON-RPC error omits the RPC URL and its key when the RPC call fails', async () => {
        const { status, text } = await post(prepareCallsRequest, env)

        expectNoSecrets(text)
        expect(status).toBe(200)
        expect(JSON.parse(text)).toMatchObject({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32004, message: 'Simulation failed' },
        })
    })

    it('onError omits the RPC URL and configured secrets', async () => {
        const throwingEnv = { ...env }

        Object.defineProperty(throwingEnv, 'CORS_ALLOWED_ORIGINS', {
            get() {
                throw new Error(`fetch to ${RPC_URL} failed (signing secret ${QUOTE_SIGNING_SECRET})`)
            },
        })

        const { status, text } = await post(prepareCallsRequest, throwingEnv)

        expectNoSecrets(text)
        expect(status).toBe(500)
        expect(JSON.parse(text)).toEqual({ success: false, error: expect.any(String) })
    })
})
