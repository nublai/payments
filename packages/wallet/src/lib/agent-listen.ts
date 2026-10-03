import readline from 'node:readline'
import { z } from 'incur'
import { fromBinary } from '@bufbuild/protobuf'
import { ExportedDeviceSchema, MembershipOp, type SnapshotCaseType } from '@towns-labs/proto'
import { getAddress, type Address, type Hex } from 'viem'
import { makeUserStreamIdForAddress, parseAgentName, parseChannelName } from './agent-identifiers'
import {
    decryptAgentDevice,
    decryptSessionPrivateKey,
    readCompleteAgentSession,
    writeAgentSession,
    finalizeAgentSessionKeystore,
} from './agent-sessions'
import {
    claimAgentListenPid,
    defaultCreateAgentClient,
    isErrnoNotFound,
    type AgentClient,
} from './agent-runtime'
import { withKeystoreLock, type AgentSessionKeystoreV2 } from './keystore'
import { resolveKeystorePath } from './account-create'
import type { ChainName, EnvName } from './network-config'
import { SessionDaemonClient, type SessionDaemonRpcResponse } from './session-daemon-client'
import { DAEMON_ERROR_CODES, type GetSessionSecretsResult } from './session-daemon-protocol'

const CHANNEL_MESSAGE_KIND = 'm.channel.message'
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30
const DEFAULT_DEVICE_EXPORT_INTERVAL_MS = 60_000
const DEFAULT_RESTART_INTERVAL_MS = 4 * 60 * 60 * 1000
const DEFAULT_MAX_HEAP_MB = 256

type AgentListenErrorCode =
    | 'AGENT_NOT_FOUND'
    | 'INVALID_CHANNEL'
    | 'CHANNEL_NOT_FOUND'
    | 'LISTEN_ACTIVE'
    | 'PASSWORD_REQUIRED'
    | 'SDK_ERROR'
    | 'UNKNOWN'

export class AgentListenError extends Error {
    code: AgentListenErrorCode
    cause?: unknown

    constructor(code: AgentListenErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AgentListenError'
        this.code = code
        this.cause = options?.cause
    }
}

type JsonRecord = Record<string, unknown>

type ListenControl = {
    requestStop: (input: { exitCode: number; reason: string }) => void
    forceExit: (code: number) => never | void
}

type AgentListenDeps = {
    withKeystoreLock: typeof withKeystoreLock
    readCompleteAgentSession: typeof readCompleteAgentSession
    claimAgentListenPid: typeof claimAgentListenPid
    decryptSessionPrivateKey: typeof decryptSessionPrivateKey
    decryptAgentDevice: typeof decryptAgentDevice
    createAgentClient: typeof defaultCreateAgentClient
    finalizeAgentSessionKeystore: typeof finalizeAgentSessionKeystore
    writeAgentSession: typeof writeAgentSession
    makeUserStreamIdForAddress: typeof makeUserStreamIdForAddress
    getDaemonSessionSecrets: (
        sessionName: string,
    ) => Promise<SessionDaemonRpcResponse<GetSessionSecretsResult>>
    stdinStream: NodeJS.ReadableStream
    stdoutWrite: (line: string) => void
    stderrWrite: (line: string) => void
    now: () => number
    random: () => number
    processMemoryUsage: () => NodeJS.MemoryUsage
    setInterval: typeof globalThis.setInterval
    clearInterval: typeof globalThis.clearInterval
    setTimeout: typeof globalThis.setTimeout
    clearTimeout: typeof globalThis.clearTimeout
    installRuntimeHandlers: (control: ListenControl) => () => void
}

type ResolvedListenSecrets = {
    sessionPrivateKey: Hex
    exportedDevice: Awaited<ReturnType<typeof decryptAgentDevice>>
}

type SessionOutcome =
    | { kind: 'shutdown' }
    | { kind: 'reconnect'; reason: string }
    | { kind: 'restart'; reason: string; heapUsedMB?: number }

type ListenSessionResult = {
    outcome: SessionOutcome
    sessionKeystore: AgentSessionKeystoreV2
}

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (reason?: unknown) => void
}

