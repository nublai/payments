import { expect, mock, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import { ExportedDeviceSchema } from '@towns-labs/proto'
import { privateKeyToAccount } from 'viem/accounts'
import { decodeJoinToken, encodeJoinToken, executeAgentConnect } from '../src/lib/agent-connect'
import { hashChannelSecret, makeChannelSecretTopic } from '../src/lib/agent-identifiers'
import type { AgentClient } from '../src/lib/agent-runtime'
import type { AgentSessionKeystoreV2 } from '../src/lib/keystore'

const SESSION_PRIVATE_KEY =
    '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const SESSION_ADDRESS = privateKeyToAccount(SESSION_PRIVATE_KEY).address
const TARGET_ADDRESS = '0x2222222222222222222222222222222222222222'

function makeExportedDevice(byte: number) {
    return create(ExportedDeviceSchema, {
        pickleKey: 'pickle',
        pickledAccount: new Uint8Array([byte]),
        hybridGroupSessions: [],
    })
}

function makeAgentKeystore(
    overrides: Partial<AgentSessionKeystoreV2> = {},
): AgentSessionKeystoreV2 {
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
        ...overrides,
    }
}

function makeGdmStream(input: { members: string[]; name?: string; topic?: string }) {
    return {
        getMembers: () => ({
            joinedUsers: new Set(input.members),
        }),
        gdmChannelContent: {
            metadata:
                input.name || input.topic
                    ? {
                          name: input.name,
                          topic: input.topic,
                      }
                    : undefined,
        },
    }
}

function makeSessionRead(sessionKeystore: AgentSessionKeystoreV2) {
    return mock(async () => ({
        rootKeystorePath: '/tmp/default.keystore.json',
        bundle: {
            root: {
                sessionRef: { active: 'default', dir: 'sessions' },
            },
        },
        sessionPath: '/tmp/sessions/agent-alice.json',
        sessionKeystore,
    }))
}

