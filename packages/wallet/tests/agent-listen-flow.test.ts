import { expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { create, toBinary } from '@bufbuild/protobuf'
import { ExportedDeviceSchema, MembershipOp } from '@towns-labs/proto'
import { privateKeyToAccount } from 'viem/accounts'
import { executeAgentListen } from '../src/lib/agent-listen'
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
                streamId: '77stream',
                secretHash: 'hash',
            },
        },
    }
}

class FakeAgentClient extends EventEmitter implements AgentClient {
    initializeUser = mock(async () => undefined)
    uploadDeviceKeys = mock(async () => undefined)
    createGDMChannel = mock(async () => ({ streamId: 'unused' }))
    updateGDMChannelProperties = mock(async () => undefined)
    initStream = mock(async () => ({
        view: {
            isInitialized: true,
        },
    }))
    sendChannelMessage_Text = mock(async () => ({ eventId: 'unused' }))
    sendMessage = mock(async () => ({ eventId: 'unused' }))
    stop = mock(async () => undefined)
    getStream = mock(async (_streamId: string) => ({
        userContent: {
            streamMemberships: {
                '77stream': {
                    op: MembershipOp.SO_JOIN,
                },
            },
        },
    }))
    cryptoBackend = {
        exportDevice: mock(async () =>
            create(ExportedDeviceSchema, {
                pickleKey: 'pickle-next',
                pickledAccount: new Uint8Array([9]),
                hybridGroupSessions: [],
            }),
        ),
    }
    startSync = mock(() => undefined)
}

test('executeAgentListen rejects when another listener already owns the agent pid', async () => {
    await expect(
        executeAgentListen(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                from: 'alice',
                channel: 'art',
                password: 'pw',
                heartbeatIntervalSeconds: 0,
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
                    sessionKeystore: makeAgentKeystore(),
                })),
                claimAgentListenPid: mock(async () => {
                    const error = new Error('exists') as NodeJS.ErrnoException
                    error.code = 'EEXIST'
                    throw error
                }),
            },
        ),
    ).rejects.toMatchObject({
        code: 'LISTEN_ACTIVE',
    })
})

test('executeAgentListen releases pid claim and runtime handlers when channel binding is missing', async () => {
    const release = mock(async () => undefined)
    const cleanupRuntimeHandlers = mock(() => undefined)

    await expect(
        executeAgentListen(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                from: 'alice',
                channel: 'missing',
                password: 'pw',
                heartbeatIntervalSeconds: 0,
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
                    sessionKeystore: makeAgentKeystore(),
                })),
                claimAgentListenPid: mock(async () => ({
                    pidPath: '/tmp/sessions/agent-alice.listen.pid',
                    release,
                })),
                installRuntimeHandlers: () => cleanupRuntimeHandlers,
            },
        ),
    ).rejects.toMatchObject({
        code: 'CHANNEL_NOT_FOUND',
    })

    expect(release).toHaveBeenCalledTimes(1)
    expect(cleanupRuntimeHandlers).toHaveBeenCalledTimes(1)
})

