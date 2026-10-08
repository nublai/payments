import { expect, mock, test } from 'bun:test'
import { getAddress, zeroAddress, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type {
    ExecuteSignedCallsDeps,
    ExecuteSignedCallsParams,
    ExecuteSignedCallsResult,
} from '../src/lib/execute-calls'
import type { FeeCapDisclosure } from '../src/lib/intent-payment'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { executeSessionCreate } from '../src/lib/session-create'
import type {
    AnySessionKeystore,
    createSessionKeystore,
    KeystoreBundle,
    LoginSessionKeystoreV2,
    RelayerSessionKeystoreV2,
} from '../src/lib/keystore'

type SessionKeystoreInputs = typeof createSessionKeystore extends {
    (input: infer RelayerInput): Promise<RelayerSessionKeystoreV2>
    (input: infer LoginInput): Promise<LoginSessionKeystoreV2>
}
    ? { relayer: RelayerInput; login: LoginInput }
    : never

const feeCap: FeeCapDisclosure = {
    token: zeroAddress,
    symbol: 'none',
    amountUsdc: '0',
    expiresIn: '1h',
}

function returnsRelayerSessionKeystore(
    keystore: RelayerSessionKeystoreV2,
): typeof createSessionKeystore {
    function create(input: SessionKeystoreInputs['relayer']): Promise<RelayerSessionKeystoreV2>
    function create(input: SessionKeystoreInputs['login']): Promise<LoginSessionKeystoreV2>
    async function create(
        input: SessionKeystoreInputs['relayer'] | SessionKeystoreInputs['login'],
    ): Promise<AnySessionKeystore> {
        if (input.kind === 'login') throw new Error('session create must not request a login session')

        return keystore
    }

    return create
}

function makeSessionKeystore(sessionPrivateKey: `0x${string}`): RelayerSessionKeystoreV2 {
    const sessionAddress = privateKeyToAccount(sessionPrivateKey).address

    return {
        version: 2,
        createdAt: new Date().toISOString(),
        name: 'agent-alice',
        checkpoint: 'initialized',
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
        crypto: {
            algorithm: 'aes-256-gcm',
        },
        addresses: {
            session: sessionAddress,
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

function makeBundle(): KeystoreBundle {
    const defaultSession = makeSessionKeystore(generatePrivateKey())

    return {
        rootPath: '/tmp/default.keystore.json',
        sessionPath: '/tmp/sessions/default.json',
        root: {
            version: 2,
            createdAt: new Date().toISOString(),
            checkpoint: 'complete',
            network: defaultSession.network,
            sessionRef: { active: 'default', dir: 'sessions' },
            addresses: {
                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
            kdf: defaultSession.kdf,
            crypto: { algorithm: 'aes-256-gcm' },
            secrets: {
                rootPrivateKey: { nonce: 'nonce', ciphertext: 'ciphertext', tag: 'tag' },
            },
        },
        session: { ...defaultSession, name: 'default' },
    }
}

function makeOnChainKey(hash: Hex) {
    return {
        hash,
        expiry: '0x0' as const,
        type: 'secp256k1' as const,
        role: 'normal' as const,
        publicKey: '0x' as const,
        permissions: [],
    }
}

test('executeSessionCreate with noPermissions sends only authorize and omits permissions result', async () => {
    const sessionPrivateKey = generatePrivateKey()
    const sessionKeystore = makeSessionKeystore(sessionPrivateKey)
    const sessionAddress = getAddress(sessionKeystore.addresses.session)
    const sessionKeyHash = computeSessionKeyHash(sessionAddress)

    const executeSignedCalls = mock(async (_deps: ExecuteSignedCallsDeps, params: ExecuteSignedCallsParams): Promise<ExecuteSignedCallsResult> => {
        expect(params.calls).toHaveLength(1)

        return {
            id: 'bundle-1',
            finalStatus: {
                success: true,
                status: 'confirmed',
                statusCode: 200,
                receipt: {
                    transactionHash:
                        '0x1111111111111111111111111111111111111111111111111111111111111111',
                    blockNumber: '0x1',
                    gasUsed: '0x0',
                    status: 'success',
                },
            },
            feeCap,
        }
    })

    const result = await executeSessionCreate(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            sessionName: 'agent-alice',
            noPermissions: true,
            password: 'pw',
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readKeystoreBundle: mock(async () => makeBundle()),
            fileExists: mock(async () => false),
            generatePrivateKey: mock(() => sessionPrivateKey),
            createSessionKeystore: returnsRelayerSessionKeystore(sessionKeystore),
            writeSessionKeystoreFile: mock(async () => {}),
            decryptRootKeystore: mock(
                async () =>
                    ({
                        rootPrivateKey:
                            '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                    }) as const,
            ),
            readNonce: mock(async () => 1n),
            executeSignedCalls,
            getKeys: mock(async () => ({
                '0x2105': [makeOnChainKey(sessionKeyHash)],
            })),
            sleep: mock(async () => {}),
        },
    )

    expect(result.permissions).toBeUndefined()
    expect(result.session.keyHash).toBe(sessionKeyHash)
    expect(result.session.expiry).toBe(0)
})

test('executeSessionCreate passes expiry to authorize call data', async () => {
    const sessionPrivateKey = generatePrivateKey()
    const sessionKeystore = makeSessionKeystore(sessionPrivateKey)
    const sessionAddress = getAddress(sessionKeystore.addresses.session)
    const sessionKeyHash = computeSessionKeyHash(sessionAddress)

    const executeSignedCalls = mock(async (_deps: ExecuteSignedCallsDeps, params: ExecuteSignedCallsParams): Promise<ExecuteSignedCallsResult> => {
        const authorizeCall = params.calls[0]

        if (!authorizeCall) throw new Error('expected an authorize call')

        expect(authorizeCall.data).toBeDefined()

        return {
            id: 'bundle-1',
            finalStatus: {
                success: true,
                status: 'confirmed',
                statusCode: 200,
                receipt: {
                    transactionHash:
                        '0x1111111111111111111111111111111111111111111111111111111111111111',
                    blockNumber: '0x1',
                    gasUsed: '0x0',
                    status: 'success',
                },
            },
            feeCap,
        }
    })

    const result = await executeSessionCreate(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            sessionName: 'agent-alice',
            noPermissions: true,
            expiry: '24h',
            password: 'pw',
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readKeystoreBundle: mock(async () => makeBundle()),
            fileExists: mock(async () => false),
            generatePrivateKey: mock(() => sessionPrivateKey),
            createSessionKeystore: returnsRelayerSessionKeystore(sessionKeystore),
            writeSessionKeystoreFile: mock(async () => {}),
            decryptRootKeystore: mock(
                async () =>
                    ({
                        rootPrivateKey:
                            '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                    }) as const,
            ),
            readNonce: mock(async () => 1n),
            executeSignedCalls,
            getKeys: mock(async () => ({
                '0x2105': [makeOnChainKey(sessionKeyHash)],
            })),
            sleep: mock(async () => {}),
        },
    )

    expect(result.session.expiry).toBeGreaterThan(0)
    expect(result.session.keyHash).toBe(sessionKeyHash)
})
