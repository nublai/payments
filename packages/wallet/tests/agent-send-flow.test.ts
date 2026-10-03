import { expect, mock, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import { ExportedDeviceSchema } from '@towns-labs/proto'
import { privateKeyToAccount } from 'viem/accounts'
import { executeAgentSend } from '../src/lib/agent-send'
import type { AgentClient } from '../src/lib/agent-runtime'
import type { AgentSessionKeystoreV2 } from '../src/lib/keystore'

function makeAgentKeystore(): AgentSessionKeystoreV2 {
    const sessionPrivateKey =
        '0x1111111111111111111111111111111111111111111111111111111111111111' as const
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
            session: privateKeyToAccount(sessionPrivateKey).address,
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
                streamId: '0xstream-existing',
                secretHash: 'hash',
            },
        },
    }
}

test('executeAgentSend initializes from exported device and sends without persisting state', async () => {
    const sessionKeystore = makeAgentKeystore()
    const exportedDevice = create(ExportedDeviceSchema, {
        pickleKey: 'pickle',
        pickledAccount: new Uint8Array([1]),
        hybridGroupSessions: [],
    })
    const initializeUser = mock(async () => undefined)
    const initStream = mock(async () => ({
        view: {
            isInitialized: true,
        },
    }))
    const sendMessage = mock(async () => ({ eventId: 'event-1' }))
    const stop = mock(async () => undefined)
    const client: AgentClient = {
        initializeUser,
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel: mock(async () => ({ streamId: 'unused' })),
        updateGDMChannelProperties: mock(async () => undefined),
        getStream: mock(async () => ({
            getMembers: () => ({
                joinedUsers: new Set([sessionKeystore.addresses.session]),
            }),
        })),
        initStream,
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage,
        stop,
        cryptoBackend: {
            exportDevice: mock(async () => exportedDevice),
        },
    }

    const result = await executeAgentSend(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            message: 'hello',
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
            decryptSessionPrivateKey: mock(
                async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
            decryptAgentDevice: mock(async () => exportedDevice),
            createAgentClient: mock(async () => client),
        },
    )

    expect(initializeUser).toHaveBeenCalledWith({
        encryptionDeviceInit: {
            fromExportedDevice: exportedDevice,
        },
        skipSync: true,
    })
    expect(initStream).toHaveBeenCalledWith('0xstream-existing')
    expect(sendMessage).toHaveBeenCalledWith('0xstream-existing', 'hello')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
        type: 'agent_send',
        status: 'complete',
        streamId: '0xstream-existing',
        eventId: 'event-1',
    })
})

test('executeAgentSend accepts stream membership even when joined user casing differs', async () => {
    const sessionKeystore = makeAgentKeystore()
    const exportedDevice = create(ExportedDeviceSchema, {
        pickleKey: 'pickle',
        pickledAccount: new Uint8Array([1]),
        hybridGroupSessions: [],
    })
    const stop = mock(async () => undefined)
    const sendMessage = mock(async () => ({ eventId: 'event-2' }))
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel: mock(async () => ({ streamId: 'unused' })),
        updateGDMChannelProperties: mock(async () => undefined),
        getStream: mock(async () => ({
            getMembers: () => ({
                joinedUsers: new Set([sessionKeystore.addresses.session.toLowerCase()]),
            }),
        })),
        initStream: mock(async () => ({
            view: {
                isInitialized: true,
            },
        })),
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage,
        stop,
        cryptoBackend: {
            exportDevice: mock(async () => exportedDevice),
        },
    }

    const result = await executeAgentSend(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            message: 'hello with lowercase member',
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
            decryptSessionPrivateKey: mock(
                async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
            decryptAgentDevice: mock(async () => exportedDevice),
            createAgentClient: mock(async () => client),
        },
    )

    expect(sendMessage).toHaveBeenCalledWith('0xstream-existing', 'hello with lowercase member')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(result.eventId).toBe('event-2')
})

test('executeAgentSend rejects streams the agent is not a member of', async () => {
    const sessionKeystore = makeAgentKeystore()
    const stop = mock(async () => undefined)
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel: mock(async () => ({ streamId: 'unused' })),
        updateGDMChannelProperties: mock(async () => undefined),
        getStream: mock(async () => ({
            getMembers: () => ({
                joinedUsers: new Set(['0x2222222222222222222222222222222222222222']),
            }),
        })),
        initStream: mock(async () => ({
            view: {
                isInitialized: true,
            },
        })),
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

    await expect(
        executeAgentSend(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                from: 'alice',
                streamId: '0xstream-missing',
                message: 'hello',
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
                decryptSessionPrivateKey: mock(
                    async () =>
                        '0x1111111111111111111111111111111111111111111111111111111111111111',
                ),
                decryptAgentDevice: mock(async () =>
                    create(ExportedDeviceSchema, {
                        pickleKey: 'pickle',
                        pickledAccount: new Uint8Array([1]),
                        hybridGroupSessions: [],
                    }),
                ),
                createAgentClient: mock(async () => client),
            },
        ),
    ).rejects.toMatchObject({
        code: 'STREAM_NOT_FOUND',
    })

    expect(stop).toHaveBeenCalledTimes(1)
})

test('executeAgentSend uses sendChannelMessage_Text when replyTo is provided', async () => {
    const sessionKeystore = makeAgentKeystore()
    const exportedDevice = create(ExportedDeviceSchema, {
        pickleKey: 'pickle',
        pickledAccount: new Uint8Array([1]),
        hybridGroupSessions: [],
    })
    const sendChannelMessage_Text = mock(async () => ({ eventId: 'reply-event' }))
    const sendMessage = mock(async () => ({ eventId: 'unused' }))
    const stop = mock(async () => undefined)
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel: mock(async () => ({ streamId: 'unused' })),
        updateGDMChannelProperties: mock(async () => undefined),
        getStream: mock(async () => ({
            getMembers: () => ({
                joinedUsers: new Set([sessionKeystore.addresses.session]),
            }),
        })),
        initStream: mock(async () => ({
            view: {
                isInitialized: true,
            },
        })),
        sendChannelMessage_Text,
        sendMessage,
        stop,
        cryptoBackend: {
            exportDevice: mock(async () => exportedDevice),
        },
    }

    const result = await executeAgentSend(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            message: 'reply body',
            replyTo: 'event-0',
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
            decryptSessionPrivateKey: mock(
                async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
            decryptAgentDevice: mock(async () => exportedDevice),
            createAgentClient: mock(async () => client),
        },
    )

    expect(sendChannelMessage_Text).toHaveBeenCalledWith('0xstream-existing', {
        replyId: 'event-0',
        replyPreview: '\u{1F648}',
        content: {
            body: 'reply body',
            mentions: [],
            attachments: [],
        },
    })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(result.eventId).toBe('reply-event')
    expect(stop).toHaveBeenCalledTimes(1)
})