test('executeAgentListen streams decrypted messages and persists device state on shutdown', async () => {
    const sessionKeystore = makeAgentKeystore()
    const stdoutLines: string[] = []
    const stderrLines: string[] = []
    const abortController = new AbortController()
    const release = mock(async () => undefined)
    const client = new FakeAgentClient()
    let timerId = 0
    client.initializeUser = mock(async () => {
        queueMicrotask(() => {
            client.emit('streamSyncActive', true)
            client.emit('eventDecrypted', '77stream', 'gdmChannelContent', {
                eventId: 'event-1',
                createdAtEpochMs: 2_000,
                sender: {
                    id: '0x2222222222222222222222222222222222222222',
                },
                content: {
                    kind: 'm.channel.message',
                    body: 'hello from bob',
                    replyId: 'event-0',
                    threadId: 'thread-0',
                },
            })
        })
    })
    const writeAgentSession = mock(async () => {
        if (writeAgentSession.mock.calls.length === 1) {
            queueMicrotask(() => abortController.abort())
        }
    })
    const rotatedKeystore: AgentSessionKeystoreV2 = {
        ...sessionKeystore,
        secrets: {
            ...sessionKeystore.secrets,
            encryptionDevice: {
                nonce: 'device-nonce-rotated',
                ciphertext: 'device-ciphertext-rotated',
                tag: 'device-tag-rotated',
            },
        },
    }
    const finalizeAgentSessionKeystore = mock(async (input) =>
        finalizeAgentSessionKeystore.mock.calls.length === 1
            ? rotatedKeystore
            : {
                  ...input.baseKeystore,
                  namedChannels: input.namedChannels,
              },
    )

    await executeAgentListen(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            password: 'pw',
            heartbeatIntervalSeconds: 0,
            signal: abortController.signal,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
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
            claimAgentListenPid: mock(async () => ({
                pidPath: '/tmp/sessions/agent-alice.listen.pid',
                release,
            })),
            decryptSessionPrivateKey: mock(
                async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
            decryptAgentDevice: mock(async () =>
                create(ExportedDeviceSchema, {
                    pickleKey: 'pickle',
                    pickledAccount: new Uint8Array([1]),
                    hybridGroupSessions: [],
                }),
            ),
            createAgentClient: mock(async () => client),
            finalizeAgentSessionKeystore,
            writeAgentSession,
            stdoutWrite: (line) => {
                stdoutLines.push(line)
            },
            stderrWrite: (line) => {
                stderrLines.push(line)
            },
            now: () => 1_000,
            random: () => 0,
            processMemoryUsage: () => ({
                rss: 0,
                heapTotal: 0,
                heapUsed: 0,
                external: 0,
                arrayBuffers: 0,
            }),
            installRuntimeHandlers: () => () => undefined,
            setInterval: ((callback: () => void, intervalMs: number) => {
                timerId += 1
                if (intervalMs === 60_000) {
                    queueMicrotask(() => callback())
                }
                return timerId as unknown as ReturnType<typeof setInterval>
            }) as typeof setInterval,
            clearInterval: (() => undefined) as typeof clearInterval,
        },
    )

    expect(stdoutLines).toEqual([
        JSON.stringify({
            type: 'message',
            streamId: '77stream',
            senderId: '0x2222222222222222222222222222222222222222',
            eventId: 'event-1',
            timestamp: 2,
            content: 'hello from bob',
            replyTo: 'event-0',
            threadId: 'thread-0',
        }) + '\n',
    ])
    expect(stderrLines).toEqual([
        JSON.stringify({
            type: 'status',
            state: 'connected',
            streamCount: 1,
        }) + '\n',
    ])
    expect(client.initializeUser).toHaveBeenCalledWith({
        encryptionDeviceInit: {
            fromExportedDevice: create(ExportedDeviceSchema, {
                pickleKey: 'pickle',
                pickledAccount: new Uint8Array([1]),
                hybridGroupSessions: [],
            }),
        },
    })
    expect(writeAgentSession).toHaveBeenCalledTimes(2)
    expect(finalizeAgentSessionKeystore).toHaveBeenCalledTimes(2)
    expect(finalizeAgentSessionKeystore.mock.calls[1]?.[0].baseKeystore).toBe(rotatedKeystore)
    expect(writeAgentSession.mock.calls[0]?.[0]).toBe('/tmp/sessions/agent-alice.json')
    expect(writeAgentSession.mock.calls[0]?.[1]).toBe(rotatedKeystore)
    expect(writeAgentSession.mock.calls[1]?.[1]).toEqual({
        ...rotatedKeystore,
        namedChannels: rotatedKeystore.namedChannels,
    })
    expect(client.stop).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})