test('executeAgentConnect creates a named channel, sets metadata, and returns a generated secret', async () => {
    const sessionKeystore = makeAgentKeystore({ namedChannels: undefined })
    const nextDevice = makeExportedDevice(9)
    const stop = mock(async () => undefined)
    const createGDMChannel = mock(async () => ({
        streamId: '77aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }))
    const updateGDMChannelProperties = mock(async () => undefined)
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel,
        updateGDMChannelProperties,
        getStream: mock(async () => {
            throw new Error('unused')
        }),
        initStream: mock(async () => ({ view: { isInitialized: true } })),
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage: mock(async () => ({ eventId: 'unused' })),
        stop,
        cryptoBackend: {
            exportDevice: mock(async () => nextDevice),
        },
    }
    const finalizeAgentSessionKeystore = mock(async (input) => ({
        ...sessionKeystore,
        namedChannels: input.namedChannels,
    }))

    const result = await executeAgentConnect(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            to: [TARGET_ADDRESS],
            password: 'pw',
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readCompleteAgentSession: makeSessionRead(sessionKeystore),
            checkAgentListenPid: mock(async () => ({ active: false, pidPath: '/tmp/pid' })),
            resolveAgentTargetAddresses: mock(async () => [TARGET_ADDRESS]),
            decryptSessionPrivateKey: mock(async () => SESSION_PRIVATE_KEY),
            decryptAgentDevice: mock(async () => makeExportedDevice(1)),
            createAgentClient: mock(async () => client),
            readAgentChannelRegistry: mock(async () => ({ version: 1, channels: {} })),
            writeAgentChannelRegistry: mock(async () => undefined),
            finalizeAgentSessionKeystore,
            writeAgentSession: mock(async () => undefined),
        },
    )

    expect(result.channel).toBe('art')
    expect(result.streamId).toBe('77aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(result.secret).toBeDefined()
    expect(decodeJoinToken(result.joinToken!)).toEqual({
        v: 1,
        channel: 'art',
        streamId: result.streamId,
        secret: result.secret,
    })
    expect(createGDMChannel).toHaveBeenCalledWith([TARGET_ADDRESS])
    expect(updateGDMChannelProperties).toHaveBeenCalledWith(
        result.streamId,
        'art',
        makeChannelSecretTopic(hashChannelSecret(result.secret!)),
    )
    expect(finalizeAgentSessionKeystore).toHaveBeenCalledWith({
        baseKeystore: sessionKeystore,
        password: 'pw',
        exportedDevice: nextDevice,
        namedChannels: {
            art: {
                streamId: result.streamId,
                secretHash: hashChannelSecret(result.secret!),
            },
        },
    })
    expect(stop).toHaveBeenCalledTimes(1)
})

test('executeAgentConnect deduplicates self targets before creating the channel and registry key', async () => {
    const sessionKeystore = makeAgentKeystore({ namedChannels: undefined })
    const nextDevice = makeExportedDevice(12)
    const stop = mock(async () => undefined)
    const createGDMChannel = mock(async () => ({
        streamId: '77bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }))
    const writeAgentChannelRegistry = mock(async () => undefined)
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel,
        updateGDMChannelProperties: mock(async () => undefined),
        getStream: mock(async () => {
            throw new Error('unused')
        }),
        initStream: mock(async () => ({ view: { isInitialized: true } })),
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage: mock(async () => ({ eventId: 'unused' })),
        stop,
        cryptoBackend: {
            exportDevice: mock(async () => nextDevice),
        },
    }

    await executeAgentConnect(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            secret: 'shared-secret',
            to: [SESSION_ADDRESS, TARGET_ADDRESS],
            password: 'pw',
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readCompleteAgentSession: makeSessionRead(sessionKeystore),
            checkAgentListenPid: mock(async () => ({ active: false, pidPath: '/tmp/pid' })),
            resolveAgentTargetAddresses: mock(async () => [SESSION_ADDRESS, TARGET_ADDRESS]),
            decryptSessionPrivateKey: mock(async () => SESSION_PRIVATE_KEY),
            decryptAgentDevice: mock(async () => makeExportedDevice(1)),
            createAgentClient: mock(async () => client),
            readAgentChannelRegistry: mock(async () => ({ version: 1, channels: {} })),
            writeAgentChannelRegistry,
            finalizeAgentSessionKeystore: mock(async (input) => ({
                ...sessionKeystore,
                namedChannels: input.namedChannels,
            })),
            writeAgentSession: mock(async () => undefined),
        },
    )

    expect(createGDMChannel).toHaveBeenCalledWith([TARGET_ADDRESS])
    expect(writeAgentChannelRegistry).toHaveBeenCalledWith('/tmp/default.keystore.json', {
        version: 1,
        channels: {
            [`art|${SESSION_ADDRESS.toLowerCase()}:${TARGET_ADDRESS.toLowerCase()}|${hashChannelSecret('shared-secret')}`]:
                '77bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
    })
    expect(stop).toHaveBeenCalledTimes(1)
})

test('executeAgentConnect reuses a shared registry mapping before creating a new GDM', async () => {
    const sessionKeystore = makeAgentKeystore({ namedChannels: undefined })
    const existingStreamId = `77${'c'.repeat(62)}`
    const nextDevice = makeExportedDevice(4)
    const stop = mock(async () => undefined)
    const createGDMChannel = mock(async () => ({ streamId: 'unused' }))
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel,
        updateGDMChannelProperties: mock(async () => undefined),
        getStream: mock(async () => {
            throw new Error('unused')
        }),
        initStream: mock(async (streamId: string) => {
            if (streamId === existingStreamId) {
                return {
                    view: makeGdmStream({
                        members: [SESSION_ADDRESS, TARGET_ADDRESS],
                    }),
                }
            }
            throw new Error(`unexpected init ${streamId}`)
        }),
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage: mock(async () => ({ eventId: 'unused' })),
        stop,
        cryptoBackend: {
            exportDevice: mock(async () => nextDevice),
        },
    }
    const finalizeAgentSessionKeystore = mock(async (input) => ({
        ...sessionKeystore,
        namedChannels: input.namedChannels,
    }))

    const result = await executeAgentConnect(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            secret: 'shared-secret',
            to: [TARGET_ADDRESS],
            password: 'pw',
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readCompleteAgentSession: makeSessionRead(sessionKeystore),
            checkAgentListenPid: mock(async () => ({ active: false, pidPath: '/tmp/pid' })),
            resolveAgentTargetAddresses: mock(async () => [TARGET_ADDRESS]),
            decryptSessionPrivateKey: mock(async () => SESSION_PRIVATE_KEY),
            decryptAgentDevice: mock(async () => makeExportedDevice(1)),
            createAgentClient: mock(async () => client),
            readAgentChannelRegistry: mock(async () => ({
                version: 1,
                channels: {
                    [`art|${SESSION_ADDRESS.toLowerCase()}:${TARGET_ADDRESS.toLowerCase()}|${hashChannelSecret('shared-secret')}`]:
                        existingStreamId,
                },
            })),
            writeAgentChannelRegistry: mock(async () => undefined),
            finalizeAgentSessionKeystore,
            writeAgentSession: mock(async () => undefined),
        },
    )

    expect(result.streamId).toBe(existingStreamId)
    expect(createGDMChannel).not.toHaveBeenCalled()
    expect(finalizeAgentSessionKeystore).toHaveBeenCalledWith({
        baseKeystore: sessionKeystore,
        password: 'pw',
        exportedDevice: nextDevice,
        namedChannels: {
            art: {
                streamId: existingStreamId,
                secretHash: hashChannelSecret('shared-secret'),
            },
        },
    })
    expect(stop).toHaveBeenCalledTimes(1)
})

test('executeAgentConnect does not create a duplicate GDM when local binding validation fails transiently', async () => {
    const sessionKeystore = makeAgentKeystore({
        namedChannels: {
            art: {
                streamId: `77${'d'.repeat(62)}`,
                secretHash: hashChannelSecret('shared-secret'),
            },
        },
    })
    const stop = mock(async () => undefined)
    const createGDMChannel = mock(async () => ({
        streamId: `77${'e'.repeat(62)}`,
    }))
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel,
        updateGDMChannelProperties: mock(async () => undefined),
        getStream: mock(async () => {
            throw new Error('unused')
        }),
        initStream: mock(async () => {
            throw new Error('timeout while validating stream')
        }),
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage: mock(async () => ({ eventId: 'unused' })),
        stop,
        cryptoBackend: {
            exportDevice: mock(async () => makeExportedDevice(7)),
        },
    }

    await expect(
        executeAgentConnect(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                from: 'alice',
                channel: 'art',
                secret: 'shared-secret',
                to: [TARGET_ADDRESS],
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readCompleteAgentSession: makeSessionRead(sessionKeystore),
                checkAgentListenPid: mock(async () => ({ active: false, pidPath: '/tmp/pid' })),
                resolveAgentTargetAddresses: mock(async () => [TARGET_ADDRESS]),
                decryptSessionPrivateKey: mock(async () => SESSION_PRIVATE_KEY),
                decryptAgentDevice: mock(async () => makeExportedDevice(1)),
                createAgentClient: mock(async () => client),
                readAgentChannelRegistry: mock(async () => ({ version: 1, channels: {} })),
                writeAgentChannelRegistry: mock(async () => undefined),
                finalizeAgentSessionKeystore: mock(async (input) => input.baseKeystore),
                writeAgentSession: mock(async () => undefined),
            },
        ),
    ).rejects.toMatchObject({
        code: 'SDK_ERROR',
    })

    expect(createGDMChannel).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
})