type TimelineEventLike = {
    eventId: string
    createdAtEpochMs: number
    confirmedAtEpochMs?: number
    sender: {
        id: string
    }
    content?: {
        kind?: string
        body?: string
        threadId?: string
        replyId?: string
    }
}

const StdinMessageSchema = z.object({
    channel: z.string().min(1),
    content: z.string().min(1),
    replyTo: z.string().optional(),
    threadId: z.string().optional(),
    requestId: z.string().optional(),
})

type ParsedStdinLine = {
    streamId: string
    content: string
    replyTo?: string
    threadId?: string
    requestId?: string
}

function makeDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve
        reject = innerReject
    })
    return { promise, resolve, reject }
}

class FatalListenSessionError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'FatalListenSessionError'
        if (options?.cause !== undefined) {
            ;(this as { cause?: unknown }).cause = options.cause
        }
    }
}

class ListenerReconnectingError extends Error {
    constructor() {
        super('Listener is reconnecting; dropped stdin message.')
        this.name = 'ListenerReconnectingError'
    }
}

function countJoinedGdms(
    streamMemberships: Record<string, { op?: MembershipOp } | undefined>,
): number {
    return Object.entries(streamMemberships).filter(
        ([streamId, membership]) =>
            streamId.startsWith('77') &&
            membership !== undefined &&
            (membership.op === MembershipOp.SO_JOIN || membership.op === MembershipOp.SO_INVITE),
    ).length
}

function buildMessageLine(input: {
    streamId: string
    event: TimelineEventLike
}): JsonRecord | undefined {
    if (input.event.content?.kind !== CHANNEL_MESSAGE_KIND) {
        return undefined
    }
    if (typeof input.event.content.body !== 'string') {
        return undefined
    }

    const timestampMs = input.event.confirmedAtEpochMs ?? input.event.createdAtEpochMs
    return {
        type: 'message',
        streamId: input.streamId,
        senderId: input.event.sender.id,
        eventId: input.event.eventId,
        timestamp: Math.floor(timestampMs / 1000),
        content: input.event.content.body,
        ...(input.event.content.replyId ? { replyTo: input.event.content.replyId } : {}),
        ...(input.event.content.threadId ? { threadId: input.event.content.threadId } : {}),
    }
}

function buildSentConfirmationLine(input: {
    eventId: string
    streamId: string
    channel?: string
    requestId?: string
}): string {
    return (
        JSON.stringify({
            type: 'sent',
            eventId: input.eventId,
            streamId: input.streamId,
            ...(input.channel ? { channel: input.channel } : {}),
            ...(input.requestId ? { requestId: input.requestId } : {}),
        }) + '\n'
    )
}

function parseStdinLine(
    line: string,
    channelName: string | undefined,
    directStreamId: string | undefined,
    resolveStreamId: (name: string) => string | undefined,
): ParsedStdinLine {
    if (channelName) {
        const streamId = resolveStreamId(channelName)
        if (!streamId) {
            throw new Error(`Channel "${channelName}" not found`)
        }
        return {
            streamId,
            content: line,
        }
    }

    if (directStreamId) {
        return {
            streamId: directStreamId,
            content: line,
        }
    }

    const parsed = StdinMessageSchema.parse(JSON.parse(line))
    const streamId = resolveStreamId(parsed.channel)
    if (!streamId) {
        throw new Error(`Channel "${parsed.channel}" not found`)
    }
    return {
        streamId,
        content: parsed.content,
        replyTo: parsed.replyTo,
        threadId: parsed.threadId,
        requestId: parsed.requestId,
    }
}

function parseExportedDeviceFromHex(hex: Hex): Awaited<ReturnType<typeof decryptAgentDevice>> {
    if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
        throw new Error('Invalid daemon encryption device payload')
    }
    const binary = Buffer.from(hex.slice(2), 'hex')
    try {
        return fromBinary(ExportedDeviceSchema, binary)
    } catch {
        throw new Error('Invalid daemon encryption device payload')
    }
}

