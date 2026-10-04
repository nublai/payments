import { test, expect, mock } from 'bun:test'
import type { Hex } from 'viem'
import {
    AccountCreateError,
    assertAccountCreateCanInitialize,
    executeAccountCreate,
    getDefaultSessionPermissions,
    getDefaultKeystorePath,
    resolveKeystorePath,
    resolveAccountCreatePassword,
    type AccountCreateOptions,
} from '../src/lib/account-create'
import type { RelayerRootKeystoreV2, RelayerSessionKeystoreV2 } from '../src/lib/keystore'

function makeRootKeystore(overrides?: Partial<RelayerRootKeystoreV2>): RelayerRootKeystoreV2 {
    return {
        version: 2,
        createdAt: '2026-02-19T00:00:00.000Z',
        checkpoint: 'initialized',
        network: {
            env: 'prod',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'https://mainnet.base.org',
            chainId: 8453,
        },
        addresses: {
            root: '0x1111111111111111111111111111111111111111',
        },
        sessionRef: {
            active: 'default',
            dir: 'sessions',
        },
        kdf: {
            name: 'argon2id',
            params: {
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1,
                hashLength: 32,
                salt: 'dGVzdA==',
            },
        },
        crypto: { algorithm: 'aes-256-gcm' },
        secrets: {
            rootPrivateKey: { nonce: 'a', ciphertext: 'b', tag: 'c' },
        },
        ...overrides,
    }
}

function makeSessionKeystore(
    overrides?: Partial<RelayerSessionKeystoreV2>,
): RelayerSessionKeystoreV2 {
    return {
        version: 2,
        createdAt: '2026-02-19T00:00:00.000Z',
        name: 'default',
        checkpoint: 'initialized',
        network: {
            env: 'prod',
            relayerUrl: 'https://relayer.example',
            rpcUrl: 'https://rpc.example',
            chainId: 8453,
        },
        kdf: {
            name: 'argon2id',
            params: {
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1,
                hashLength: 32,
                salt: 'dGVzdA==',
            },
        },
        crypto: { algorithm: 'aes-256-gcm' },
        addresses: {
            session: '0x2222222222222222222222222222222222222222',
            delegated: '0x1111111111111111111111111111111111111111',
        },
        secrets: {
            sessionPrivateKey: { nonce: 'd', ciphertext: 'e', tag: 'f' },
        },
        ...overrides,
    }
}

test('getDefaultKeystorePath keeps prod path stable', () => {
    const path = getDefaultKeystorePath('prod')
    expect(path).toContain('/.config/agentic-payments/tw/profiles/default/default.keystore.json')
    expect(path).not.toContain('/profiles/prod/')
})

test('getDefaultKeystorePath namespaces non-prod envs', () => {
    expect(getDefaultKeystorePath('stage')).toContain(
        '/.config/agentic-payments/tw/profiles/stage/default/default.keystore.json',
    )
    expect(getDefaultKeystorePath('dev')).toContain(
        '/.config/agentic-payments/tw/profiles/dev/default/default.keystore.json',
    )
})

test('getDefaultKeystorePath uses --profile for prod and non-prod', () => {
    expect(getDefaultKeystorePath('prod', 'alice')).toContain(
        '/.config/agentic-payments/tw/profiles/alice/default.keystore.json',
    )
    expect(getDefaultKeystorePath('stage', 'alice')).toContain(
        '/.config/agentic-payments/tw/profiles/stage/alice/default.keystore.json',
    )
})

test('resolveKeystorePath prefers explicit --keystore-path over --profile', () => {
    const path = resolveKeystorePath({
        env: 'dev',
        keystorePath: '/tmp/explicit.json',
        name: 'alice',
    })
    expect(path).toBe('/tmp/explicit.json')
})

test('resolveKeystorePath rejects invalid --profile', () => {
    expect(() =>
        resolveKeystorePath({
            env: 'prod',
            name: 'alice.dev',
        }),
    ).toThrowError(AccountCreateError)
})

test('getDefaultSessionPermissions allows all function selectors and default spend permission', () => {
    const permissions = getDefaultSessionPermissions(31337)
    expect(permissions[0]).toEqual({
        type: 'call',
        to: '0x3232323232323232323232323232323232323232',
        selector: '0x32323232',
    })
    expect(permissions[1]).toMatchObject({
        type: 'spend',
        token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        period: 'forever',
    })
})

