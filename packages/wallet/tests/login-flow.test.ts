import { create, toBinary } from '@bufbuild/protobuf'
import { BearerTokenSchema, WalletSessionTokenSchema } from '@nubl/proto'
import { expect, mock, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { getDefaultKeystorePath } from '../src/lib/account-create'
import type {
    AnySessionKeystore,
    createSessionKeystore,
    LoginSessionKeystoreV2,
    RelayerSessionKeystoreV2,
} from '../src/lib/keystore'
import { executeLogin, executeLogout, LoginError } from '../src/lib/login'

type SessionKeystoreInputs = typeof createSessionKeystore extends {
    (input: infer RelayerInput): Promise<RelayerSessionKeystoreV2>
    (input: infer LoginInput): Promise<LoginSessionKeystoreV2>
}
    ? { relayer: RelayerInput; login: LoginInput }
    : never

function createsLoginSessionKeystore(
    createLogin: (input: SessionKeystoreInputs['login']) => Promise<LoginSessionKeystoreV2>,
): typeof createSessionKeystore {
    function create(input: SessionKeystoreInputs['relayer']): Promise<RelayerSessionKeystoreV2>
    function create(input: SessionKeystoreInputs['login']): Promise<LoginSessionKeystoreV2>
    async function create(
        input: SessionKeystoreInputs['relayer'] | SessionKeystoreInputs['login'],
    ): Promise<AnySessionKeystore> {
        if (input.kind !== 'login') throw new Error('login must request a login session')

        return createLogin(input)
    }

    return create
}

const SESSION_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945388cf6f64f6b5f8a6d4f7e7a3fa8f8ff7f0' as const
const ACCOUNT_ADDRESS = '0x1111111111111111111111111111111111111111' as const

function hexToBytes(value: `0x${string}`): Uint8Array {
    const normalized = value.slice(2)
    return Uint8Array.from(Buffer.from(normalized, 'hex'))
}

function toHex(data: Uint8Array): `0x${string}` {
    return `0x${Buffer.from(data).toString('hex')}`
}

function makeTokenHex(options?: {
    expiryEpochMs?: bigint
    delegateExpiryEpochMs?: bigint
    chainId?: bigint
}): `0x${string}` {
    const now = BigInt(Date.now())
    const token = create(WalletSessionTokenSchema, {
        sessionPrivateKey: hexToBytes(SESSION_PRIVATE_KEY),
        accountAddress: hexToBytes(ACCOUNT_ADDRESS),
        chainId: options?.chainId ?? 8453n,
        expiryEpochMs: options?.expiryEpochMs ?? now + 60_000n,
        bearerToken: create(BearerTokenSchema, {
            delegatePrivateKey:
                '0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
            delegateSig: new Uint8Array([1, 2, 3]),
            expiryEpochMs: now + 60_000n,
        }),
        delegateSig: new Uint8Array([4, 5, 6]),
        delegateExpiryEpochMs: options?.delegateExpiryEpochMs ?? now + 120_000n,
    })
    return toHex(toBinary(WalletSessionTokenSchema, token))
}

function makeRelayerSessionKeystore(): RelayerSessionKeystoreV2 {
    return {
        version: 2,
        createdAt: new Date().toISOString(),
        name: 'default',
        checkpoint: 'authorized',
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
            session: privateKeyToAccount(SESSION_PRIVATE_KEY).address,
            delegated: ACCOUNT_ADDRESS,
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

function makeLoginSessionKeystore(): LoginSessionKeystoreV2 {
    const base = makeRelayerSessionKeystore()
    return {
        ...base,
        kind: 'login',
        delegateAuth: {
            sig: '0x040506',
            expiryEpochMs: Date.now() + 120_000,
        },
        secrets: {
            ...base.secrets,
            bearerToken: {
                nonce: 'nonce-bearer',
                ciphertext: 'ciphertext-bearer',
                tag: 'tag-bearer',
            },
        },
    }
}

test('executeLogin creates a login session keystore and writes session.json', async () => {
    const profile = 'login-test'
    const profileDir = dirname(getDefaultKeystorePath('prod', profile))
    const sessionPath = join(profileDir, 'session.json')

    const createSessionKeystore = mock(
        async (_input: SessionKeystoreInputs['login']) => makeLoginSessionKeystore(),
    )

    const writeSessionKeystoreFile = mock(async () => {})

    const result = await executeLogin(
        {
            tokenHex: makeTokenHex(),
            profile,
            env: 'prod',
            password: 'pw',
        },
        {
            mkdir: mock(async () => undefined),
            access: mock(async () => {
                throw new Error('ENOENT: no such file or directory')
            }),
            readSessionKeystoreFile: mock(async () => {
                throw new Error('ENOENT: no such file or directory')
            }),
            createSessionKeystore: createsLoginSessionKeystore(createSessionKeystore),
            writeSessionKeystoreFile,
        },
    )

    expect(result.status).toBe('complete')
    expect(result.profile).toBe(profile)
    expect(result.accountAddress).toBe(ACCOUNT_ADDRESS)
    expect(result.sessionAddress).toBe(privateKeyToAccount(SESSION_PRIVATE_KEY).address)
    expect(createSessionKeystore).toHaveBeenCalledWith(
        expect.objectContaining({
            kind: 'login',
            delegated: ACCOUNT_ADDRESS,
            name: 'default',
            checkpoint: 'authorized',
        }),
    )
    expect(writeSessionKeystoreFile).toHaveBeenCalledWith(sessionPath, expect.any(Object), {
        overwrite: false,
    })
})

test('executeLogin rejects profiles that already have a root keystore', async () => {
    await expect(
        executeLogin(
            {
                tokenHex: makeTokenHex(),
                profile: 'existing-root',
                env: 'prod',
                password: 'pw',
            },
            {
                mkdir: mock(async () => undefined),
                access: mock(async () => {}),
            },
        ),
    ).rejects.toMatchObject({
        code: 'PROFILE_CONFLICT',
        message: 'Profile has a root keystore. Use a different --profile name.',
    })
})

test('executeLogin rejects profiles with existing non-login session imports', async () => {
    await expect(
        executeLogin(
            {
                tokenHex: makeTokenHex(),
                profile: 'existing-session',
                env: 'prod',
                password: 'pw',
            },
            {
                mkdir: mock(async () => undefined),
                access: mock(async () => {
                    throw new Error('ENOENT: no such file or directory')
                }),
                readSessionKeystoreFile: mock(async () => makeRelayerSessionKeystore()),
            },
        ),
    ).rejects.toMatchObject({
        code: 'PROFILE_CONFLICT',
        message: 'Profile has an imported session. Use a different --profile name.',
    })
})

test('executeLogin allows re-login by overwriting existing login session', async () => {
    const profile = 'existing-login'
    const profileDir = dirname(getDefaultKeystorePath('prod', profile))
    const sessionPath = join(profileDir, 'session.json')
    const writeSessionKeystoreFile = mock(async () => {})

    await executeLogin(
        {
            tokenHex: makeTokenHex(),
            profile,
            env: 'prod',
            password: 'pw',
        },
        {
            mkdir: mock(async () => undefined),
            access: mock(async () => {
                throw new Error('ENOENT: no such file or directory')
            }),
            readSessionKeystoreFile: mock(async () => makeLoginSessionKeystore()),
            createSessionKeystore: createsLoginSessionKeystore(
                mock(async () => makeLoginSessionKeystore()),
            ),
            writeSessionKeystoreFile,
        },
    )

    expect(writeSessionKeystoreFile).toHaveBeenCalledWith(sessionPath, expect.any(Object), {
        overwrite: true,
    })
})

test('executeLogin rejects expired tokens', async () => {
    const now = BigInt(Date.now())
    await expect(
        executeLogin(
            {
                tokenHex: makeTokenHex({ expiryEpochMs: now - 1n }),
                profile: 'expired-token',
                env: 'prod',
                password: 'pw',
            },
            {
                mkdir: mock(async () => undefined),
            },
        ),
    ).rejects.toMatchObject({
        code: 'TOKEN_EXPIRED',
    })
})

test('executeLogin rejects tokens with expired delegate authorization', async () => {
    const now = BigInt(Date.now())
    await expect(
        executeLogin(
            {
                tokenHex: makeTokenHex({ delegateExpiryEpochMs: now - 1n }),
                profile: 'expired-delegate-token',
                env: 'prod',
                password: 'pw',
            },
            {
                mkdir: mock(async () => undefined),
            },
        ),
    ).rejects.toMatchObject({
        code: 'TOKEN_EXPIRED',
    })
})

test('executeLogout removes login session profile and returns warning', async () => {
    const profile = 'logout-login'
    const profileDir = dirname(getDefaultKeystorePath('prod', profile))
    const sessionPath = join(profileDir, 'session.json')
    const expiryEpochMs = Date.now() + 60_000
    const rm = mock(async () => {})

    const result = await executeLogout(
        { profile, env: 'prod' },
        {
            readSessionKeystoreFile: mock(async () => ({
                ...makeLoginSessionKeystore(),
                delegateAuth: {
                    sig: '0x1234',
                    expiryEpochMs,
                },
            })),
            rm,
            readdir: mock(async () => []),
        },
    )

    expect(result.status).toBe('complete')
    expect(result.profile).toBe(profile)
    expect(result.warning).toContain(new Date(expiryEpochMs).toISOString())
    expect(rm).toHaveBeenNthCalledWith(1, sessionPath)
    expect(rm).toHaveBeenNthCalledWith(2, profileDir)
})

test('executeLogout rejects non-login profiles', async () => {
    const error = await executeLogout(
        { profile: 'not-login', env: 'prod' },
        {
            readSessionKeystoreFile: mock(async () => makeRelayerSessionKeystore()),
        },
    ).catch((err) => err)

    expect(error).toBeInstanceOf(LoginError)
    expect(error).toMatchObject({
        code: 'NOT_LOGIN_PROFILE',
    })
})