test('executeAgentListen refreshes keystore state after a failed session before retrying', async () => {
    const initialKeystore = makeAgentKeystore()
    const refreshedKeystore: AgentSessionKeystoreV2 = {
        ...initialKeystore,
        namedChannels: {
            art: {
                streamId: '77refreshed',
                secretHash: 'hash',
            },
        },
    }
    const abortController = new AbortController()
    const release = mock(async () => undefined)
    const firstClient = new FakeAgentClient()
    const secondClient = new FakeAgentClient()
    firstClient.initializeUser = mock(async () => {
        throw new Error('temporary sync failure')
    })
    secondClient.initializeUser = mock(async () => {
        queueMicrotask(() => {
            abortController.abort()
        })
    })
    const readCompleteAgentSession = mock(async () => {
        if (readCompleteAgentSession.mock.calls.length === 1) {
            return {
                rootKeystorePath: '/tmp/default.keystore.json',
                bundle: {
                    root: {
                        sessionRef: { active: 'default', dir: 'sessions' },
                    },
                },
                sessionPath: '/tmp/sessions/agent-alice.json',
                sessionKeystore: initialKeystore,
            }
        }
        return {
            rootKeystorePath: '/tmp/default.keystore.json',
            bundle: {
                root: {
                    sessionRef: { active: 'default', dir: 'sessions' },
                },
            },
            sessionPath: '/tmp/sessions/agent-alice.json',
            sessionKeystore: refreshedKeystore,
        }
    })
    const decryptAgentDevice = mock(async (keystore: AgentSessionKeystoreV2) =>
        create(ExportedDeviceSchema, {
            pickleKey:
                keystore.namedChannels?.art?.streamId === '77refreshed'
                    ? 'pickle-refreshed'
                    : 'pickle-initial',
            pickledAccount: new Uint8Array([1]),
            hybridGroupSessions: [],
        }),
    )
    const createAgentClient = mock(async () => {
        if (createAgentClient.mock.calls.length === 1) {
            return firstClient
        }
        return secondClient
    })

    await executeAgentListen(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            password: 'pw',
            heartbeatIntervalSeconds: 0,
            signal: abortController.signal,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readCompleteAgentSession,
            claimAgentListenPid: mock(async () => ({
                pidPath: '/tmp/sessions/agent-alice.listen.pid',
                release,
            })),
            decryptSessionPrivateKey: mock(
                async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
            decryptAgentDevice,
            createAgentClient,
            finalizeAgentSessionKeystore: mock(async (input) => input.baseKeystore),
            writeAgentSession: mock(async () => undefined),
            stdoutWrite: () => undefined,
            stderrWrite: () => undefined,
            now: () => 1_000,
            random: () => 0,
            processMemoryUsage: () => ({
                rss: 0,
                heapTotal: 0,
                heapUsed: 0,
                external: 0,
                arrayBuffers: 0,
            }),
            installRuntimeHandlers: () => () => undefined,
        },
    )

    expect(readCompleteAgentSession).toHaveBeenCalledTimes(2)
    expect(decryptAgentDevice.mock.calls[0]?.[0]).toBe(initialKeystore)
    expect(decryptAgentDevice.mock.calls[1]?.[0]).toBe(refreshedKeystore)
    expect(firstClient.stop).toHaveBeenCalledTimes(1)
    expect(secondClient.stop).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})

