import { expect, mock, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import { ExportedDeviceSchema } from '@towns-labs/proto'
import { privateKeyToAccount } from 'viem/accounts'
import { executeAgentChannels } from '../src/lib/agent-channels'
import type { AgentClient } from '../src/lib/agent-runtime'
import type { AgentSessionKeystoreV2 } from '../src/lib/keystore'

const SESSION_PRIVATE_KEY =
    '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const SESSION_ADDRESS = privateKeyToAccount(SESSION_PRIVATE_KEY).address

function makeAgentKeystore(): AgentSessionKeystoreV2 {
    return {
        version: 2,
        createdAt: new Date().toISOString(),
        name: 'agent-alice',
        kind: 'agent',
        checkpoint: 'complete',
        network: {
            env: 'prod',
            relayerUrl: 'https://relayer-worker.towns.com/',
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
            session: SESSION_ADDRESS,
            delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        secrets: {
            sessionPrivateKey: {
                nonce: 'nonce',
                ciphertext: 'ciphertext',
                tag: 'tag',
            },
            encryptionDevice: {
                nonce: 'device-nonce',
                ciphertext: 'device-ciphertext',
                tag: 'device-tag',
            },
        },
        namedChannels: {
            art: {
                streamId: '77art',
                secretHash: 'hash-art',
            },
            marketing: {
                streamId: '77marketing',
                secretHash: 'hash-marketing',
            },
        },
    }
}

function makeGdmStream(input: { members: string[] }) {
    return {
        getMembers: () => ({
            joinedUsers: new Set(input.members),
        }),
    }
}

test('executeAgentChannels lists named bindings and only flags missing streams as stale', async () => {
    const sessionKeystore = makeAgentKeystore()
    const stop = mock(async () => undefined)
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel: mock(async () => ({ streamId: 'unused' })),
        updateGDMChannelProperties: mock(async () => undefined),
        initStream: mock(async (streamId: string) => {
            if (streamId === '77art') {
                return {
                    view: makeGdmStream({
                        members: [SESSION_ADDRESS, '0x2222222222222222222222222222222222222222'],
                    }),
                }
            }
            throw new Error(`unexpected init ${streamId}`)
        }),
        getStream: mock(async () => {
            throw new Error('unused')
        }),
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage: mock(async () => ({ eventId: 'unused' })),
        stop,
        cryptoBackend: {
            exportDevice: mock(async () =>
                create(ExportedDeviceSchema, {
                    pickleKey: 'pickle',
                    pickledAccount: new Uint8Array([1]),
                    hybridGroupSessions: [],
                }),
            ),
        },
    }

    const result = await executeAgentChannels(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            password: 'pw',
        },
        {
            readCompleteAgentSession: mock(async () => ({
                rootKeystorePath: '/tmp/default.keystore.json',
                bundle: {
                    root: {
                        sessionRef: { active: 'default', dir: 'sessions' },
                    },
                },
                sessionPath: '/tmp/sessions/agent-alice.json',
                sessionKeystore,
            })),
            decryptSessionPrivateKey: mock(async () => SESSION_PRIVATE_KEY),
            decryptAgentDevice: mock(async () =>
                create(ExportedDeviceSchema, {
                    pickleKey: 'pickle',
                    pickledAccount: new Uint8Array([1]),
                    hybridGroupSessions: [],
                }),
            ),
            createAgentClient: mock(async () => client),
        },
    )

    expect(result.agent).toEqual({
        name: 'alice',
        address: SESSION_ADDRESS,
    })
    expect(result.channels).toEqual([
        {
            name: 'art',
            streamId: '77art',
            members: [SESSION_ADDRESS, '0x2222222222222222222222222222222222222222'],
            memberCount: 2,
        },
    ])
    expect(result.staleChannels).toEqual([
        {
            name: 'marketing',
            streamId: '77marketing',
            reason: 'stream_missing',
        },
    ])
    expect(stop).toHaveBeenCalledTimes(1)
})
