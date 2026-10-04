import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create } from '@bufbuild/protobuf'
import { ExportedDeviceSchema } from '@nubl/proto'
import { generatePrivateKey } from 'viem/accounts'
import {
    executeAccountUpdatePassword,
    resolveAccountUpdatePasswords,
} from '../src/lib/account-update-password'
import type { Hex } from 'viem'
import {
    createRootKeystore,
    createSessionKeystore,
    decryptHexSecret,
    decryptRootKeystore,
    decryptSessionKeystore,
    deriveKeystoreKey,
    isAgentKeystore,
    isLoginKeystore,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
    type LoginSessionKeystoreV2,
    type AgentSessionKeystoreV2,
} from '../src/lib/keystore'
import { decryptAgentDevice, finalizeAgentSessionKeystore } from '../src/lib/agent-sessions'

test('resolveAccountUpdatePasswords parses stdin pair line-by-line', async () => {
    const resolved = await resolveAccountUpdatePasswords(
        {
            env: 'prod',
            currentPasswordStdin: true,
            newPasswordStdin: true,
            json: false,
            help: false,
        },
        {
            readPasswordLinesFromStdin: () => [' oldpw ', ' newpw '],
            promptForExistingPassword: async () => {
                throw new Error('should not prompt current password')
            },
            promptForPassword: async () => {
                throw new Error('should not prompt new password')
            },
            isInteractive: false,
        },
    )

    expect(resolved.currentPassword).toBe('oldpw')
    expect(resolved.newPassword).toBe('newpw')
})

test('resolveAccountUpdatePasswords rejects missing second stdin line', async () => {
    await expect(
        resolveAccountUpdatePasswords(
            {
                env: 'prod',
                currentPasswordStdin: true,
                newPasswordStdin: true,
                json: false,
                help: false,
            },
            {
                readPasswordLinesFromStdin: () => ['old-only'],
                promptForExistingPassword: async () => 'unused',
                promptForPassword: async () => 'unused',
                isInteractive: false,
            },
        ),
    ).rejects.toMatchObject({
        code: 'PASSWORD_REQUIRED',
    })
})

test('resolveAccountUpdatePasswords validates current password before prompting for new password', async () => {
    const promptForPassword = mock(async () => 'new-password')

    await expect(
        resolveAccountUpdatePasswords(
            {
                env: 'prod',
                currentPasswordStdin: false,
                newPasswordStdin: false,
                json: false,
                help: false,
            },
            {
                readPasswordLinesFromStdin: () => [],
                promptForExistingPassword: async () => 'wrong-current',
                promptForPassword,
                isInteractive: true,
                validateCurrentPassword: async () => {
                    throw new Error('bad decrypt')
                },
            },
        ),
    ).rejects.toMatchObject({
        code: 'PASSWORD_INCORRECT',
    })
    expect(promptForPassword).toHaveBeenCalledTimes(0)
})