test('executeAgentConnect allows multiple named channels for the same members', async () => {
    const artSecretHash = hashChannelSecret('art-secret')
    const sessionKeystore = makeAgentKeystore({
        namedChannels: {
            art: {
                streamId: '77artartartartartartartartartartartartartartartartartartartart',
                secretHash: artSecretHash,
            },
        },
    })
    const nextDevice = makeExportedDevice(5)
    const stop = mock(async () => undefined)
    const createGDMChannel = mock(async () => ({
        streamId: '77cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    }))
    const updateGDMChannelProperties = mock(async () => undefined)
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel,
        updateGDMChannelProperties,
        getStream: mock(async () => {
            throw new Error('unused')
        }),
        initStream: mock(async () => {
            throw new Error('unused init')
        }),
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage: mock(async () => ({ eventId: 'unused' })),
        stop,
        cryptoBackend: {
            exportDevice: mock(async () => nextDevice),
        },
    }

    const result = await executeAgentConnect(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'marketing',
            secret: 'marketing-secret',
            to: [TARGET_ADDRESS],
            password: 'pw',
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readCompleteAgentSession: makeSessionRead(sessionKeystore),
            checkAgentListenPid: mock(async () => ({ active: false, pidPath: '/tmp/pid' })),
            resolveAgentTargetAddresses: mock(async () => [TARGET_ADDRESS]),
            decryptSessionPrivateKey: mock(async () => SESSION_PRIVATE_KEY),
            decryptAgentDevice: mock(async () => makeExportedDevice(1)),
            createAgentClient: mock(async () => client),
            readAgentChannelRegistry: mock(async () => ({ version: 1, channels: {} })),
            writeAgentChannelRegistry: mock(async () => undefined),
            finalizeAgentSessionKeystore: mock(async (input) => ({
                ...sessionKeystore,
                namedChannels: input.namedChannels,
            })),
            writeAgentSession: mock(async () => undefined),
        },
    )

    expect(result.streamId).toBe('77cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')
    expect(createGDMChannel).toHaveBeenCalledTimes(1)
    expect(updateGDMChannelProperties).toHaveBeenCalledWith(
        result.streamId,
        'marketing',
        makeChannelSecretTopic(hashChannelSecret('marketing-secret')),
    )
    expect(stop).toHaveBeenCalledTimes(1)
})

test('executeAgentConnect rejects reusing a local channel name for different members', async () => {
    const secretHash = hashChannelSecret('shared-secret')
    const sessionKeystore = makeAgentKeystore({
        namedChannels: {
            art: {
                streamId: '77dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                secretHash,
            },
        },
    })
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel: mock(async () => ({ streamId: 'unused' })),
        updateGDMChannelProperties: mock(async () => undefined),
        getStream: mock(async (streamId: string) => {
            if (streamId === '77dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd') {
                return makeGdmStream({
                    members: [SESSION_ADDRESS, '0x3333333333333333333333333333333333333333'],
                    name: 'art',
                    topic: makeChannelSecretTopic(secretHash),
                })
            }
            throw new Error(`unexpected stream lookup ${streamId}`)
        }),
        initStream: mock(async (streamId: string) => {
            if (streamId === '77dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd') {
                return {
                    view: makeGdmStream({
                        members: [SESSION_ADDRESS, '0x3333333333333333333333333333333333333333'],
                        name: 'art',
                        topic: makeChannelSecretTopic(secretHash),
                    }),
                }
            }
            throw new Error(`unexpected init lookup ${streamId}`)
        }),
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage: mock(async () => ({ eventId: 'unused' })),
        stop: mock(async () => undefined),
        cryptoBackend: {
            exportDevice: mock(async () => makeExportedDevice(1)),
        },
    }

    await expect(
        executeAgentConnect(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                from: 'alice',
                channel: 'art',
                secret: 'shared-secret',
                to: [TARGET_ADDRESS],
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readCompleteAgentSession: makeSessionRead(sessionKeystore),
                checkAgentListenPid: mock(async () => ({ active: false, pidPath: '/tmp/pid' })),
                resolveAgentTargetAddresses: mock(async () => [TARGET_ADDRESS]),
                decryptSessionPrivateKey: mock(async () => SESSION_PRIVATE_KEY),
                decryptAgentDevice: mock(async () => makeExportedDevice(1)),
                createAgentClient: mock(async () => client),
                readAgentChannelRegistry: mock(async () => ({ version: 1, channels: {} })),
                writeAgentChannelRegistry: mock(async () => undefined),
                finalizeAgentSessionKeystore: mock(async () => sessionKeystore),
                writeAgentSession: mock(async () => undefined),
            },
        ),
    ).rejects.toMatchObject({
        code: 'CHANNEL_CONFLICT',
    })
})