async function resolveListenSecrets(input: {
    deps: Pick<
        AgentListenDeps,
        'decryptSessionPrivateKey' | 'decryptAgentDevice' | 'getDaemonSessionSecrets'
    >
    sessionKeystore: AgentSessionKeystoreV2
    getPassword: (prompt: string) => Promise<string>
    useDaemon: boolean
}): Promise<ResolvedListenSecrets> {
    const sessionName = input.sessionKeystore.name
    const stored = input.useDaemon ? await input.deps.getDaemonSessionSecrets(sessionName) : null

    let daemonDeviceParseFailed = false
    if (stored?.ok && stored.result.encryptionDevice) {
        try {
            const exportedDevice = parseExportedDeviceFromHex(stored.result.encryptionDevice)
            return {
                sessionPrivateKey: stored.result.privateKey,
                exportedDevice,
            }
        } catch {
            daemonDeviceParseFailed = true
        }
    }

    let prompt = 'Enter your keystore password to listen as this agent:'
    if (daemonDeviceParseFailed) {
        prompt =
            'Daemon encryption device invalid or corrupted. Enter your keystore password to listen as this agent:'
    } else if (stored === null && input.useDaemon) {
        prompt = 'Session daemon unavailable. Enter your keystore password to listen as this agent:'
    } else if (
        stored !== null &&
        !stored.ok &&
        stored.error.code === DAEMON_ERROR_CODES.INVALID_RESPONSE
    ) {
        prompt =
            'Daemon returned invalid data. Enter your keystore password to listen as this agent:'
    } else if (
        stored !== null &&
        !stored.ok &&
        stored.error.code === DAEMON_ERROR_CODES.SESSION_NOT_FOUND
    ) {
        prompt = `Session not in daemon. Enter password (or run: tw daemon unlock ${sessionName} --device):`
    } else if (
        stored !== null &&
        !stored.ok &&
        stored.error.code === DAEMON_ERROR_CODES.SESSION_EXPIRED
    ) {
        prompt = 'Session expired in daemon. Enter password:'
    } else if (stored !== null && stored.ok && !stored.result.encryptionDevice) {
        prompt = `Encryption device not cached. Enter password (next time use: tw daemon unlock ${sessionName} --device):`
    }

    const password = await input.getPassword(prompt)
    return {
        sessionPrivateKey: await input.deps.decryptSessionPrivateKey(
            input.sessionKeystore,
            password,
        ),
        exportedDevice: await input.deps.decryptAgentDevice(input.sessionKeystore, password),
    }
}

function sleepWithStop(
    ms: number,
    deps: Pick<AgentListenDeps, 'setTimeout' | 'clearTimeout'>,
    stopPromise: Promise<void>,
): Promise<void> {
    return new Promise<void>((resolve) => {
        const timeout = deps.setTimeout(() => resolve(), ms)
        void stopPromise.finally(() => {
            deps.clearTimeout(timeout)
            resolve()
        })
    })
}

function computeBackoffMs(attempt: number, random: () => number): number {
    const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1))
    return Math.round(base * (1 + random() * 0.1))
}

function defaultInstallRuntimeHandlers(control: ListenControl): () => void {
    let sigintCount = 0

    const onSigint = () => {
        sigintCount += 1
        if (sigintCount >= 2) {
            control.forceExit(130)
            return
        }
        control.requestStop({
            exitCode: 130,
            reason: 'sigint',
        })
    }

    const onSigterm = () => {
        control.requestStop({
            exitCode: 143,
            reason: 'sigterm',
        })
    }

    const onStdoutError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') {
            control.requestStop({
                exitCode: 0,
                reason: 'epipe',
            })
        }
    }

    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
    process.stdout.on('error', onStdoutError)

    return () => {
        process.off('SIGINT', onSigint)
        process.off('SIGTERM', onSigterm)
        process.stdout.off('error', onStdoutError)
    }
}