test('executeAccountUpdatePassword re-encrypts root and all sessions; old password no longer works', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-account-update-password-'))
    const rootPath = join(dir, 'default.keystore.json')

    const oldPassword = 'old-password'
    const newPassword = 'new-password'

    try {
        const rootPrivateKey = generatePrivateKey()
        const defaultSessionPrivateKey = generatePrivateKey()
        const workerSessionPrivateKey = generatePrivateKey()

        const root = await createRootKeystore({
            password: oldPassword,
            rootPrivateKey,
            env: 'dev',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'http://127.0.0.1:8545',
            chainId: 31337,
            activeSession: 'default',
            sessionsDir: 'sessions',
        })
        root.checkpoint = 'complete'
        root.addresses.delegated = root.addresses.root

        const defaultSession = await createSessionKeystore({
            password: oldPassword,
            sessionPrivateKey: defaultSessionPrivateKey,
            network: root.network,
            delegated: root.addresses.root,
            name: 'default',
            checkpoint: 'authorized',
        })
        const workerSession = await createSessionKeystore({
            password: oldPassword,
            sessionPrivateKey: workerSessionPrivateKey,
            network: root.network,
            delegated: root.addresses.root,
            name: 'worker-1',
            checkpoint: 'authorized',
        })

        await writeRootKeystoreFile(rootPath, root)
        await writeSessionKeystoreFile(
            resolveSessionKeystorePath(rootPath, 'default', 'sessions'),
            defaultSession,
        )
        await writeSessionKeystoreFile(
            resolveSessionKeystorePath(rootPath, 'worker-1', 'sessions'),
            workerSession,
        )

        const result = await executeAccountUpdatePassword({
            env: 'dev',
            keystorePath: rootPath,
            currentPassword: oldPassword,
            newPassword,
        })

        expect(result.type).toBe('account_update_password')
        expect(result.status).toBe('complete')
        expect(result.activeSession).toBe('default')
        expect(result.updatedSessions).toEqual(['default', 'worker-1'])

        const updatedBundle = await readKeystoreBundle(rootPath)
        const updatedWorker = await readSessionKeystoreFile(
            resolveSessionKeystorePath(rootPath, 'worker-1', 'sessions'),
        )

        await expect(decryptRootKeystore(updatedBundle.root, newPassword)).resolves.toBeTruthy()
        await expect(
            decryptSessionKeystore(updatedBundle.session, newPassword),
        ).resolves.toBeTruthy()
        await expect(decryptSessionKeystore(updatedWorker, newPassword)).resolves.toBeTruthy()

        await expect(decryptRootKeystore(updatedBundle.root, oldPassword)).rejects.toBeTruthy()
        await expect(
            decryptSessionKeystore(updatedBundle.session, oldPassword),
        ).rejects.toBeTruthy()
        await expect(decryptSessionKeystore(updatedWorker, oldPassword)).rejects.toBeTruthy()
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('executeAccountUpdatePassword maps incorrect password', async () => {
    await expect(
        executeAccountUpdatePassword(
            {
                env: 'prod',
                keystorePath: '/tmp/missing.json',
                currentPassword: 'wrong',
                newPassword: 'new',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(async () => {
                    throw new Error('bad decrypt')
                }),
            },
        ),
    ).rejects.toMatchObject({
        code: 'PASSWORD_INCORRECT',
    })
})

test('executeAccountUpdatePassword preserves login keystore fields (kind, delegateAuth, bearerToken)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-account-update-password-login-'))
    const rootPath = join(dir, 'default.keystore.json')

    const oldPassword = 'old-password'
    const newPassword = 'new-password'
    const bearerTokenHex = '0xdeadbeefcafebabe1234567890abcdef' as Hex

    try {
        const rootPrivateKey = generatePrivateKey()
        const loginSessionPrivateKey = generatePrivateKey()

        const root = await createRootKeystore({
            password: oldPassword,
            rootPrivateKey,
            env: 'dev',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'http://127.0.0.1:8545',
            chainId: 31337,
            activeSession: 'default',
            sessionsDir: 'sessions',
        })
        root.checkpoint = 'complete'
        root.addresses.delegated = root.addresses.root

        const delegateAuth = { sig: '0xaabbccdd', expiryEpochMs: Date.now() + 86_400_000 }
        const loginSession = await createSessionKeystore({
            password: oldPassword,
            sessionPrivateKey: loginSessionPrivateKey,
            network: root.network,
            delegated: root.addresses.root,
            name: 'default',
            checkpoint: 'authorized',
            kind: 'login',
            delegateAuth,
            bearerToken: bearerTokenHex,
        })

        await writeRootKeystoreFile(rootPath, root)
        await writeSessionKeystoreFile(
            resolveSessionKeystorePath(rootPath, 'default', 'sessions'),
            loginSession,
        )

        const result = await executeAccountUpdatePassword({
            env: 'dev',
            keystorePath: rootPath,
            currentPassword: oldPassword,
            newPassword,
        })

        expect(result.status).toBe('complete')
        expect(result.updatedSessions).toEqual(['default'])

        const updatedSession = await readSessionKeystoreFile(
            resolveSessionKeystorePath(rootPath, 'default', 'sessions'),
        )

        expect(isLoginKeystore(updatedSession)).toBe(true)
        const loginKeystore = updatedSession as LoginSessionKeystoreV2
        expect(loginKeystore.kind).toBe('login')
        expect(loginKeystore.delegateAuth).toEqual(delegateAuth)
        expect(loginKeystore.secrets.bearerToken).toBeDefined()

        const newKey = await deriveKeystoreKey(newPassword, loginKeystore.kdf.params)
        try {
            const decryptedBearer = decryptHexSecret(loginKeystore.secrets.bearerToken!, newKey)
            expect(decryptedBearer).toBe(bearerTokenHex)
        } finally {
            newKey.fill(0)
        }

        await expect(decryptSessionKeystore(updatedSession, newPassword)).resolves.toBeTruthy()
        await expect(decryptSessionKeystore(updatedSession, oldPassword)).rejects.toBeTruthy()
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('executeAccountUpdatePassword preserves agent keystore fields (encryptionDevice, namedChannels)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-account-update-password-agent-'))
    const rootPath = join(dir, 'default.keystore.json')

    const oldPassword = 'old-password'
    const newPassword = 'new-password'

    try {
        const rootPrivateKey = generatePrivateKey()
        const agentSessionPrivateKey = generatePrivateKey()

        const root = await createRootKeystore({
            password: oldPassword,
            rootPrivateKey,
            env: 'dev',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'http://127.0.0.1:8545',
            chainId: 31337,
            activeSession: 'agent-bot',
            sessionsDir: 'sessions',
        })
        root.checkpoint = 'complete'
        root.addresses.delegated = root.addresses.root

        const baseSession = await createSessionKeystore({
            password: oldPassword,
            sessionPrivateKey: agentSessionPrivateKey,
            network: root.network,
            delegated: root.addresses.root,
            name: 'agent-bot',
            checkpoint: 'authorized',
        })

        const exportedDevice = create(ExportedDeviceSchema, {
            pickleKey: 'device-key-test',
            pickledAccount: 'test-account-data',
            hybridGroupSessions: [],
        })
        const namedChannels = {
            art: { streamId: '77aabb', secretHash: 'hash-1' },
        }
        const agentSession = await finalizeAgentSessionKeystore({
            baseKeystore: baseSession,
            password: oldPassword,
            exportedDevice,
            namedChannels,
        })

        await writeRootKeystoreFile(rootPath, root)
        await writeSessionKeystoreFile(
            resolveSessionKeystorePath(rootPath, 'agent-bot', 'sessions'),
            agentSession,
        )

        const result = await executeAccountUpdatePassword({
            env: 'dev',
            keystorePath: rootPath,
            currentPassword: oldPassword,
            newPassword,
        })

        expect(result.status).toBe('complete')
        expect(result.updatedSessions).toEqual(['agent-bot'])

        const updatedSession = await readSessionKeystoreFile(
            resolveSessionKeystorePath(rootPath, 'agent-bot', 'sessions'),
        )

        expect(isAgentKeystore(updatedSession)).toBe(true)
        const agentKeystore = updatedSession as AgentSessionKeystoreV2
        expect(agentKeystore.kind).toBe('agent')
        expect(agentKeystore.namedChannels).toEqual(namedChannels)
        expect(agentKeystore.secrets.encryptionDevice).toBeDefined()

        const decryptedDevice = await decryptAgentDevice(agentKeystore, newPassword)
        expect(decryptedDevice.pickleKey).toBe('device-key-test')
        expect(decryptedDevice.pickledAccount).toBe('test-account-data')

        await expect(decryptSessionKeystore(updatedSession, newPassword)).resolves.toBeTruthy()
        await expect(decryptSessionKeystore(updatedSession, oldPassword)).rejects.toBeTruthy()
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('executeAccountUpdatePassword attempts rollback on write failure', async () => {
    const writeRoot = mock(async () => {})
    const writeSession = mock(async (_path: string) => {
        throw new Error('disk full')
    })

    await expect(
        executeAccountUpdatePassword(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                currentPassword: 'old',
                newPassword: 'new',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(async () => {
                    const root = await createRootKeystore({
                        password: 'old',
                        rootPrivateKey: generatePrivateKey(),
                        env: 'prod',
                        relayerUrl: 'http://127.0.0.1:8787',
                        rpcUrl: 'https://mainnet.base.org',
                        chainId: 8453,
                    })
                    const session = await createSessionKeystore({
                        password: 'old',
                        sessionPrivateKey: generatePrivateKey(),
                        network: root.network,
                        delegated: root.addresses.root,
                        name: 'default',
                    })
                    return {
                        rootPath: '/tmp/default.keystore.json',
                        sessionPath: '/tmp/sessions/default.json',
                        root,
                        session,
                    }
                }),
                listSessionNames: mock(async () => ['default']),
                readSessionKeystoreFile: mock(async () =>
                    createSessionKeystore({
                        password: 'old',
                        sessionPrivateKey: generatePrivateKey(),
                        network: {
                            env: 'prod',
                            relayerUrl: 'http://127.0.0.1:8787',
                            rpcUrl: 'https://mainnet.base.org',
                            chainId: 8453,
                        },
                        delegated: '0x1111111111111111111111111111111111111111',
                        name: 'default',
                    }),
                ),
                writeRootKeystoreFile: writeRoot,
                writeSessionKeystoreFile: writeSession,
            },
        ),
    ).rejects.toMatchObject({
        code: 'UPDATE_FAILED',
    })
})