test('executeAgentConnect rejects a supplied secret that disagrees with the local binding', async () => {
    const sessionKeystore = makeAgentKeystore({
        namedChannels: {
            art: {
                streamId: '77eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                secretHash: hashChannelSecret('correct-secret'),
            },
        },
    })

    await expect(
        executeAgentConnect(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                from: 'alice',
                channel: 'art',
                secret: 'wrong-secret',
                to: [TARGET_ADDRESS],
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readCompleteAgentSession: makeSessionRead(sessionKeystore),
                checkAgentListenPid: mock(async () => ({ active: false, pidPath: '/tmp/pid' })),
                resolveAgentTargetAddresses: mock(async () => [TARGET_ADDRESS]),
                decryptSessionPrivateKey: mock(async () => SESSION_PRIVATE_KEY),
                decryptAgentDevice: mock(async () => makeExportedDevice(1)),
                readAgentChannelRegistry: mock(async () => ({ version: 1, channels: {} })),
                writeAgentChannelRegistry: mock(async () => undefined),
            },
        ),
    ).rejects.toMatchObject({
        code: 'CHANNEL_SECRET_MISMATCH',
    })
})

test('decodeJoinToken rejects malformed payloads', () => {
    expect(() => decodeJoinToken('not-base64')).toThrow(
        'Invalid join token: malformed base64url or JSON',
    )
    expect(() =>
        decodeJoinToken(
            Buffer.from(
                JSON.stringify({
                    v: 2,
                    channel: 'art',
                    streamId: '77stream',
                    secret: 'shared-secret',
                }),
            ).toString('base64url'),
        ),
    ).toThrow('Invalid join token:')
})