function getDefaultDeps(): AgentListenDeps {
    return {
        withKeystoreLock,
        readCompleteAgentSession,
        claimAgentListenPid,
        decryptSessionPrivateKey,
        decryptAgentDevice,
        createAgentClient: defaultCreateAgentClient,
        finalizeAgentSessionKeystore,
        writeAgentSession,
        makeUserStreamIdForAddress,
        getDaemonSessionSecrets: (sessionName) => {
            const client = new SessionDaemonClient()
            return client.getSessionSecrets(sessionName)
        },
        stdinStream: process.stdin,
        stdoutWrite: () => undefined,
        stderrWrite: () => undefined,
        now: () => Date.now(),
        random: () => Math.random(),
        processMemoryUsage: () => process.memoryUsage(),
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        installRuntimeHandlers: defaultInstallRuntimeHandlers,
    }
}

async function refreshAgentSessionKeystore(input: {
    deps: Pick<AgentListenDeps, 'readCompleteAgentSession' | 'stderrWrite'>
    env: EnvName
    name?: string
    keystorePath?: string
    agentName: string
    fallback: AgentSessionKeystoreV2
}): Promise<AgentSessionKeystoreV2> {
    try {
        const refreshed = await input.deps.readCompleteAgentSession({
            env: input.env,
            name: input.name,
            keystorePath: input.keystorePath,
            agentName: input.agentName,
        })
        return refreshed.sessionKeystore
    } catch (error) {
        input.deps.stderrWrite(
            `${JSON.stringify({
                type: 'warning',
                message: 'Failed to refresh session keystore, using cached version',
                reason: error instanceof Error ? error.message : 'unknown_refresh_session_error',
            })}\n`,
        )
        return input.fallback
    }
}

async function persistAgentDevice(input: {
    deps: AgentListenDeps
    rootKeystorePath: string
    sessionPath: string
    password: string
    sessionKeystore: AgentSessionKeystoreV2
    client: AgentClient
}): Promise<AgentSessionKeystoreV2> {
    const exportedDevice = await input.client.cryptoBackend?.exportDevice()
    if (!exportedDevice) {
        throw new Error('Failed to export encryption device during listen')
    }

    const updated = await input.deps.finalizeAgentSessionKeystore({
        baseKeystore: input.sessionKeystore,
        password: input.password,
        exportedDevice,
        namedChannels: input.sessionKeystore.namedChannels,
    })

    await input.deps.withKeystoreLock(input.rootKeystorePath, async () => {
        await input.deps.writeAgentSession(input.sessionPath, updated)
    })

    return updated
}

async function startStdinReader(input: {
    deps: Pick<AgentListenDeps, 'stdinStream' | 'stdoutWrite' | 'stderrWrite' | 'setTimeout'>
    getClient: () => AgentClient
    channelName: string | undefined
    directStreamId: string | undefined
    resolveStreamId: (name: string) => string | undefined
}): Promise<void> {
    const rl = readline.createInterface({
        input: input.deps.stdinStream,
        terminal: false,
    })
    let consecutiveFailures = 0

    for await (const line of rl) {
        if (line.trim() === '') {
            continue
        }

        let parsedLine: ParsedStdinLine | undefined
        try {
            parsedLine = parseStdinLine(
                line,
                input.channelName,
                input.directStreamId,
                input.resolveStreamId,
            )
            const { streamId, content, replyTo, threadId, requestId } = parsedLine
            const client = input.getClient()
            const result =
                replyTo || threadId
                    ? await client.sendChannelMessage_Text(streamId, {
                          ...(replyTo ? { replyId: replyTo, replyPreview: '\u{1F648}' } : {}),
                          ...(threadId ? { threadId, threadPreview: '\u{1F649}' } : {}),
                          content: {
                              body: content,
                              mentions: [],
                              attachments: [],
                          },
                      })
                    : await client.sendMessage(streamId, content)

            input.deps.stdoutWrite(
                buildSentConfirmationLine({
                    eventId: result.eventId,
                    streamId,
                    channel: input.channelName,
                    requestId,
                }),
            )
            consecutiveFailures = 0
        } catch (error) {
            if (error instanceof ListenerReconnectingError) {
                input.deps.stderrWrite(
                    `${JSON.stringify({
                        type: 'stdin_reconnecting',
                        message: error.message,
                        input: line.slice(0, 200),
                        ...(parsedLine?.requestId ? { requestId: parsedLine.requestId } : {}),
                    })}\n`,
                )
                continue
            }
            consecutiveFailures += 1
            input.deps.stderrWrite(
                `${JSON.stringify({
                    type: 'send_error',
                    message: error instanceof Error ? error.message : 'Unknown error',
                    input: line.slice(0, 200),
                    consecutiveFailures,
                })}\n`,
            )
            if (consecutiveFailures >= 10) {
                input.deps.stderrWrite(
                    `${JSON.stringify({
                        type: 'stdin_fatal',
                        message: '10 consecutive send failures - stdin reader pausing for 5s',
                    })}\n`,
                )
                await new Promise<void>((resolve) => {
                    input.deps.setTimeout(() => resolve(), 5_000)
                })
                consecutiveFailures = 0
            }
        }
    }
}

