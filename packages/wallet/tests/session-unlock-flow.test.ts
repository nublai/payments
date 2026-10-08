import { expect, mock, test } from 'bun:test'
import { create, toBinary } from '@bufbuild/protobuf'
import { ExportedDeviceSchema } from '@nubl/proto'
import { privateKeyToAccount } from 'viem/accounts'
import type {
    AgentSessionKeystoreV2,
    KeystoreBundle,
    RelayerSessionKeystoreV2,
} from '../src/lib/keystore'
import { LoginProfileError, SessionOnlyProfileError } from '../src/lib/keystore'
import type { SessionDaemonClient } from '../src/lib/session-daemon-client'
import { executeSessionUnlock } from '../src/lib/session-unlock'

const TEST_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945388cf6f64f6b5f8a6d4f7e7a3fa8f8ff7f0' as const

function makeBaseSessionKeystore(): RelayerSessionKeystoreV2 {
    return {
        version: 2,
        createdAt: new Date().toISOString(),
        name: 'agent-alice',
        checkpoint: 'complete',
        network: {
            env: 'prod',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'https://mainnet.base.org',
            chainId: 8453,
        },
        kdf: {
            name: 'argon2id',
            params: {
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1,
                hashLength: 32,
                salt: 'c2FsdA==',
            },
        },
        crypto: { algorithm: 'aes-256-gcm' },
        addresses: {
            session: privateKeyToAccount(TEST_PRIVATE_KEY).address,
            delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        secrets: {
            sessionPrivateKey: {
                nonce: 'nonce',
                ciphertext: 'ciphertext',
                tag: 'tag',
            },
        },
    }
}

function makeAgentSessionKeystore(): AgentSessionKeystoreV2 {
    const base = makeBaseSessionKeystore()
    return {
        ...base,
        kind: 'agent',
        secrets: {
            ...base.secrets,
            encryptionDevice: {
                nonce: 'device-nonce',
                ciphertext: 'device-ciphertext',
                tag: 'device-tag',
            },
        },
    }
}

test('executeSessionUnlock --device sends encryption device + kind to daemon', async () => {
    const exportedDevice = create(ExportedDeviceSchema, {
        pickleKey: 'pickle-key',
        pickledAccount: 'pickled-account',
        hybridGroupSessions: [],
    })
    const expectedDeviceHex = `0x${Buffer.from(toBinary(ExportedDeviceSchema, exportedDevice)).toString('hex')}`
    const loadKey = mock(async (_input: Parameters<SessionDaemonClient['loadKey']>[0]) => ({
        ok: true as const,
        result: {
            name: 'agent-alice',
            address: privateKeyToAccount(TEST_PRIVATE_KEY).address,
            expiresAt: Date.now() + 60_000,
        },
    }))
    const bundle: KeystoreBundle = {
        rootPath: '/tmp/default.keystore.json',
        sessionPath: '/tmp/sessions/default.json',
        root: {
            version: 2,
            createdAt: new Date().toISOString(),
            checkpoint: 'complete',
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
            addresses: {
                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
            sessionRef: { active: 'default', dir: 'sessions' },
            kdf: {
                name: 'argon2id',
                params: {
                    memoryCost: 19456,
                    timeCost: 2,
                    parallelism: 1,
                    hashLength: 32,
                    salt: 'c2FsdA==',
                },
            },
            crypto: { algorithm: 'aes-256-gcm' },
            secrets: {
                rootPrivateKey: {
                    nonce: 'nonce',
                    ciphertext: 'ciphertext',
                    tag: 'tag',
                },
            },
        },
        session: makeBaseSessionKeystore(),
    }

    const result = await executeSessionUnlock(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            sessionName: 'agent-alice',
            password: 'pw',
            duration: '1h',
            device: true,
        },
        {
            readKeystoreBundle: mock(async () => bundle),
            readSessionKeystoreFile: mock(async () => makeAgentSessionKeystore()),
            decryptSessionKeystore: mock(async () => ({ sessionPrivateKey: TEST_PRIVATE_KEY })),
            decryptAgentDevice: mock(async () => exportedDevice),
            createDaemonClient: () => ({ loadKey }),
            sessionRequiresPhrase: async () => false,
            sessionIsSwap: async () => false,
        },
    )

    expect(result.status).toBe('complete')
    expect(loadKey).toHaveBeenCalledTimes(1)
    expect(loadKey.mock.calls[0]?.[0]).toMatchObject({
        name: 'agent-alice',
        privateKey: TEST_PRIVATE_KEY,
        kind: 'agent',
        encryptionDevice: expectedDeviceHex,
    })
})

test('executeSessionUnlock --device rejects non-agent sessions', async () => {
    const bundle: KeystoreBundle = {
        rootPath: '/tmp/default.keystore.json',
        sessionPath: '/tmp/sessions/default.json',
        root: {
            version: 2,
            createdAt: new Date().toISOString(),
            checkpoint: 'complete',
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
            addresses: {
                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
            sessionRef: { active: 'default', dir: 'sessions' },
            kdf: {
                name: 'argon2id',
                params: {
                    memoryCost: 19456,
                    timeCost: 2,
                    parallelism: 1,
                    hashLength: 32,
                    salt: 'c2FsdA==',
                },
            },
            crypto: { algorithm: 'aes-256-gcm' },
            secrets: {
                rootPrivateKey: {
                    nonce: 'nonce',
                    ciphertext: 'ciphertext',
                    tag: 'tag',
                },
            },
        },
        session: makeBaseSessionKeystore(),
    }
    await expect(
        executeSessionUnlock(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'agent-alice',
                password: 'pw',
                device: true,
            },
            {
                readKeystoreBundle: mock(async () => bundle),
                readSessionKeystoreFile: mock(async () => makeBaseSessionKeystore()),
                decryptSessionKeystore: mock(async () => ({ sessionPrivateKey: TEST_PRIVATE_KEY })),
                decryptAgentDevice: mock(async () => {
                    throw new Error('should not be called')
                }),
                createDaemonClient: () => ({
                    loadKey: mock(async () => ({
                        ok: true as const,
                        result: {
                            name: '',
                            address: privateKeyToAccount(TEST_PRIVATE_KEY).address,
                            expiresAt: 0,
                        },
                    })),
                }),
            },
        ),
    ).rejects.toMatchObject({
        code: 'INVALID_SESSION_KIND',
    })
})

test('executeSessionUnlock does not decrypt or load a key when chain permissions are elevated', async () => {
    const decryptSessionKeystore = mock(async () => ({ sessionPrivateKey: TEST_PRIVATE_KEY }))
    const loadKey = mock(async () => ({
        ok: true as const,
        result: {
            name: 'agent-alice',
            address: privateKeyToAccount(TEST_PRIVATE_KEY).address,
            expiresAt: 1,
        },
    }))
    const bundle: KeystoreBundle = {
        rootPath: '/tmp/default.keystore.json',
        sessionPath: '/tmp/sessions/default.json',
        root: {
            version: 2,
            createdAt: new Date().toISOString(),
            checkpoint: 'complete',
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
            addresses: {
                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
            sessionRef: { active: 'default', dir: 'sessions' },
            kdf: {
                name: 'argon2id',
                params: {
                    memoryCost: 19456,
                    timeCost: 2,
                    parallelism: 1,
                    hashLength: 32,
                    salt: 'c2FsdA==',
                },
            },
            crypto: { algorithm: 'aes-256-gcm' },
            secrets: {
                rootPrivateKey: { nonce: 'nonce', ciphertext: 'ciphertext', tag: 'tag' },
            },
        },
        session: makeBaseSessionKeystore(),
    }
    await expect(
        executeSessionUnlock(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'agent-alice',
                password: 'pw',
            },
            {
                readKeystoreBundle: mock(async () => bundle),
                readSessionKeystoreFile: mock(async () => makeBaseSessionKeystore()),
                decryptSessionKeystore,
                createDaemonClient: () => ({ loadKey }),
                sessionRequiresPhrase: async () => true,
            },
        ),
    ).rejects.toThrow(/UNLOCK FULL ACCESS SESSION/)
    expect(decryptSessionKeystore).not.toHaveBeenCalled()
    expect(loadKey).not.toHaveBeenCalled()
})

test('executeSessionUnlock falls back to session.json for login profiles', async () => {
    const loadKey = mock(async () => ({
        ok: true as const,
        result: {
            name: 'agent-alice',
            address: privateKeyToAccount(TEST_PRIVATE_KEY).address,
            expiresAt: Date.now() + 60_000,
        },
    }))
    const readSessionKeystoreFile = mock(async () => makeBaseSessionKeystore())
    const result = await executeSessionUnlock(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            sessionName: 'agent-alice',
            password: 'pw',
        },
        {
            readKeystoreBundle: mock(async () => {
                throw new LoginProfileError()
            }),
            readSessionKeystoreFile,
            decryptSessionKeystore: mock(async () => ({ sessionPrivateKey: TEST_PRIVATE_KEY })),
            decryptAgentDevice: mock(async () => {
                throw new Error('should not be called')
            }),
            createDaemonClient: () => ({ loadKey }),
            sessionRequiresPhrase: async () => false,
            sessionIsSwap: async () => false,
        },
    )

    expect(result.status).toBe('complete')
    expect(readSessionKeystoreFile).toHaveBeenCalledWith('/tmp/session.json')
    expect(loadKey).toHaveBeenCalledTimes(1)
})

