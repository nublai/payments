import { expect, mock, test } from 'bun:test'
import { getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { executeSessionCreate } from '../src/lib/session-create'
import type { RelayerSessionKeystoreV2 } from '../src/lib/keystore'

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

test('executeSessionCreate with noPermissions sends only authorize and omits permissions result', async () => {
    const sessionPrivateKey = generatePrivateKey()
    const sessionKeystore = makeSessionKeystore(sessionPrivateKey)
    const sessionAddress = getAddress(sessionKeystore.addresses.session)
    const sessionKeyHash = computeSessionKeyHash(sessionAddress)
    const executeSignedCalls = mock(async (_deps, params) => {
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
                },
            },
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
            readKeystoreBundle: mock(
                async () =>
                    ({
                        root: {
                            sessionRef: { active: 'default', dir: 'sessions' },
                            addresses: {
                                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                            },
                        },
                    }) as const,
            ),
            fileExists: mock(async () => false),
            generatePrivateKey: mock(() => sessionPrivateKey),
            createSessionKeystore: mock(async () => sessionKeystore),
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
            getKeys: mock(
                async () =>
                    ({
                        '0x2105': [{ hash: sessionKeyHash }],
                    }) as const,
            ),
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
    const executeSignedCalls = mock(async (_deps, params) => {
        const authorizeCall = params.calls[0]
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
                },
            },
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
            readKeystoreBundle: mock(
                async () =>
                    ({
                        root: {
                            sessionRef: { active: 'default', dir: 'sessions' },
                            addresses: {
                                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                            },
                        },
                    }) as const,
            ),
            fileExists: mock(async () => false),
            generatePrivateKey: mock(() => sessionPrivateKey),
            createSessionKeystore: mock(async () => sessionKeystore),
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
            getKeys: mock(
                async () =>
                    ({
                        '0x2105': [{ hash: sessionKeyHash }],
                    }) as const,
            ),
            sleep: mock(async () => {}),
        },
    )

    expect(result.session.expiry).toBeGreaterThan(0)
    expect(result.session.keyHash).toBe(sessionKeyHash)
})