export async function executeAgentListen(
    options: {
        env: EnvName
        chain?: ChainName
        name?: string
        keystorePath?: string
        from: string
        password?: string
        resolvePassword?: (prompt: string) => Promise<string>
        channel?: string
        streamId?: string
        interactive?: boolean
        heartbeatIntervalSeconds?: number
        signal?: AbortSignal
    },
    depsArg?: Partial<AgentListenDeps>,
): Promise<void> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const agentName = parseAgentName(options.from)
    let channelName: string | undefined
    if (options.channel !== undefined) {
        try {
            channelName = parseChannelName(options.channel)
        } catch (error) {
            throw new AgentListenError(
                'INVALID_CHANNEL',
                error instanceof Error ? error.message : 'Invalid channel name.',
                { cause: error },
            )
        }
    }
    const rootKeystorePath = resolveKeystorePath({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
    })
    const heartbeatIntervalSeconds =
        options.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS
    const heartbeatIntervalMs = Math.max(0, heartbeatIntervalSeconds) * 1000

    let session
    try {
        session = await deps.readCompleteAgentSession({
            env: options.env,
            name: options.name,
            keystorePath: options.keystorePath,
            agentName,
        })
    } catch (error) {
        if (isErrnoNotFound(error)) {
            throw new AgentListenError('AGENT_NOT_FOUND', `Agent not found: ${agentName}`, {
                cause: error,
            })
        }
        throw error
    }

    let claim
    try {
        claim = await deps.claimAgentListenPid(session.sessionPath)
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'EEXIST'
        ) {
            throw new AgentListenError(
                'LISTEN_ACTIVE',
                `listen is already running for agent "${agentName}".`,
                { cause: error },
            )
        }
        throw error
    }

    let stopRequested = false
    let stopExitCode = 0
    const stopWaiters = new Set<() => void>()
    const requestStop = (input: { exitCode: number; reason: string }) => {
        if (stopRequested) {
            return
        }
        stopRequested = true
        stopExitCode = input.exitCode
        for (const waiter of stopWaiters) {
            waiter()
        }
        stopWaiters.clear()
    }
    const waitForStop = () =>
        new Promise<void>((resolve) => {
            if (stopRequested) {
                resolve()
                return
            }
            stopWaiters.add(resolve)
        })

    const cleanupRuntimeHandlers = deps.installRuntimeHandlers({
        requestStop,
        forceExit: (code) => {
            process.exit(code)
        },
    })

    const onAbort = () => {
        requestStop({ exitCode: 0, reason: 'abort' })
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    let currentSessionKeystore = session.sessionKeystore
    let reconnectAttempt = 0
    const listenerStartedAtMs = deps.now()
    let currentClient: AgentClient | undefined
    let stdinReaderStarted = false
    let cachedPassword = options.password

    try {
        const resolvedStreamId =
            channelName !== undefined
                ? currentSessionKeystore.namedChannels?.[channelName]?.streamId
                : options.streamId
        if (channelName !== undefined && !resolvedStreamId) {
            throw new AgentListenError(
                'CHANNEL_NOT_FOUND',
                `Channel not found for agent "${agentName}": ${channelName}`,
            )
        }

        const getPassword = async (prompt: string): Promise<string> => {
            if (cachedPassword !== undefined) {
                return cachedPassword
            }
            if (!options.resolvePassword) {
                throw new AgentListenError(
                    'PASSWORD_REQUIRED',
                    'Password required. Set TW_PASSWORD, use --password-stdin, or run in interactive mode.',
                )
            }
            cachedPassword = await options.resolvePassword(prompt)
            return cachedPassword
        }

        while (!stopRequested) {
            const { sessionPrivateKey, exportedDevice } = await resolveListenSecrets({
                deps,
                sessionKeystore: currentSessionKeystore,
                getPassword,
                useDaemon: options.password === undefined,
            })
            const client = await deps.createAgentClient({
                env: options.env,
                sessionPrivateKey,
            })
            currentClient = client

            try {
                const { outcome, sessionKeystore } = await runListenSession({
                    deps,
                    client,
                    agentName,
                    agentAddress: getAddress(currentSessionKeystore.addresses.session),
                    sessionKeystore: currentSessionKeystore,
                    sessionPath: session.sessionPath,
                    rootKeystorePath,
                    password: cachedPassword !== undefined ? cachedPassword : options.password,
                    exportedDevice,
                    streamId: resolvedStreamId,
                    heartbeatIntervalMs,
                    listenerStartedAtMs,
                    waitForStop,
                    isStopRequested: () => stopRequested,
                    onReady: () => {
                        if (options.interactive && !stdinReaderStarted) {
                            stdinReaderStarted = true
                            void startStdinReader({
                                deps,
                                getClient: () => {
                                    if (!currentClient) {
                                        throw new ListenerReconnectingError()
                                    }
                                    return currentClient
                                },
                                channelName,
                                directStreamId: resolvedStreamId,
                                resolveStreamId: (name) =>
                                    currentSessionKeystore.namedChannels?.[name]?.streamId,
                            }).catch((error) => {
                                deps.stderrWrite(
                                    `${JSON.stringify({
                                        type: 'stdin_error',
                                        message:
                                            error instanceof Error
                                                ? error.message
                                                : 'Unknown error',
                                    })}\n`,
                                )
                            })
                        }
                    },
                })
                currentSessionKeystore = sessionKeystore

                if (cachedPassword !== undefined) {
                    currentSessionKeystore = await persistAgentDevice({
                        deps,
                        rootKeystorePath,
                        sessionPath: session.sessionPath,
                        password: cachedPassword,
                        sessionKeystore: currentSessionKeystore,
                        client,
                    })
                }

                await client.stop().catch((err) => {
                    deps.stderrWrite(
                        `${JSON.stringify({
                            type: 'warning',
                            message: 'Listen client stop failed',
                            reason: err instanceof Error ? err.message : String(err),
                        })}\n`,
                    )
                })
                currentClient = undefined

                if (outcome.kind === 'shutdown') {
                    break
                }

                if (outcome.kind === 'restart') {
                    deps.stderrWrite(
                        `${JSON.stringify({
                            type: 'restart',
                            reason: outcome.reason,
                            ...(outcome.heapUsedMB !== undefined
                                ? { heapUsedMB: outcome.heapUsedMB }
                                : undefined),
                        })}\n`,
                    )
                    reconnectAttempt = 0
                    continue
                }

                reconnectAttempt += 1
                const backoffMs = computeBackoffMs(reconnectAttempt, deps.random)
                deps.stderrWrite(
                    `${JSON.stringify({
                        type: 'reconnect',
                        attempt: reconnectAttempt,
                        backoffMs,
                        reason: outcome.reason,
                    })}\n`,
                )
                await sleepWithStop(backoffMs, deps, waitForStop())
            } catch (error) {
                await client.stop().catch((err) => {
                    deps.stderrWrite(
                        `${JSON.stringify({
                            type: 'warning',
                            message: 'Listen client stop failed',
                            reason: err instanceof Error ? err.message : String(err),
                        })}\n`,
                    )
                })
                currentClient = undefined
                if (stopRequested) {
                    break
                }
                if (error instanceof FatalListenSessionError) {
                    throw error
                }

                currentSessionKeystore = await refreshAgentSessionKeystore({
                    deps,
                    env: options.env,
                    name: options.name,
                    keystorePath: options.keystorePath,
                    agentName,
                    fallback: currentSessionKeystore,
                })

                reconnectAttempt += 1
                const backoffMs = computeBackoffMs(reconnectAttempt, deps.random)
                deps.stderrWrite(
                    `${JSON.stringify({
                        type: 'reconnect',
                        attempt: reconnectAttempt,
                        backoffMs,
                        reason: error instanceof Error ? error.message : 'listen_session_failed',
                    })}\n`,
                )
                await sleepWithStop(backoffMs, deps, waitForStop())
            }
        }
    } catch (error) {
        if (error instanceof AgentListenError) {
            throw error
        }
        throw new AgentListenError(
            'SDK_ERROR',
            error instanceof Error ? error.message : 'Agent listen failed.',
            { cause: error },
        )
    } finally {
        options.signal?.removeEventListener('abort', onAbort)
        cleanupRuntimeHandlers()
        try {
            await claim.release()
        } catch (error) {
            deps.stderrWrite(
                `${JSON.stringify({
                    type: 'warning',
                    message: 'Failed to release listen pid file',
                    reason: error instanceof Error ? error.message : 'pid_release_failed',
                })}\n`,
            )
        }
        if (stopRequested) {
            process.exitCode = stopExitCode
        }
    }
}