test('executeSessionUnlock fails when requested session does not match session-only profile name', async () => {
    await expect(
        executeSessionUnlock(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'default',
                password: 'pw',
            },
            {
                readKeystoreBundle: mock(async () => {
                    throw new LoginProfileError()
                }),
                readSessionKeystoreFile: mock(async () => makeBaseSessionKeystore()),
            },
        ),
    ).rejects.toMatchObject({
        code: 'SESSION_UNLOCK_FAILED',
        message: expect.stringContaining('Session "default" not found'),
    })
})

test('executeSessionUnlock falls back to session.json for SessionOnlyProfileError', async () => {
    const loadKey = mock(async () => ({
        ok: true as const,
        result: {
            name: 'agent-alice',
            address: privateKeyToAccount(TEST_PRIVATE_KEY).address,
            expiresAt: Date.now() + 60_000,
        },
    }))
    const readSessionKeystoreFile = mock(async () => makeBaseSessionKeystore())
    const result = await executeSessionUnlock(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            sessionName: 'agent-alice',
            password: 'pw',
        },
        {
            readKeystoreBundle: mock(async () => {
                throw new SessionOnlyProfileError('/tmp/default.keystore.json')
            }),
            readSessionKeystoreFile,
            decryptSessionKeystore: mock(async () => ({ sessionPrivateKey: TEST_PRIVATE_KEY })),
            decryptAgentDevice: mock(async () => {
                throw new Error('should not be called')
            }),
            createDaemonClient: () => ({ loadKey }),
            sessionRequiresPhrase: async () => false,
            sessionIsSwap: async () => false,
        },
    )

    expect(result.status).toBe('complete')
    expect(readSessionKeystoreFile).toHaveBeenCalledWith('/tmp/session.json')
    expect(loadKey).toHaveBeenCalledTimes(1)
})
