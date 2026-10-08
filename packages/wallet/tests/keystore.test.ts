import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'bun:test'
import { create, toBinary } from '@bufbuild/protobuf'
import { ExportedDeviceSchema } from '@nubl/proto'
import { generatePrivateKey } from 'viem/accounts'
import {
    LoginProfileError,
    decryptBufferSecret,
    createRootKeystore,
    createSessionKeystore,
    decryptRootKeystore,
    decryptSessionKeystore,
    deriveKeystoreKey,
    encryptBufferSecret,
    isAgentKeystore,
    isLoginKeystore,
    readKeystoreBundle,
    readRootKeystoreFile,
    readSessionKeystoreFile,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
} from '../src/lib/keystore'

test('writes split root/session keystores and decrypts both', async () => {
    const rootPrivateKey = generatePrivateKey()
    const sessionPrivateKey = generatePrivateKey()
    const password = 'split-password'
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-keystore-split-'))
    const rootPath = join(dir, 'default.keystore.json')
    const sessionPath = join(dir, 'sessions', 'default.json')

    try {
        const root = await createRootKeystore({
            password,
            rootPrivateKey,
            env: 'dev',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'http://127.0.0.1:8545',
            chainId: 31337,
        })

        const session = await createSessionKeystore({
            password,
            sessionPrivateKey,
            network: root.network,
            delegated: root.addresses.root,
            name: 'default',
        })

        await writeRootKeystoreFile(rootPath, root)
        await writeSessionKeystoreFile(sessionPath, session)

        const loadedRoot = await readRootKeystoreFile(rootPath)
        const loadedSession = await readSessionKeystoreFile(sessionPath)
        const decryptedRoot = await decryptRootKeystore(loadedRoot, password)
        const decryptedSession = await decryptSessionKeystore(loadedSession, password)

        expect(decryptedRoot.rootPrivateKey).toBe(rootPrivateKey)
        expect(decryptedSession.sessionPrivateKey).toBe(sessionPrivateKey)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('encryptBufferSecret round-trips binary device payloads', async () => {
    const password = 'buffer-secret-password'
    const sessionPrivateKey = generatePrivateKey()

    const session = await createSessionKeystore({
        password,
        sessionPrivateKey,
        network: {
            env: 'prod',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'https://mainnet.base.org',
            chainId: 8453,
        },
        delegated: '0x1111111111111111111111111111111111111111',
        name: 'agent-alice',
    })

    const key = await deriveKeystoreKey(password, session.kdf.params)

    const payload = toBinary(
        ExportedDeviceSchema,
        create(ExportedDeviceSchema, {
            pickleKey: 'pickle',
            pickledAccount: 'pickled-account',
            hybridGroupSessions: [],
        }),
    )

    try {
        const encrypted = encryptBufferSecret(payload, key)
        const decrypted = decryptBufferSecret(encrypted, key)
        expect(Buffer.from(decrypted)).toEqual(Buffer.from(payload))
    } finally {
        key.fill(0)
    }
})

test('readSessionKeystoreFile accepts agent keystores with named channel maps', async () => {
    const password = 'agent-keystore-password'
    const sessionPrivateKey = generatePrivateKey()
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-agent-keystore-'))
    const sessionPath = join(dir, 'sessions', 'agent-alice.json')

    try {
        const session = await createSessionKeystore({
            password,
            sessionPrivateKey,
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
            delegated: '0x1111111111111111111111111111111111111111',
            name: 'agent-alice',
        })

        const key = await deriveKeystoreKey(password, session.kdf.params)

        const encryptionDevice = encryptBufferSecret(
            toBinary(
                ExportedDeviceSchema,
                create(ExportedDeviceSchema, {
                    pickleKey: 'pickle',
                    pickledAccount: 'pickled-account',
                    hybridGroupSessions: [],
                }),
            ),
            key,
        )

        key.fill(0)

        await writeSessionKeystoreFile(sessionPath, {
            ...session,
            kind: 'agent',
            checkpoint: 'complete',
            secrets: {
                ...session.secrets,
                encryptionDevice,
            },
            namedChannels: {
                art: {
                    streamId: '0xstream',
                    secretHash: 'secret-hash',
                },
            },
        })

        const loaded = await readSessionKeystoreFile(sessionPath)
        expect(isAgentKeystore(loaded)).toBe(true)

        if (!isAgentKeystore(loaded)) {
            throw new Error('Expected agent keystore')
        }

        expect(loaded.namedChannels).toEqual({
            art: {
                streamId: '0xstream',
                secretHash: 'secret-hash',
            },
        })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('readSessionKeystoreFile rejects corrupt agent keystores', async () => {
    const password = 'agent-keystore-password'
    const sessionPrivateKey = generatePrivateKey()
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-agent-keystore-corrupt-'))
    const sessionPath = join(dir, 'sessions', 'alice.json')

    try {
        const session = await createSessionKeystore({
            password,
            sessionPrivateKey,
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
            delegated: '0x1111111111111111111111111111111111111111',
            name: 'alice',
        })

        await mkdir(join(dir, 'sessions'), { recursive: true })
        await writeFile(
            sessionPath,
            `${JSON.stringify({
                ...session,
                kind: 'agent',
                secrets: {
                    ...session.secrets,
                    encryptionDevice: {
                        nonce: 'nonce',
                        ciphertext: 'ciphertext',
                        tag: 123,
                    },
                },
            })}\n`,
            'utf8',
        )

        await expect(readSessionKeystoreFile(sessionPath)).rejects.toThrow(
            `Unsupported session keystore format at ${sessionPath}`,
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('readSessionKeystoreFile rejects session keystores missing session address', async () => {
    const password = 'missing-session-address-password'
    const sessionPrivateKey = generatePrivateKey()
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-session-missing-address-'))
    const sessionPath = join(dir, 'sessions', 'worker.json')

    try {
        const session = await createSessionKeystore({
            password,
            sessionPrivateKey,
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
            delegated: '0x1111111111111111111111111111111111111111',
            name: 'worker',
        })

        await mkdir(join(dir, 'sessions'), { recursive: true })
        await writeFile(
            sessionPath,
            `${JSON.stringify({
                ...session,
                addresses: {
                    delegated: session.addresses.delegated,
                },
            })}\n`,
            'utf8',
        )

        await expect(readSessionKeystoreFile(sessionPath)).rejects.toThrow(
            `Unsupported session keystore format at ${sessionPath}`,
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('readSessionKeystoreFile accepts login keystores with encrypted bearer token', async () => {
    const password = 'login-keystore-password'
    const sessionPrivateKey = generatePrivateKey()
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-login-keystore-'))
    const sessionPath = join(dir, 'session.json')

    try {
        const session = await createSessionKeystore({
            password,
            sessionPrivateKey,
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
            delegated: '0x1111111111111111111111111111111111111111',
            name: 'default',
            checkpoint: 'authorized',
            kind: 'login',
            delegateAuth: {
                sig: '0x1234',
                expiryEpochMs: Date.now() + 60_000,
            },
            bearerToken: '0x010203',
        })

        await writeSessionKeystoreFile(sessionPath, session)

        const loaded = await readSessionKeystoreFile(sessionPath)
        expect(isLoginKeystore(loaded)).toBe(true)

        if (!isLoginKeystore(loaded)) {
            throw new Error('Expected login keystore')
        }

        expect(loaded.secrets.bearerToken).toBeDefined()
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('readKeystoreBundle loads split keystore and active session file', async () => {
    const rootPrivateKey = generatePrivateKey()
    const sessionPrivateKey = generatePrivateKey()
    const password = 'bundle-split-password'
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-keystore-bundle-split-'))
    const rootPath = join(dir, 'default.keystore.json')
    const sessionPath = join(dir, 'sessions', 'default.json')

    try {
        const root = await createRootKeystore({
            password,
            rootPrivateKey,
            env: 'stage',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'https://mainnet.base.org',
            chainId: 8453,
        })

        const session = await createSessionKeystore({
            password,
            sessionPrivateKey,
            network: root.network,
            delegated: root.addresses.root,
            name: 'default',
        })

        await writeRootKeystoreFile(rootPath, root)
        await writeSessionKeystoreFile(sessionPath, session)

        const bundle = await readKeystoreBundle(rootPath)
        expect(bundle.sessionPath).toBe(sessionPath)
        expect(bundle.root.addresses.root).toBe(root.addresses.root)
        expect(bundle.session.addresses.session).toBe(session.addresses.session)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('readKeystoreBundle rejects unsupported root formats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-keystore-invalid-'))
    const rootPath = join(dir, 'default.keystore.json')

    try {
        await writeFile(rootPath, JSON.stringify({ version: 1, foo: 'bar' }), 'utf8')
        await expect(readKeystoreBundle(rootPath)).rejects.toThrow(
            'expected version 2 split keystore',
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('readKeystoreBundle rejects malformed v2 root payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-keystore-invalid-v2-'))
    const rootPath = join(dir, 'default.keystore.json')

    try {
        await writeFile(
            rootPath,
            JSON.stringify({ version: 2, sessionRef: { active: 'default' } }),
            'utf8',
        )
        await expect(readKeystoreBundle(rootPath)).rejects.toThrow(
            'expected version 2 split keystore',
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('readKeystoreBundle includes the file path when root JSON is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-keystore-malformed-'))
    const rootPath = join(dir, 'default.keystore.json')

    try {
        await writeFile(rootPath, '{"version":2,', 'utf8')
        await expect(readKeystoreBundle(rootPath)).rejects.toThrow(
            `Failed to parse keystore JSON at ${rootPath}`,
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('readKeystoreBundle reports session-only profiles with clear manager-required error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-keystore-session-only-'))
    const rootPath = join(dir, 'default.keystore.json')
    const sessionPath = join(dir, 'session.json')

    try {
        const sessionPrivateKey = generatePrivateKey()

        const session = await createSessionKeystore({
            password: 'pw',
            sessionPrivateKey,
            network: {
                env: 'prod',
                relayerUrl: 'https://relayer.example',
                rpcUrl: 'https://rpc.example',
                chainId: 8453,
            },
            delegated: '0x1111111111111111111111111111111111111111',
            name: 'worker-1',
            checkpoint: 'authorized',
        })

        await writeSessionKeystoreFile(sessionPath, session)
        await expect(readKeystoreBundle(rootPath)).rejects.toThrow(
            'This is a session-only profile.',
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('readKeystoreBundle reports login profiles with clear root-key guidance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-keystore-login-only-'))
    const rootPath = join(dir, 'default.keystore.json')
    const sessionPath = join(dir, 'session.json')

    try {
        const session = await createSessionKeystore({
            password: 'pw',
            sessionPrivateKey: generatePrivateKey(),
            network: {
                env: 'prod',
                relayerUrl: 'https://relayer.example',
                rpcUrl: 'https://rpc.example',
                chainId: 8453,
            },
            delegated: '0x1111111111111111111111111111111111111111',
            name: 'default',
            checkpoint: 'authorized',
            kind: 'login',
            delegateAuth: {
                sig: '0x1234',
                expiryEpochMs: Date.now() + 60_000,
            },
        })

        await writeSessionKeystoreFile(sessionPath, session)

        await expect(readKeystoreBundle(rootPath)).rejects.toBeInstanceOf(LoginProfileError)
        await expect(readKeystoreBundle(rootPath)).rejects.toThrow('This is a login profile.')
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('writes split root and session files with 0600 permissions on posix', async () => {
    if (process.platform === 'win32') {
        return
    }

    const rootPrivateKey = generatePrivateKey()
    const sessionPrivateKey = generatePrivateKey()
    const password = 'split-mode-password'
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-keystore-split-mode-'))
    const rootPath = join(dir, 'default.keystore.json')
    const sessionPath = join(dir, 'sessions', 'default.json')

    try {
        const root = await createRootKeystore({
            password,
            rootPrivateKey,
            env: 'prod',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'https://mainnet.base.org',
            chainId: 8453,
        })

        const session = await createSessionKeystore({
            password,
            sessionPrivateKey,
            network: root.network,
            delegated: root.addresses.root,
        })

        await writeRootKeystoreFile(rootPath, root)
        await writeSessionKeystoreFile(sessionPath, session)

        const rootStat = await stat(rootPath)
        const sessionStat = await stat(sessionPath)
        expect(rootStat.mode & 0o777).toBe(0o600)
        expect(sessionStat.mode & 0o777).toBe(0o600)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