async function runListenSession(input: {
    deps: AgentListenDeps
    client: AgentClient
    agentName: string
    agentAddress: Address
    sessionKeystore: AgentSessionKeystoreV2
    sessionPath: string
    rootKeystorePath: string
    /** When undefined (e.g. daemon-only secrets), persist is not run. */
    password?: string
    exportedDevice: Awaited<ReturnType<typeof decryptAgentDevice>>
    streamId?: string
    heartbeatIntervalMs: number
    listenerStartedAtMs: number
    waitForStop: () => Promise<void>
    isStopRequested: () => boolean
    onReady?: () => void
}): Promise<ListenSessionResult> {
    const outcome = makeDeferred<SessionOutcome>()
    let currentSessionKeystore = input.sessionKeystore
    let settled = false
    let syncActiveSeen = false
    let consecutivePersistFailures = 0
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    let persistTimer: ReturnType<typeof setInterval> | undefined
    let persistInFlight: Promise<void> | undefined
    let restartTimer: ReturnType<typeof setInterval> | undefined

    const resolveOutcome = (value: SessionOutcome) => {
        if (settled) {
            return
        }
        settled = true
        outcome.resolve(value)
    }

    const rejectOutcome = (error: unknown) => {
        if (settled) {
            return
        }
        settled = true
        outcome.reject(error)
    }

    const persist = async () => {
        if (input.password === undefined) {
            return
        }
        currentSessionKeystore = await persistAgentDevice({
            deps: input.deps,
            rootKeystorePath: input.rootKeystorePath,
            sessionPath: input.sessionPath,
            password: input.password,
            sessionKeystore: currentSessionKeystore,
            client: input.client,
        })
        consecutivePersistFailures = 0
    }

    const handlePersistFailure = (error: unknown) => {
        consecutivePersistFailures += 1
        if (input.isStopRequested()) {
            return
        }
        if (consecutivePersistFailures >= 3) {
            rejectOutcome(
                new FatalListenSessionError(
                    error instanceof Error
                        ? `Failed to persist agent device state after ${consecutivePersistFailures} attempts: ${error.message}`
                        : `Failed to persist agent device state after ${consecutivePersistFailures} attempts.`,
                    { cause: error },
                ),
            )
            return
        }
        input.deps.stderrWrite(
            `${JSON.stringify({
                type: 'warning',
                message: 'Failed to persist agent device state',
                attempt: consecutivePersistFailures,
                reason: error instanceof Error ? error.message : 'persist_failed',
            })}\n`,
        )
    }

    const queuePersist = (): Promise<void> => {
        if (persistInFlight) {
            return persistInFlight
        }

        const pendingPersist = persist()
            .catch((error) => {
                handlePersistFailure(error)
            })
            .finally(() => {
                if (persistInFlight === pendingPersist) {
                    persistInFlight = undefined
                }
            })
        persistInFlight = pendingPersist
        return pendingPersist
    }

    const onEventDecrypted = (
        streamId: string,
        _contentKind: SnapshotCaseType,
        event: TimelineEventLike,
    ): void => {
        if (input.streamId && streamId !== input.streamId) {
            return
        }

        const timestampMs = event.confirmedAtEpochMs ?? event.createdAtEpochMs
        if (timestampMs < input.listenerStartedAtMs) {
            return
        }

        const line = buildMessageLine({ streamId, event })
        if (!line) {
            return
        }
        input.deps.stdoutWrite(`${JSON.stringify(line)}\n`)
    }

    const onStreamSyncActive = (active: boolean) => {
        if (active) {
            syncActiveSeen = true
            void input.client
                .getStream(input.deps.makeUserStreamIdForAddress(input.agentAddress))
                .then((userStream) => {
                    input.deps.stderrWrite(
                        `${JSON.stringify({
                            type: 'status',
                            state: 'connected',
                            streamCount: countJoinedGdms(userStream.userContent.streamMemberships),
                        })}\n`,
                    )
                })
                .catch((error) => {
                    input.deps.stderrWrite(
                        `${JSON.stringify({
                            type: 'warning',
                            message: 'Failed to load user stream for status update',
                            reason: error instanceof Error ? error.message : 'status_failed',
                        })}\n`,
                    )
                })
            return
        }

        if (syncActiveSeen && !input.isStopRequested()) {
            resolveOutcome({
                kind: 'reconnect',
                reason: 'sync_inactive',
            })
        }
    }

    try {
        input.client.on('eventDecrypted', onEventDecrypted)
        input.client.on('streamSyncActive', onStreamSyncActive)

        await input.client.initializeUser({
            encryptionDeviceInit: {
                fromExportedDevice: input.exportedDevice,
            },
        })
        input.onReady?.()

        if (input.heartbeatIntervalMs > 0) {
            heartbeatTimer = input.deps.setInterval(() => {
                input.deps.stdoutWrite(
                    `${JSON.stringify({
                        type: 'heartbeat',
                        timestamp: Math.floor(input.deps.now() / 1000),
                    })}\n`,
                )
            }, input.heartbeatIntervalMs)
        }

        if (input.password !== undefined) {
            persistTimer = input.deps.setInterval(() => {
                void queuePersist()
            }, DEFAULT_DEVICE_EXPORT_INTERVAL_MS)
        }

        const sessionStartedAtMs = input.deps.now()
        restartTimer = input.deps.setInterval(() => {
            const heapUsedMB = Math.round(input.deps.processMemoryUsage().heapUsed / (1024 * 1024))
            if (heapUsedMB >= DEFAULT_MAX_HEAP_MB) {
                resolveOutcome({
                    kind: 'restart',
                    reason: 'heap_limit',
                    heapUsedMB,
                })
                return
            }

            if (input.deps.now() - sessionStartedAtMs >= DEFAULT_RESTART_INTERVAL_MS) {
                resolveOutcome({
                    kind: 'restart',
                    reason: 'time_limit',
                })
            }
        }, 30_000)

        void input.waitForStop().then(() => {
            resolveOutcome({ kind: 'shutdown' })
        })

        const settledOutcome = await outcome.promise
        await persistInFlight

        return {
            outcome: settledOutcome,
            sessionKeystore: currentSessionKeystore,
        }
    } finally {
        if (heartbeatTimer) {
            input.deps.clearInterval(heartbeatTimer)
        }
        if (persistTimer) {
            input.deps.clearInterval(persistTimer)
        }
        if (restartTimer) {
            input.deps.clearInterval(restartTimer)
        }
        input.client.off('eventDecrypted', onEventDecrypted)
        input.client.off('streamSyncActive', onStreamSyncActive)
    }
}