test('assertAccountCreateCanInitialize fails early when keystore exists', async () => {
    await expect(
        assertAccountCreateCanInitialize(
            {
                keystorePath: '/tmp/already-there.json',
                resume: false,
            },
            {
                pathExists: async () => true,
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountCreateError',
        code: 'KEYSTORE_EXISTS',
        recoveryCommand: 'tw account create --resume --keystore-path "/tmp/already-there.json"',
    })
})

test('assertAccountCreateCanInitialize allows existing keystore with --resume', async () => {
    await expect(
        assertAccountCreateCanInitialize(
            {
                keystorePath: '/tmp/already-there.json',
                resume: true,
            },
            {
                pathExists: async () => true,
            },
        ),
    ).resolves.toBeUndefined()
})

test('executeAccountCreate creates keystore and delegates', async () => {
    const rootPrivateKey =
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
    const sessionPrivateKey =
        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as Hex
    const rootAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    const sessionAddress = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
    const rootKeystore = makeRootKeystore({
        addresses: { root: rootAddress },
    })
    const sessionKeystore = makeSessionKeystore({
        addresses: {
            session: sessionAddress,
            delegated: rootAddress,
        },
    })

    const writeRootKeystoreFile = mock(async () => {})
    const writeSessionKeystoreFile = mock(async () => {})
    const delegateAccount = mock(async () => ({
        accountAddress: rootAddress,
        txHash: '0xabc',
    }))

    const options: AccountCreateOptions = {
        env: 'prod',
        password: 'password',
        keystorePath: '/tmp/test-keystore.json',
    }

    let generateCalls = 0

    const result = await executeAccountCreate(options, {
        generatePrivateKey: mock(() => {
            generateCalls += 1
            return generateCalls === 1 ? rootPrivateKey : sessionPrivateKey
        }),
        createRootKeystore: mock(async () => rootKeystore),
        createSessionKeystore: mock(async () => sessionKeystore),
        writeRootKeystoreFile,
        writeSessionKeystoreFile,
        delegateAccount,
    })

    expect(result.type).toBe('account_create')
    expect(result.status).toBe('complete')
    expect(result.network.env).toBe('prod')
    expect(result.addresses.delegated).toBe(rootAddress)
    expect(delegateAccount).toHaveBeenCalledTimes(1)
    expect(writeRootKeystoreFile).toHaveBeenCalledTimes(2)
    expect(writeSessionKeystoreFile).toHaveBeenCalledTimes(2)
})

test('resolveAccountCreatePassword prefers RELAYER_CLI_PASSWORD env', async () => {
    const password = await resolveAccountCreatePassword(
        {
            env: 'prod',
            json: false,
            passwordStdin: false,
            resume: false,
            help: false,
        },
        {
            envPassword: 'secret-from-env',
            readPasswordFromStdin: () => 'ignored',
            promptForPassword: async () => 'ignored',
            isInteractive: false,
        },
    )

    expect(password).toBe('secret-from-env')
})

test('resolveAccountCreatePassword reads stdin when --password-stdin is used', async () => {
    const password = await resolveAccountCreatePassword(
        {
            env: 'prod',
            json: false,
            passwordStdin: true,
            resume: false,
            help: false,
        },
        {
            readPasswordFromStdin: () => 'secret-stdin',
            promptForPassword: async () => 'ignored',
            isInteractive: false,
        },
    )

    expect(password).toBe('secret-stdin')
})

test('resolveAccountCreatePassword uses interactive prompt when tty is available', async () => {
    const password = await resolveAccountCreatePassword(
        {
            env: 'prod',
            json: false,
            passwordStdin: false,
            resume: false,
            help: false,
        },
        {
            readPasswordFromStdin: () => 'ignored',
            promptForPassword: async () => 'secret-interactive',
            isInteractive: true,
        },
    )

    expect(password).toBe('secret-interactive')
})

test('resolveAccountCreatePassword throws typed error when no input source is available', async () => {
    await expect(
        resolveAccountCreatePassword(
            {
                env: 'prod',
                json: false,
                passwordStdin: false,
                resume: false,
                help: false,
            },
            {
                readPasswordFromStdin: () => 'ignored',
                promptForPassword: async () => 'ignored',
                isInteractive: false,
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountCreateError',
        code: 'PASSWORD_REQUIRED',
    })
})

test('executeAccountCreate maps delegation failure to typed error', async () => {
    const rootPrivateKey =
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
    const rootKeystore = makeRootKeystore()
    const sessionKeystore = makeSessionKeystore()

    await expect(
        executeAccountCreate(
            {
                env: 'prod',
                password: 'password',
                keystorePath: '/tmp/test-keystore.json',
            },
            {
                generatePrivateKey: mock(() => rootPrivateKey),
                createRootKeystore: mock(async () => rootKeystore),
                createSessionKeystore: mock(async () => sessionKeystore),
                writeRootKeystoreFile: mock(async () => {}),
                writeSessionKeystoreFile: mock(async () => {}),
                delegateAccount: mock(async () => {
                    throw new Error('Delegation failed: relayer rejected authorization')
                }),
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountCreateError',
        code: 'DELEGATION_FAILED',
    })
})

test('executeAccountCreate writes session keystore before delegation so resume remains possible', async () => {
    const rootPrivateKey =
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
    const rootKeystore = makeRootKeystore()
    const sessionKeystore = makeSessionKeystore()
    const writeSessionKeystoreFile = mock(async () => {})

    await expect(
        executeAccountCreate(
            {
                env: 'prod',
                password: 'password',
                keystorePath: '/tmp/test-keystore.json',
            },
            {
                generatePrivateKey: mock(() => rootPrivateKey),
                createRootKeystore: mock(async () => rootKeystore),
                createSessionKeystore: mock(async () => sessionKeystore),
                writeRootKeystoreFile: mock(async () => {}),
                writeSessionKeystoreFile,
                delegateAccount: mock(async () => {
                    throw new Error('Delegation failed: relayer rejected authorization')
                }),
            },
        ),
    ).rejects.toMatchObject({
        code: 'DELEGATION_FAILED',
    })

    expect(writeSessionKeystoreFile).toHaveBeenCalledTimes(1)
})

test('executeAccountCreate writes split root and session keystores', async () => {
    const rootPrivateKey =
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
    const rootKeystore = makeRootKeystore({
        addresses: {
            root: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        },
    })
    const sessionKeystore = makeSessionKeystore({
        addresses: {
            session: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
            delegated: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        },
    })

    const writeRootKeystoreFile = mock(async () => {})
    const writeSessionKeystoreFile = mock(async () => {})
    const delegateAccount = mock(async () => ({
        accountAddress: rootKeystore.addresses.root,
        txHash: '0xabc',
    }))

    const result = await executeAccountCreate(
        {
            env: 'prod',
            password: 'password',
            keystorePath: '/tmp/test-keystore.json',
        },
        {
            generatePrivateKey: mock(() => rootPrivateKey),
            createRootKeystore: mock(async () => rootKeystore),
            createSessionKeystore: mock(async () => sessionKeystore),
            writeRootKeystoreFile,
            writeSessionKeystoreFile,
            delegateAccount,
        },
    )

    expect(result.addresses.root).toBe(rootKeystore.addresses.root)
    expect(result.addresses.session).toBe(sessionKeystore.addresses.session)
    expect(result.addresses.delegated).toBe(rootKeystore.addresses.root)
    expect(writeRootKeystoreFile).toHaveBeenCalledTimes(2)
    expect(writeSessionKeystoreFile).toHaveBeenCalledTimes(2)
})

test('executeAccountCreate resume loads split bundle and avoids key generation', async () => {
    const rootPrivateKey =
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
    const sessionPrivateKey =
        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as Hex
    const rootKeystore = makeRootKeystore()
    const sessionKeystore = makeSessionKeystore()

    const generateKey = mock(() => rootPrivateKey)
    const result = await executeAccountCreate(
        {
            env: 'dev',
            password: 'password',
            keystorePath: '/tmp/test-keystore.json',
            resume: true,
        },
        {
            generatePrivateKey: generateKey,
            readKeystoreBundle: mock(async () => ({
                rootPath: '/tmp/test-keystore.json',
                sessionPath: '/tmp/sessions/default.json',
                root: rootKeystore,
                session: sessionKeystore,
            })),
            decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
            decryptSessionKeystore: mock(async () => ({ sessionPrivateKey })),
            writeRootKeystoreFile: mock(async () => {}),
            writeSessionKeystoreFile: mock(async () => {}),
            delegateAccount: mock(async () => ({
                accountAddress: rootKeystore.addresses.root,
            })),
        },
    )

    expect(result.type).toBe('account_create')
    expect(result.addresses.session).toBe(sessionKeystore.addresses.session)
    expect(generateKey).toHaveBeenCalledTimes(0)
})

test('executeAccountCreate surfaces session write errors before delegation', async () => {
    const rootPrivateKey =
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
    const rootKeystore = makeRootKeystore()
    const sessionKeystore = makeSessionKeystore()
    await expect(
        executeAccountCreate(
            {
                env: 'prod',
                password: 'password',
                keystorePath: '/tmp/test-keystore.json',
            },
            {
                generatePrivateKey: mock(() => rootPrivateKey),
                createRootKeystore: mock(async () => rootKeystore),
                createSessionKeystore: mock(async () => sessionKeystore),
                writeRootKeystoreFile: mock(async () => {}),
                writeSessionKeystoreFile: mock(async () => {
                    throw new Error('Session keystore already exists at /tmp/sessions/default.json')
                }),
                delegateAccount: mock(async () => ({
                    accountAddress: rootKeystore.addresses.root,
                    txHash: '0xabc',
                })),
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountCreateError',
        code: 'UNKNOWN',
    })
})
