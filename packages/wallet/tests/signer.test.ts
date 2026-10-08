import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { privateKeyToAccount } from 'viem/accounts'
import { runSessionDaemon } from '../src/lib/session-daemon'
import { SessionDaemonClient } from '../src/lib/session-daemon-client'
import {
    resolveSessionSigner,
    SessionSignerDaemonError,
    SessionSignerExpiredError,
} from '../src/lib/signer'
import { installFormerProdDeployments } from './helpers/former-deployment-env'

let restoreFormerProdDeployments = () => {}

beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})

afterAll(() => {
    restoreFormerProdDeployments()
})

const TEST_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945388cf6f64f6b5f8a6d4f7e7a3fa8f8ff7f0' as const

const MISMATCH_PRIVATE_KEY =
    '0x8b3a350cf5c34c9194caeec40f2ce7f2d875a63f4f4e7e9c95e5d72f9f6f6d88' as const

const originalSocket = process.env.TW_AGENT_SOCK

afterEach(() => {
    if (originalSocket) {
        process.env.TW_AGENT_SOCK = originalSocket
    } else {
        delete process.env.TW_AGENT_SOCK
    }
})

function makeTypedData() {
    return {
        domain: { name: 'signer-test' },
        types: {
            EIP712Domain: [{ name: 'name', type: 'string' }],
            Intent: [{ name: 'nonce', type: 'uint256' }],
        },
        primaryType: 'Intent' as const,
        message: { nonce: 1n },
    }
}

function makeSessionKeystore(sessionAddress: string) {
    return {
        version: 2,
        name: 'default',
        checkpoint: 'complete',
        createdAt: new Date().toISOString(),
        network: {
            env: 'prod',
            relayerUrl: 'https://example.com',
            rpcUrl: 'https://example-rpc.com',
            chainId: 8453,
        },
        kdf: {
            name: 'argon2id' as const,
            params: {
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1,
                hashLength: 32,
                salt: 'Zm9v',
            },
        },
        crypto: { algorithm: 'aes-256-gcm' as const },
        addresses: {
            delegated: '0x1111111111111111111111111111111111111111',
            session: sessionAddress,
        },
        secrets: {
            sessionPrivateKey: {
                nonce: '',
                ciphertext: '',
                tag: '',
            },
        },
    }
}

test('resolveSessionSigner returns direct signer when daemon unavailable', async () => {
    delete process.env.TW_AGENT_SOCK

    const directSign = mock(async () => '0xabc' as const)

    const signer = await resolveSessionSigner({
        sessionName: 'default',
        sessionKeystore: makeSessionKeystore(privateKeyToAccount(TEST_PRIVATE_KEY).address),
        chainId: 8453,
        resolvePassword: async () => 'pw',
        decryptSessionKeystore: async () => ({ sessionPrivateKey: TEST_PRIVATE_KEY }),
        directSignTypedData: directSign,
    })

    expect(signer.mode).toBe('direct')
    await signer.signTypedData({ privateKey: TEST_PRIVATE_KEY, typedData: makeTypedData() })
    expect(directSign).toHaveBeenCalledTimes(1)
})

test('resolveSessionSigner uses daemon signer when key is loaded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-signer-test-'))
    process.env.TW_AGENT_SOCK = join(dir, 'session-daemon.sock')

    const daemon = await runSessionDaemon()
    const client = new SessionDaemonClient()
    const account = privateKeyToAccount(TEST_PRIVATE_KEY)

    const load = await client.loadKey({
        name: 'default',
        privateKey: TEST_PRIVATE_KEY,
        address: account.address,
        durationSeconds: 10,
        phraseConfirmed: true,
        env: 'prod',
    })

    expect(load?.ok).toBe(true)

    const signer = await resolveSessionSigner({
        sessionName: 'default',
        sessionKeystore: makeSessionKeystore(account.address),
        chainId: 8453,
        resolvePassword: async () => 'pw',
        decryptSessionKeystore: async () => ({ sessionPrivateKey: TEST_PRIVATE_KEY }),
    })

    expect(signer.mode).toBe('daemon')

    const signature = await signer.signTypedData({
        privateKey: TEST_PRIVATE_KEY,
        typedData: makeTypedData(),
    })

    const direct = await account.signTypedData(makeTypedData())
    expect(signature).toBe(direct)

    await daemon.stop()
})

test('resolveSessionSigner falls back to direct signer when daemon key address mismatches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-signer-test-'))
    process.env.TW_AGENT_SOCK = join(dir, 'session-daemon.sock')

    const daemon = await runSessionDaemon()
    const client = new SessionDaemonClient()
    const daemonAccount = privateKeyToAccount(TEST_PRIVATE_KEY)
    const directAccount = privateKeyToAccount(MISMATCH_PRIVATE_KEY)

    const load = await client.loadKey({
        name: 'default',
        privateKey: TEST_PRIVATE_KEY,
        address: daemonAccount.address,
        durationSeconds: 10,
    })

    expect(load?.ok).toBe(true)

    const directSign = mock(async () => '0xabc' as const)

    const signer = await resolveSessionSigner({
        sessionName: 'default',
        sessionKeystore: makeSessionKeystore(directAccount.address),
        chainId: 8453,
        resolvePassword: async () => 'pw',
        decryptSessionKeystore: async () => ({ sessionPrivateKey: MISMATCH_PRIVATE_KEY }),
        directSignTypedData: directSign,
    })

    expect(signer.mode).toBe('direct')
    await signer.signTypedData({
        privateKey: MISMATCH_PRIVATE_KEY,
        typedData: makeTypedData(),
    })
    expect(directSign).toHaveBeenCalledTimes(1)

    await daemon.stop()
})

test('resolveSessionSigner throws SESSION_EXPIRED and daemon errors from daemon mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-signer-test-'))
    process.env.TW_AGENT_SOCK = join(dir, 'session-daemon.sock')

    const daemon = await runSessionDaemon()
    const client = new SessionDaemonClient()
    const account = privateKeyToAccount(TEST_PRIVATE_KEY)

    const load = await client.loadKey({
        name: 'default',
        privateKey: TEST_PRIVATE_KEY,
        address: account.address,
        durationSeconds: 1,
    })

    expect(load?.ok).toBe(true)

    const signer = await resolveSessionSigner({
        sessionName: 'default',
        sessionKeystore: makeSessionKeystore(account.address),
        chainId: 8453,
        resolvePassword: async () => 'pw',
        decryptSessionKeystore: async () => ({ sessionPrivateKey: TEST_PRIVATE_KEY }),
    })

    await new Promise((resolve) => setTimeout(resolve, 1100))
    await expect(
        signer.signTypedData({ privateKey: TEST_PRIVATE_KEY, typedData: makeTypedData() }),
    ).rejects.toBeInstanceOf(SessionSignerExpiredError)

    const loadAgain = await client.loadKey({
        name: 'default',
        privateKey: TEST_PRIVATE_KEY,
        address: account.address,
        durationSeconds: 10,
    })

    expect(loadAgain?.ok).toBe(true)

    const daemonSigner = await resolveSessionSigner({
        sessionName: 'default',
        sessionKeystore: makeSessionKeystore(account.address),
        chainId: 8453,
        resolvePassword: async () => 'pw',
        decryptSessionKeystore: async () => ({ sessionPrivateKey: TEST_PRIVATE_KEY }),
    })

    await daemon.stop()
    await expect(
        daemonSigner.signTypedData({ privateKey: TEST_PRIVATE_KEY, typedData: makeTypedData() }),
    ).rejects.toBeInstanceOf(SessionSignerDaemonError)
})
