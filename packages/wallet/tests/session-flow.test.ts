import { expect, mock, test } from 'bun:test'
import { getAddress, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { executeSessionList } from '../src/lib/session-list'
import { executeSessionRevoke } from '../src/lib/session-revoke'
import type { AnySessionKeystore, KeystoreBundle, RelayerRootKeystoreV2 } from '../src/lib/keystore'
import type { ExecuteSignedCallsResult } from '../src/lib/execute-calls'
import type { FeeCapDisclosure } from '../src/lib/intent-payment'

const feeCap: FeeCapDisclosure = {
    token: zeroAddress,
    symbol: 'none',
    amountUsdc: '0',
    expiresIn: '1h',
}

function makeRoot(activeSession: string): RelayerRootKeystoreV2 {
    return {
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
        sessionRef: {
            active: activeSession,
            dir: 'sessions',
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
        secrets: {
            rootPrivateKey: {
                nonce: 'nonce',
                ciphertext: 'ciphertext',
                tag: 'tag',
            },
        },
    }
}

function makeSession(name: string, kind: 'session' | 'agent' = 'session'): AnySessionKeystore {
    const sessionPrivateKey = generatePrivateKey()

    const base = {
        version: 2 as const,
        createdAt: new Date().toISOString(),
        name,
        checkpoint: 'authorized' as const,
        network: {
            env: 'prod',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'https://mainnet.base.org',
            chainId: 8453,
        },
        kdf: {
            name: 'argon2id' as const,
            params: {
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1,
                hashLength: 32,
                salt: 'c2FsdA==',
            },
        },
        crypto: {
            algorithm: 'aes-256-gcm' as const,
        },
        addresses: {
            session: privateKeyToAccount(sessionPrivateKey).address,
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

    if (kind === 'agent') {
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

    return base
}

function makeBundle(activeSession: string, activeKeystore?: AnySessionKeystore): KeystoreBundle {
    return {
        rootPath: '/tmp/default.keystore.json',
        sessionPath: `/tmp/sessions/${activeSession}.json`,
        root: makeRoot(activeSession),
        session: activeKeystore ?? makeSession(activeSession),
    }
}

test('executeSessionList returns local sessions with active marker and kind', async () => {
    const workerOne = makeSession('worker-1')
    const bot = makeSession('bot', 'agent')

    const sessionsByPath = new Map<string, AnySessionKeystore>([
        ['/tmp/sessions/worker-1.json', workerOne],
        ['/tmp/sessions/bot.json', bot],
    ])

    const result = await executeSessionList(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
        },
        {
            readKeystoreBundle: mock(async () => makeBundle('bot', bot)),
            listSessionNames: mock(async () => ['worker-1', 'bot']),
            readSessionKeystoreFile: mock(async (path: string) => {
                const session = sessionsByPath.get(path)

                if (!session) {
                    throw new Error(`Missing fixture for ${path}`)
                }

                return session
            }),
        },
    )

    expect(result.type).toBe('session_list')
    expect(result.sessions).toHaveLength(2)
    expect(result.sessions[0]?.kind).toBe('session')
    expect(result.sessions[1]?.kind).toBe('agent')
    expect(result.sessions[1]?.active).toBe(true)
})

test('executeSessionRevoke requires --force for an active agent session', async () => {
    await expect(
        executeSessionRevoke(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'bot',
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(async () =>
                    makeBundle('bot', makeSession('bot', 'agent')),
                ),
                readSessionKeystoreFile: mock(async () => makeSession('bot', 'agent')),
            },
        ),
    ).rejects.toMatchObject({
        code: 'ACTIVE_SESSION_REVOKE_REQUIRES_FORCE',
        message:
            'This session is active and an agent with messaging channels. Use --force to confirm.',
    })
})

test('executeSessionRevoke --resume cleans local file and agent channels when key already revoked on-chain', async () => {
    const unlinkMock = mock(async () => undefined)
    const writeAgentChannelRegistry = mock(async () => undefined)
    const agentSession = makeSession('bot', 'agent')

    const result = await executeSessionRevoke(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            sessionName: 'bot',
            resume: true,
            force: true,
            password: 'pw',
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readKeystoreBundle: mock(async () => makeBundle('default')),
            readSessionKeystoreFile: mock(async () => agentSession),
            checkAgentListenPid: mock(async () => ({
                active: false,
                pidPath: '/tmp/sessions/bot.listen.pid',
            })),
            getKeys: mock(async () => ({ '0x2105': [] })),
            readAgentChannelRegistry: mock(async () => ({
                version: 1 as const,
                channels: {
                    [`art|${agentSession.addresses.session.toLowerCase()}:0x2222222222222222222222222222222222222222|hash-1`]:
                        '77stream-1',
                    'marketing|0x3333333333333333333333333333333333333333:0x4444444444444444444444444444444444444444|hash-2':
                        '77stream-2',
                },
            })),
            writeAgentChannelRegistry,
            unlink: unlinkMock,
        },
    )

    expect(result.bundle.id).toBe('already-revoked')
    expect(unlinkMock).toHaveBeenCalledTimes(1)
    expect(writeAgentChannelRegistry).toHaveBeenCalledWith('/tmp/default.keystore.json', {
        version: 1,
        channels: {
            'marketing|0x3333333333333333333333333333333333333333:0x4444444444444444444444444444444444444444|hash-2':
                '77stream-2',
        },
    })
})

test('executeSessionRevoke cleans agent channels before surfacing unverified revocation', async () => {
    const writeAgentChannelRegistry = mock(async () => undefined)
    const agentSession = makeSession('bot', 'agent')
    const sessionKeyHash = computeSessionKeyHash(getAddress(agentSession.addresses.session))

    await expect(
        executeSessionRevoke(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'bot',
                force: true,
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(async () => makeBundle('default')),
                readSessionKeystoreFile: mock(async () => agentSession),
                checkAgentListenPid: mock(async () => ({
                    active: false,
                    pidPath: '/tmp/sessions/bot.listen.pid',
                })),
                getKeys: mock(async () => ({
                    '0x2105': [
                        {
                            hash: sessionKeyHash,
                            expiry: '0x0' as const,
                            type: 'secp256k1' as const,
                            role: 'normal' as const,
                            publicKey: '0x' as const,
                            permissions: [],
                        },
                    ],
                })),
                decryptRootKeystore: mock(async () => ({
                    rootPrivateKey:
                        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const,
                })),
                readNonce: mock(async () => 1n),
                executeSignedCalls: mock(
                    async (): Promise<ExecuteSignedCallsResult> => ({
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
                    }),
                ),
                sleep: mock(async () => undefined),
                readAgentChannelRegistry: mock(async () => ({
                    version: 1 as const,
                    channels: {
                        [`art|${agentSession.addresses.session.toLowerCase()}|hash-1`]:
                            '77stream-1',
                    },
                })),
                writeAgentChannelRegistry,
            },
        ),
    ).rejects.toMatchObject({
        code: 'SESSION_REVOCATION_UNVERIFIED',
    })

    expect(writeAgentChannelRegistry).toHaveBeenCalledWith('/tmp/default.keystore.json', {
        version: 1,
        channels: {},
    })
})