test('executeAgentListen warns when keystore refresh fails and falls back to cached state', async () => {
    const initialKeystore = makeAgentKeystore()
    const abortController = new AbortController()
    const release = mock(async () => undefined)
    const stderrLines: string[] = []
    const firstClient = new FakeAgentClient()
    const secondClient = new FakeAgentClient()
    firstClient.initializeUser = mock(async () => {
        throw new Error('temporary sync failure')
    })
    secondClient.initializeUser = mock(async () => {
        queueMicrotask(() => {
            abortController.abort()
        })
    })
    const readCompleteAgentSession = mock(async () => {
        if (readCompleteAgentSession.mock.calls.length === 1) {
            return {
                rootKeystorePath: '/tmp/default.keystore.json',
                bundle: {
                    root: {
                        sessionRef: { active: 'default', dir: 'sessions' },
                    },
                },
                sessionPath: '/tmp/sessions/agent-alice.json',
                sessionKeystore: initialKeystore,
            }
        }
        throw new Error('refresh read failed')
    })
    const decryptAgentDevice = mock(async () =>
        create(ExportedDeviceSchema, {
            pickleKey: 'pickle-initial',
            pickledAccount: new Uint8Array([1]),
            hybridGroupSessions: [],
        }),
    )
    const createAgentClient = mock(async () => {
        if (createAgentClient.mock.calls.length === 1) {
            return firstClient
        }
        return secondClient
    })

    await executeAgentListen(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            password: 'pw',
            heartbeatIntervalSeconds: 0,
            signal: abortController.signal,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readCompleteAgentSession,
            claimAgentListenPid: mock(async () => ({
                pidPath: '/tmp/sessions/agent-alice.listen.pid',
                release,
            })),
            decryptSessionPrivateKey: mock(
                async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
            decryptAgentDevice,
            createAgentClient,
            finalizeAgentSessionKeystore: mock(async (input) => input.baseKeystore),
            writeAgentSession: mock(async () => undefined),
            stdoutWrite: () => undefined,
            stderrWrite: (line) => {
                stderrLines.push(line)
            },
            now: () => 1_000,
            random: () => 0,
            processMemoryUsage: () => ({
                rss: 0,
                heapTotal: 0,
                heapUsed: 0,
                external: 0,
                arrayBuffers: 0,
            }),
            installRuntimeHandlers: () => () => undefined,
        },
    )

    expect(stderrLines).toContain(
        JSON.stringify({
            type: 'warning',
            message: 'Failed to refresh session keystore, using cached version',
            reason: 'refresh read failed',
        }) + '\n',
    )
    expect(decryptAgentDevice).toHaveBeenCalledTimes(2)
    expect(decryptAgentDevice.mock.calls[0]?.[0]).toBe(initialKeystore)
    expect(decryptAgentDevice.mock.calls[1]?.[0]).toBe(initialKeystore)
    expect(firstClient.stop).toHaveBeenCalledTimes(1)
    expect(secondClient.stop).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})

test('executeAgentListen warns when status stream lookup fails without reconnecting', async () => {
    const sessionKeystore = makeAgentKeystore()
    const abortController = new AbortController()
    const release = mock(async () => undefined)
    const stderrLines: string[] = []
    const client = new FakeAgentClient()
    client.getStream = mock(async () => {
        throw new Error('status unavailable')
    })
    client.initializeUser = mock(async () => {
        queueMicrotask(() => {
            client.emit('streamSyncActive', true)
            abortController.abort()
        })
    })

    await executeAgentListen(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            password: 'pw',
            heartbeatIntervalSeconds: 0,
            signal: abortController.signal,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
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
            claimAgentListenPid: mock(async () => ({
                pidPath: '/tmp/sessions/agent-alice.listen.pid',
                release,
            })),
            decryptSessionPrivateKey: mock(
                async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
            decryptAgentDevice: mock(async () =>
                create(ExportedDeviceSchema, {
                    pickleKey: 'pickle',
                    pickledAccount: new Uint8Array([1]),
                    hybridGroupSessions: [],
                }),
            ),
            createAgentClient: mock(async () => client),
            finalizeAgentSessionKeystore: mock(async (input) => input.baseKeystore),
            writeAgentSession: mock(async () => undefined),
            stdoutWrite: () => undefined,
            stderrWrite: (line) => {
                stderrLines.push(line)
            },
            now: () => 1_000,
            random: () => 0,
            processMemoryUsage: () => ({
                rss: 0,
                heapTotal: 0,
                heapUsed: 0,
                external: 0,
                arrayBuffers: 0,
            }),
            installRuntimeHandlers: () => () => undefined,
        },
    )

    expect(stderrLines).toContain(
        JSON.stringify({
            type: 'warning',
            message: 'Failed to load user stream for status update',
            reason: 'status unavailable',
        }) + '\n',
    )
    expect(stderrLines.some((line) => line.includes('"type":"reconnect"'))).toBe(false)
    expect(client.stop).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})