test('executeAgentConnect binds an existing stream from a join token', async () => {
    const sessionKeystore = makeAgentKeystore({ namedChannels: undefined })
    const nextDevice = makeExportedDevice(21)
    const writeAgentChannelRegistry = mock(async () => undefined)
    const finalizeAgentSessionKeystore = mock(async (input) => ({
        ...sessionKeystore,
        namedChannels: input.namedChannels,
    }))
    const joinToken = encodeJoinToken({
        v: 1,
        channel: 'art',
        streamId: `77${'f'.repeat(62)}`,
        secret: 'shared-secret',
    })
    const stop = mock(async () => undefined)
    const createGDMChannel = mock(async () => ({ streamId: 'unused' }))
    const client: AgentClient = {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel,
        updateGDMChannelProperties: mock(async () => undefined),
        getStream: mock(async () => {
            throw new Error('unused')
        }),
        initStream: mock(async (streamId: string) => {
            if (streamId === `77${'f'.repeat(62)}`) {
                return {
                    view: makeGdmStream({
                        members: [SESSION_ADDRESS, TARGET_ADDRESS],
                    }),
                }
            }
            throw new Error(`unexpected init ${streamId}`)
        }),
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage: mock(async () => ({ eventId: 'unused' })),
        stop,
        cryptoBackend: {
            exportDevice: mock(async () => nextDevice),
        },
    }

    const result = await executeAgentConnect(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            join: joinToken,
            to: [],
            password: 'pw',
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readCompleteAgentSession: makeSessionRead(sessionKeystore),
            checkAgentListenPid: mock(async () => ({ active: false, pidPath: '/tmp/pid' })),
            decryptSessionPrivateKey: mock(async () => SESSION_PRIVATE_KEY),
            decryptAgentDevice: mock(async () => makeExportedDevice(1)),
            createAgentClient: mock(async () => client),
            readAgentChannelRegistry: mock(async () => ({ version: 1, channels: {} })),
            writeAgentChannelRegistry,
            finalizeAgentSessionKeystore,
            writeAgentSession: mock(async () => undefined),
        },
    )

    expect(result).toEqual({
        type: 'agent_connect',
        status: 'complete',
        channel: 'art',
        streamId: `77${'f'.repeat(62)}`,
        from: {
            name: 'alice',
            address: SESSION_ADDRESS,
        },
        to: [],
        memberCount: 0,
    })
    expect(createGDMChannel).not.toHaveBeenCalled()
    expect(finalizeAgentSessionKeystore).toHaveBeenCalledWith({
        baseKeystore: sessionKeystore,
        password: 'pw',
        exportedDevice: nextDevice,
        namedChannels: {
            art: {
                streamId: `77${'f'.repeat(62)}`,
                secretHash: hashChannelSecret('shared-secret'),
            },
        },
    })
    expect(writeAgentChannelRegistry).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
})