test('executeAgentListen fails after repeated persist errors instead of reconnecting forever', async () => {
    const sessionKeystore = makeAgentKeystore()
    const release = mock(async () => undefined)
    const stderrLines: string[] = []
    const client = new FakeAgentClient()
    let timerId = 0
    const intervalCallbacks = new Map<number, () => void>()

    client.initializeUser = mock(async () => undefined)

    await expect(
        executeAgentListen(
            {
                env: 'prod',
                keystorePath: '/tmp/default.keystore.json',
                from: 'alice',
                channel: 'art',
                password: 'pw',
                heartbeatIntervalSeconds: 0,
            },
            {
                withKeystoreLock: async (_path, action) => action(),
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
                claimAgentListenPid: mock(async () => ({
                    pidPath: '/tmp/sessions/agent-alice.listen.pid',
                    release,
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
                finalizeAgentSessionKeystore: mock(async (input) => input.baseKeystore),
                writeAgentSession: mock(async () => {
                    throw new Error('disk full')
                }),
                stdoutWrite: () => undefined,
                stderrWrite: (line) => {
                    stderrLines.push(line)
                },
                now: () => 1_000,
                random: () => 0,
                processMemoryUsage: () => ({
                    rss: 0,
                    heapTotal: 0,
                    heapUsed: 0,
                    external: 0,
                    arrayBuffers: 0,
                }),
                setInterval: ((callback: () => void, intervalMs: number) => {
                    timerId += 1
                    intervalCallbacks.set(timerId, callback)
                    if (intervalMs === 60_000) {
                        const scheduleAttempt = (remaining: number) => {
                            globalThis.setTimeout(() => {
                                callback()
                                if (remaining > 1) {
                                    scheduleAttempt(remaining - 1)
                                }
                            }, 0)
                        }
                        scheduleAttempt(3)
                    }
                    return timerId as unknown as ReturnType<typeof setInterval>
                }) as typeof setInterval,
                clearInterval: ((value: ReturnType<typeof setInterval>) => {
                    intervalCallbacks.delete(value as unknown as number)
                }) as typeof clearInterval,
                installRuntimeHandlers: () => () => undefined,
            },
        ),
    ).rejects.toMatchObject({
        code: 'SDK_ERROR',
        message: 'Failed to persist agent device state after 3 attempts: disk full',
    })

    expect(stderrLines).toContain(
        JSON.stringify({
            type: 'warning',
            message: 'Failed to persist agent device state',
            attempt: 1,
            reason: 'disk full',
        }) + '\n',
    )
    expect(stderrLines).toContain(
        JSON.stringify({
            type: 'warning',
            message: 'Failed to persist agent device state',
            attempt: 2,
            reason: 'disk full',
        }) + '\n',
    )
    expect(stderrLines.some((line) => line.includes('"type":"reconnect"'))).toBe(false)
    expect(client.stop).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})

test('executeAgentListen sends interactive stdin lines and emits sent confirmations as NDJSON', async () => {
    const sessionKeystore = makeAgentKeystore()
    const stdoutLines: string[] = []
    const stderrLines: string[] = []
    const abortController = new AbortController()
    const release = mock(async () => undefined)
    const stdinStream = new PassThrough()
    const client = new FakeAgentClient()

    client.initializeUser = mock(async () => {
        queueMicrotask(() => {
            client.emit('streamSyncActive', true)
        })
    })
    client.sendMessage = mock(async (streamId: string, content: string) => {
        expect(streamId).toBe('77stream')
        expect(content).toBe('hello from stdin')
        queueMicrotask(() => abortController.abort())
        return { eventId: 'sent-1' }
    })

    stdinStream.write('hello from stdin\n')
    stdinStream.end()

    await executeAgentListen(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            interactive: true,
            password: 'pw',
            heartbeatIntervalSeconds: 0,
            signal: abortController.signal,
        },
        {
            stdinStream,
            withKeystoreLock: async (_path, action) => action(),
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
            claimAgentListenPid: mock(async () => ({
                pidPath: '/tmp/sessions/agent-alice.listen.pid',
                release,
            })),
            decryptSessionPrivateKey: mock(
                async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
            decryptAgentDevice: mock(async () =>
                create(ExportedDeviceSchema, {
                    pickleKey: 'pickle',
                    pickledAccount: new Uint8Array([1]),
                    hybridGroupSessions: [],
                }),
            ),
            createAgentClient: mock(async () => client),
            finalizeAgentSessionKeystore: mock(async (input) => input.baseKeystore),
            writeAgentSession: mock(async () => undefined),
            stdoutWrite: (line) => {
                stdoutLines.push(line)
            },
            stderrWrite: (line) => {
                stderrLines.push(line)
            },
            now: () => 1_000,
            random: () => 0,
            processMemoryUsage: () => ({
                rss: 0,
                heapTotal: 0,
                heapUsed: 0,
                external: 0,
                arrayBuffers: 0,
            }),
            installRuntimeHandlers: () => () => undefined,
        },
    )

    expect(stdoutLines).toContain(
        JSON.stringify({
            type: 'sent',
            eventId: 'sent-1',
            streamId: '77stream',
            channel: 'art',
        }) + '\n',
    )
    expect(stderrLines).toContain(
        JSON.stringify({
            type: 'status',
            state: 'connected',
            streamCount: 1,
        }) + '\n',
    )
    expect(client.stop).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})

test('executeAgentListen accepts NDJSON stdin with replyTo, threadId, and requestId', async () => {
    const sessionKeystore = makeAgentKeystore()
    const stdoutLines: string[] = []
    const abortController = new AbortController()
    const release = mock(async () => undefined)
    const stdinStream = new PassThrough()
    const client = new FakeAgentClient()

    client.initializeUser = mock(async () => {
        queueMicrotask(() => {
            client.emit('streamSyncActive', true)
        })
    })
    client.sendChannelMessage_Text = mock(async (_streamId: string, payload) => {
        expect(payload).toEqual({
            replyId: 'event-0',
            replyPreview: '\u{1F648}',
            threadId: 'thread-0',
            threadPreview: '\u{1F649}',
            content: {
                body: 'hello structured stdin',
                mentions: [],
                attachments: [],
            },
        })
        queueMicrotask(() => abortController.abort())
        return { eventId: 'sent-2' }
    })

    stdinStream.write(
        `${JSON.stringify({
            channel: 'art',
            content: 'hello structured stdin',
            replyTo: 'event-0',
            threadId: 'thread-0',
            requestId: 'req-1',
        })}\n`,
    )
    stdinStream.end()

    await executeAgentListen(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            interactive: true,
            password: 'pw',
            heartbeatIntervalSeconds: 0,
            signal: abortController.signal,
        },
        {
            stdinStream,
            withKeystoreLock: async (_path, action) => action(),
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
            claimAgentListenPid: mock(async () => ({
                pidPath: '/tmp/sessions/agent-alice.listen.pid',
                release,
            })),
            decryptSessionPrivateKey: mock(
                async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
            decryptAgentDevice: mock(async () =>
                create(ExportedDeviceSchema, {
                    pickleKey: 'pickle',
                    pickledAccount: new Uint8Array([1]),
                    hybridGroupSessions: [],
                }),
            ),
            createAgentClient: mock(async () => client),
            finalizeAgentSessionKeystore: mock(async (input) => input.baseKeystore),
            writeAgentSession: mock(async () => undefined),
            stdoutWrite: (line) => {
                stdoutLines.push(line)
            },
            stderrWrite: () => undefined,
            now: () => 1_000,
            random: () => 0,
            processMemoryUsage: () => ({
                rss: 0,
                heapTotal: 0,
                heapUsed: 0,
                external: 0,
                arrayBuffers: 0,
            }),
            installRuntimeHandlers: () => () => undefined,
        },
    )

    expect(stdoutLines).toContain(
        JSON.stringify({
            type: 'sent',
            eventId: 'sent-2',
            streamId: '77stream',
            requestId: 'req-1',
        }) + '\n',
    )
    expect(client.stop).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})

test('executeAgentListen emits stdin_reconnecting when interactive stdin messages arrive during reconnect', async () => {
    const sessionKeystore = makeAgentKeystore()
    const stderrLines: string[] = []
    const abortController = new AbortController()
    const release = mock(async () => undefined)
    const stdinStream = new PassThrough()
    const firstClient = new FakeAgentClient()
    const secondClient = new FakeAgentClient()
    let backoffScheduled = false

    firstClient.initializeUser = mock(async () => {
        queueMicrotask(() => {
            firstClient.emit('streamSyncActive', true)
            queueMicrotask(() => {
                firstClient.emit('streamSyncActive', false)
            })
        })
    })

    secondClient.initializeUser = mock(async () => {
        queueMicrotask(() => {
            secondClient.emit('streamSyncActive', true)
            queueMicrotask(() => abortController.abort())
        })
    })

    await executeAgentListen(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            interactive: true,
            password: 'pw',
            heartbeatIntervalSeconds: 0,
            signal: abortController.signal,
        },
        {
            stdinStream,
            withKeystoreLock: async (_path, action) => action(),
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
            claimAgentListenPid: mock(async () => ({
                pidPath: '/tmp/sessions/agent-alice.listen.pid',
                release,
            })),
            decryptSessionPrivateKey: mock(
                async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
            decryptAgentDevice: mock(async () =>
                create(ExportedDeviceSchema, {
                    pickleKey: 'pickle',
                    pickledAccount: new Uint8Array([1]),
                    hybridGroupSessions: [],
                }),
            ),
            createAgentClient: mock(async () => {
                if (!backoffScheduled) {
                    return firstClient
                }
                return secondClient
            }),
            finalizeAgentSessionKeystore: mock(async (input) => input.baseKeystore),
            writeAgentSession: mock(async () => undefined),
            stdoutWrite: () => undefined,
            stderrWrite: (line) => {
                stderrLines.push(line)
            },
            setTimeout: ((callback: () => void) => {
                backoffScheduled = true
                stdinStream.write('hello during reconnect\n')
                stdinStream.end()
                return globalThis.setTimeout(callback, 0)
            }) as typeof setTimeout,
            clearTimeout: globalThis.clearTimeout,
            now: () => 1_000,
            random: () => 0,
            processMemoryUsage: () => ({
                rss: 0,
                heapTotal: 0,
                heapUsed: 0,
                external: 0,
                arrayBuffers: 0,
            }),
            installRuntimeHandlers: () => () => undefined,
        },
    )

    expect(stderrLines).toContain(
        JSON.stringify({
            type: 'stdin_reconnecting',
            message: 'Listener is reconnecting; dropped stdin message.',
            input: 'hello during reconnect',
        }) + '\n',
    )
    expect(
        stderrLines.some(
            (line) =>
                line.includes('"type":"send_error"') && line.includes('hello during reconnect'),
        ),
    ).toBe(false)
    expect(firstClient.stop).toHaveBeenCalledTimes(1)
    expect(secondClient.stop).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})

test('executeAgentListen uses daemon-cached secrets without prompting for password', async () => {
    const sessionKeystore = makeAgentKeystore()
    const abortController = new AbortController()
    const release = mock(async () => undefined)
    const daemonPrivateKey =
        '0x9999999999999999999999999999999999999999999999999999999999999999' as const
    const daemonDevice = create(ExportedDeviceSchema, {
        pickleKey: 'daemon-pickle',
        pickledAccount: new Uint8Array([7]),
        hybridGroupSessions: [],
    })
    const daemonDeviceHex = `0x${Buffer.from(toBinary(ExportedDeviceSchema, daemonDevice)).toString('hex')}`
    const client = new FakeAgentClient()
    client.initializeUser = mock(async () => {
        queueMicrotask(() => {
            client.emit('streamSyncActive', true)
            abortController.abort()
        })
    })
    const resolvePassword = mock(async () => {
        throw new Error('should not prompt for password')
    })
    const decryptSessionPrivateKey = mock(async () => {
        throw new Error('should not decrypt session key')
    })
    const decryptAgentDevice = mock(async () => {
        throw new Error('should not decrypt device')
    })
    const createAgentClient = mock(async () => client)

    await executeAgentListen(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            heartbeatIntervalSeconds: 0,
            signal: abortController.signal,
            resolvePassword,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
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
            claimAgentListenPid: mock(async () => ({
                pidPath: '/tmp/sessions/agent-alice.listen.pid',
                release,
            })),
            getDaemonSessionSecrets: mock(async () => ({
                ok: true,
                result: {
                    name: sessionKeystore.name,
                    privateKey: daemonPrivateKey,
                    address: sessionKeystore.addresses.session,
                    expiresAt: Date.now() + 60_000,
                    encryptionDevice: daemonDeviceHex,
                },
            })),
            decryptSessionPrivateKey,
            decryptAgentDevice,
            createAgentClient,
            finalizeAgentSessionKeystore: mock(async (input) => input.baseKeystore),
            writeAgentSession: mock(async () => undefined),
            stdoutWrite: () => undefined,
            stderrWrite: () => undefined,
            installRuntimeHandlers: () => () => undefined,
        },
    )

    expect(resolvePassword).toHaveBeenCalledTimes(0)
    expect(decryptSessionPrivateKey).toHaveBeenCalledTimes(0)
    expect(decryptAgentDevice).toHaveBeenCalledTimes(0)
    expect(createAgentClient.mock.calls[0]?.[0]).toMatchObject({
        sessionPrivateKey: daemonPrivateKey,
    })
    expect(release).toHaveBeenCalledTimes(1)
})

test('executeAgentListen prompts with daemon-missing-device fallback message', async () => {
    const sessionKeystore = makeAgentKeystore()
    const abortController = new AbortController()
    const release = mock(async () => undefined)
    const client = new FakeAgentClient()
    client.initializeUser = mock(async () => {
        queueMicrotask(() => {
            client.emit('streamSyncActive', true)
            abortController.abort()
        })
    })
    const resolvePassword = mock(async () => 'pw')
    const decryptSessionPrivateKey = mock(
        async () => '0x1111111111111111111111111111111111111111111111111111111111111111',
    )
    const decryptAgentDevice = mock(async () =>
        create(ExportedDeviceSchema, {
            pickleKey: 'pickle',
            pickledAccount: new Uint8Array([1]),
            hybridGroupSessions: [],
        }),
    )

    await executeAgentListen(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
            from: 'alice',
            channel: 'art',
            heartbeatIntervalSeconds: 0,
            signal: abortController.signal,
            resolvePassword,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
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
            claimAgentListenPid: mock(async () => ({
                pidPath: '/tmp/sessions/agent-alice.listen.pid',
                release,
            })),
            getDaemonSessionSecrets: mock(async () => ({
                ok: true,
                result: {
                    name: sessionKeystore.name,
                    privateKey:
                        '0x1111111111111111111111111111111111111111111111111111111111111111',
                    address: sessionKeystore.addresses.session,
                    expiresAt: Date.now() + 60_000,
                },
            })),
            decryptSessionPrivateKey,
            decryptAgentDevice,
            createAgentClient: mock(async () => client),
            finalizeAgentSessionKeystore: mock(async (input) => input.baseKeystore),
            writeAgentSession: mock(async () => undefined),
            stdoutWrite: () => undefined,
            stderrWrite: () => undefined,
            installRuntimeHandlers: () => () => undefined,
        },
    )

    expect(resolvePassword).toHaveBeenCalledTimes(1)
    expect(resolvePassword.mock.calls[0]?.[0]).toContain('Encryption device not cached')
    expect(decryptSessionPrivateKey).toHaveBeenCalledTimes(1)
    expect(decryptAgentDevice).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})
