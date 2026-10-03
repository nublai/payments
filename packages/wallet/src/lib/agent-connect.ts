import { z } from 'incur'
import { getAddress, type Address } from 'viem'
import { resolveKeystorePath } from './account-create'
import {
    makeAgentChannelRegistryKey,
    readAgentChannelRegistry,
    writeAgentChannelRegistry,
} from './agent-channel-registry'
import {
    generateChannelSecret,
    getStreamMemberSetKey,
    hashChannelSecret,
    makeChannelSecretTopic,
    normalizeChannelSecret,
    parseAgentName,
    parseChannelName,
} from './agent-identifiers'
import {
    decryptAgentDevice,
    decryptSessionPrivateKey,
    finalizeAgentSessionKeystore,
    readCompleteAgentSession,
    resolveAgentTargetAddresses,
    writeAgentSession,
    type AgentNamedChannelRecord,
} from './agent-sessions'
import { checkAgentListenPid, defaultCreateAgentClient, isErrnoNotFound } from './agent-runtime'
import { withKeystoreLock } from './keystore'
import type { ChainName, EnvName } from './network-config'

type AgentConnectErrorCode =
    | 'AGENT_NOT_FOUND'
    | 'INVALID_CHANNEL'
    | 'LISTEN_ACTIVE'
    | 'TARGET_NOT_FOUND'
    | 'TOO_MANY_MEMBERS'
    | 'CHANNEL_CONFLICT'
    | 'CHANNEL_SECRET_MISMATCH'
    | 'SDK_ERROR'
    | 'UNKNOWN'

export class AgentConnectError extends Error {
    code: AgentConnectErrorCode
    cause?: unknown

    constructor(code: AgentConnectErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AgentConnectError'
        this.code = code
        this.cause = options?.cause
    }
}

export type AgentConnectResult = {
    type: 'agent_connect'
    status: 'complete'
    channel: string
    streamId: string
    from: {
        name: string
        address: Address
    }
    to: Address[]
    memberCount: number
    secret?: string
    joinToken?: string
}

const JoinTokenSchema = z.object({
    v: z.literal(1),
    channel: z.string().min(1),
    streamId: z.string().min(1),
    secret: z.string().min(1),
})

export type JoinToken = z.infer<typeof JoinTokenSchema>

export function encodeJoinToken(token: JoinToken): string {
    return Buffer.from(JSON.stringify(token)).toString('base64url')
}

export function decodeJoinToken(encoded: string): JoinToken {
    try {
        const json = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
        return JoinTokenSchema.parse(json)
    } catch (error) {
        if (error instanceof z.ZodError) {
            throw new Error(
                `Invalid join token: ${error.issues.map((issue) => issue.message).join(', ')}`,
            )
        }
        throw new Error('Invalid join token: malformed base64url or JSON')
    }
}

function dedupeTargetAddresses(sessionAddress: Address, targetAddresses: Address[]): Address[] {
    const seen = new Set<string>()
    const deduped: Address[] = []

    for (const address of targetAddresses) {
        const normalized = getAddress(address)
        const lower = normalized.toLowerCase()
        if (lower === sessionAddress.toLowerCase() || seen.has(lower)) {
            continue
        }
        seen.add(lower)
        deduped.push(normalized)
    }

    return deduped
}

type AgentConnectDeps = {
    withKeystoreLock: typeof withKeystoreLock
    readCompleteAgentSession: typeof readCompleteAgentSession
    resolveAgentTargetAddresses: typeof resolveAgentTargetAddresses
    checkAgentListenPid: typeof checkAgentListenPid
    decryptSessionPrivateKey: typeof decryptSessionPrivateKey
    decryptAgentDevice: typeof decryptAgentDevice
    createAgentClient: typeof defaultCreateAgentClient
    finalizeAgentSessionKeystore: typeof finalizeAgentSessionKeystore
    generateChannelSecret: typeof generateChannelSecret
    normalizeChannelSecret: typeof normalizeChannelSecret
    hashChannelSecret: typeof hashChannelSecret
    getStreamMemberSetKey: typeof getStreamMemberSetKey
    makeChannelSecretTopic: typeof makeChannelSecretTopic
    makeAgentChannelRegistryKey: typeof makeAgentChannelRegistryKey
    readAgentChannelRegistry: typeof readAgentChannelRegistry
    writeAgentChannelRegistry: typeof writeAgentChannelRegistry
    parseChannelName: typeof parseChannelName
    writeAgentSession: typeof writeAgentSession
}

const GRPC_NOT_FOUND = 5

function getDefaultDeps(): AgentConnectDeps {
    return {
        withKeystoreLock,
        readCompleteAgentSession,
        resolveAgentTargetAddresses,
        checkAgentListenPid,
        decryptSessionPrivateKey,
        decryptAgentDevice,
        createAgentClient: defaultCreateAgentClient,
        finalizeAgentSessionKeystore,
        generateChannelSecret,
        normalizeChannelSecret,
        hashChannelSecret,
        getStreamMemberSetKey,
        makeChannelSecretTopic,
        makeAgentChannelRegistryKey,
        readAgentChannelRegistry,
        writeAgentChannelRegistry,
        parseChannelName,
        writeAgentSession,
    }
}

function isMissingStreamError(error: unknown): boolean {
    if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === GRPC_NOT_FOUND
    ) {
        return true
    }
    return false
}

function buildConnectResult(input: {
    agentName: string
    channelName: string
    sessionAddress: Address
    streamId: string
    targetAddresses: Address[]
    memberCount: number
    secret?: string
}): AgentConnectResult {
    return {
        type: 'agent_connect',
        status: 'complete',
        channel: input.channelName,
        streamId: input.streamId,
        from: {
            name: input.agentName,
            address: input.sessionAddress,
        },
        to: input.targetAddresses,
        memberCount: input.memberCount,
        ...(input.secret ? { secret: input.secret } : {}),
        ...(input.secret
            ? {
                  joinToken: encodeJoinToken({
                      v: 1,
                      channel: input.channelName,
                      streamId: input.streamId,
                      secret: input.secret,
                  }),
              }
            : {}),
    }
}

export async function executeAgentConnect(
    options: {
        env: EnvName
        chain?: ChainName
        name?: string
        keystorePath?: string
        from: string
        channel?: string
        secret?: string
        to: string[]
        join?: string
        password: string
    },
    depsArg?: Partial<AgentConnectDeps>,
): Promise<AgentConnectResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const agentName = parseAgentName(options.from)

    const rootKeystorePath = resolveKeystorePath({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
    })

    return deps.withKeystoreLock(rootKeystorePath, async () => {
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
                throw new AgentConnectError('AGENT_NOT_FOUND', `Agent not found: ${agentName}`, {
                    cause: error,
                })
            }
            throw error
        }

        const joinToken = options.join ? decodeJoinToken(options.join) : undefined
        const channelInput = joinToken?.channel ?? options.channel
        if (!channelInput) {
            throw new Error('Channel name is required unless --join is provided.')
        }

        let channelName: string
        try {
            channelName = deps.parseChannelName(channelInput)
        } catch (error) {
            throw new AgentConnectError(
                'INVALID_CHANNEL',
                error instanceof Error ? error.message : 'Invalid channel name.',
                { cause: error },
            )
        }

        const listenStatus = await deps.checkAgentListenPid(session.sessionPath)
        if (listenStatus.active) {
            throw new AgentConnectError(
                'LISTEN_ACTIVE',
                `listen is running for agent "${agentName}". Stop it first, then re-run connect.`,
            )
        }

        const sessionAddress = getAddress(session.sessionKeystore.addresses.session)
        const localNamedChannels = session.sessionKeystore.namedChannels ?? {}
        const existingNamedChannel = localNamedChannels[channelName]
        const suppliedSecret =
            options.secret !== undefined ? deps.normalizeChannelSecret(options.secret) : undefined
        if (existingNamedChannel && suppliedSecret) {
            const suppliedHash = deps.hashChannelSecret(suppliedSecret)
            if (suppliedHash !== existingNamedChannel.secretHash) {
                throw new AgentConnectError(
                    'CHANNEL_SECRET_MISMATCH',
                    `Secret does not match the existing "${channelName}" binding.`,
                )
            }
        }

        const sessionPrivateKey = await deps.decryptSessionPrivateKey(
            session.sessionKeystore,
            options.password,
        )
        const exportedDevice = await deps.decryptAgentDevice(
            session.sessionKeystore,
            options.password,
        )
        const client = await deps.createAgentClient({
            env: options.env,
            sessionPrivateKey,
        })

        try {
            await client.initializeUser({
                encryptionDeviceInit: {
                    fromExportedDevice: exportedDevice,
                },
                skipSync: true,
            })

            const persistChannelBinding = async (input: {
                streamId: string
                secretHash: string
                memberSetKey?: string
            }) => {
                const nextDevice = await client.cryptoBackend?.exportDevice()
                if (!nextDevice) {
                    throw new Error('Failed to export encryption device after connect')
                }

                const nextNamedChannels = {
                    ...localNamedChannels,
                    [channelName]: {
                        streamId: input.streamId,
                        secretHash: input.secretHash,
                    } satisfies AgentNamedChannelRecord,
                }
                const updatedSession = await deps.finalizeAgentSessionKeystore({
                    baseKeystore: session.sessionKeystore,
                    password: options.password,
                    exportedDevice: nextDevice,
                    namedChannels: nextNamedChannels,
                })
                await deps.writeAgentSession(session.sessionPath, updatedSession)
                const registry = await deps.readAgentChannelRegistry(rootKeystorePath)
                const registryKey = deps.makeAgentChannelRegistryKey({
                    channelName,
                    memberSetKey:
                        input.memberSetKey ??
                        deps.getStreamMemberSetKey((await client.initStream(input.streamId)).view),
                    secretHash: input.secretHash,
                })
                await deps.writeAgentChannelRegistry(rootKeystorePath, {
                    ...registry,
                    channels: {
                        ...registry.channels,
                        [registryKey]: input.streamId,
                    },
                })
            }

            if (joinToken) {
                const joinSecret = deps.normalizeChannelSecret(joinToken.secret)
                const joinSecretHash = deps.hashChannelSecret(joinSecret)

                if (existingNamedChannel) {
                    if (existingNamedChannel.secretHash !== joinSecretHash) {
                        throw new AgentConnectError(
                            'CHANNEL_SECRET_MISMATCH',
                            `Secret does not match the existing "${channelName}" binding.`,
                        )
                    }
                    if (existingNamedChannel.streamId !== joinToken.streamId) {
                        throw new AgentConnectError(
                            'CHANNEL_CONFLICT',
                            `Channel "${channelName}" is already bound to a different stream.`,
                        )
                    }
                }

                try {
                    await client.initStream(joinToken.streamId)
                } catch (error) {
                    if (isMissingStreamError(error)) {
                        throw new Error(
                            'Stream not found or agent is not a member. The channel may have been deleted or the join token may be stale.',
                        )
                    }
                    throw error
                }

                await persistChannelBinding({
                    streamId: joinToken.streamId,
                    secretHash: joinSecretHash,
                })

                return {
                    type: 'agent_connect',
                    status: 'complete',
                    channel: channelName,
                    streamId: joinToken.streamId,
                    from: {
                        name: agentName,
                        address: sessionAddress,
                    },
                    to: [],
                    memberCount: 0,
                }
            }

            let targetAddresses: Address[]
            try {
                targetAddresses = await deps.resolveAgentTargetAddresses({
                    env: options.env,
                    name: options.name,
                    keystorePath: options.keystorePath,
                    targets: options.to,
                })
            } catch (error) {
                throw new AgentConnectError(
                    'TARGET_NOT_FOUND',
                    error instanceof Error ? error.message : 'Unknown target.',
                    { cause: error },
                )
            }

            const uniqueTargetAddresses = dedupeTargetAddresses(sessionAddress, targetAddresses)
            if (uniqueTargetAddresses.length === 0) {
                throw new AgentConnectError(
                    'TARGET_NOT_FOUND',
                    'Connect requires at least one other agent or address.',
                )
            }
            const memberAddresses = [sessionAddress, ...uniqueTargetAddresses]
                .map((address) => address.toLowerCase())
                .filter((value, index, values) => values.indexOf(value) === index)
                .sort()
            const memberSetKey = memberAddresses.join(':')
            const memberCount = memberAddresses.length
            if (memberCount > 6) {
                throw new AgentConnectError(
                    'TOO_MANY_MEMBERS',
                    'GDMs support at most 6 total members.',
                )
            }

            const effectiveSecret =
                suppliedSecret ?? (existingNamedChannel ? undefined : deps.generateChannelSecret())
            const effectiveSecretHash =
                existingNamedChannel?.secretHash ??
                (effectiveSecret ? deps.hashChannelSecret(effectiveSecret) : undefined)
            if (!effectiveSecretHash) {
                throw new AgentConnectError(
                    'UNKNOWN',
                    `Missing secret hash for channel "${channelName}".`,
                )
            }
            const registryKey = deps.makeAgentChannelRegistryKey({
                channelName,
                memberSetKey,
                secretHash: effectiveSecretHash,
            })

            if (existingNamedChannel) {
                try {
                    const boundStream = (await client.initStream(existingNamedChannel.streamId))
                        .view
                    const liveMemberSetKey = deps.getStreamMemberSetKey(boundStream)
                    if (liveMemberSetKey !== memberSetKey) {
                        throw new AgentConnectError(
                            'CHANNEL_CONFLICT',
                            `Channel "${channelName}" is already bound to a different member set.`,
                        )
                    }
                    return buildConnectResult({
                        agentName,
                        channelName,
                        sessionAddress,
                        streamId: existingNamedChannel.streamId,
                        targetAddresses: uniqueTargetAddresses,
                        memberCount,
                    })
                } catch (error) {
                    if (error instanceof AgentConnectError) {
                        throw error
                    }
                    if (!isMissingStreamError(error)) {
                        throw new AgentConnectError(
                            'SDK_ERROR',
                            error instanceof Error
                                ? error.message
                                : 'Failed to validate existing channel binding.',
                            { cause: error },
                        )
                    }
                }
            }

            const registry = await deps.readAgentChannelRegistry(rootKeystorePath)
            const registryEntry = registry.channels[registryKey]
            if (registryEntry) {
                try {
                    const registryStream = (await client.initStream(registryEntry)).view
                    if (deps.getStreamMemberSetKey(registryStream) === memberSetKey) {
                        await persistChannelBinding({
                            streamId: registryEntry,
                            secretHash: effectiveSecretHash,
                            memberSetKey,
                        })
                        return buildConnectResult({
                            agentName,
                            channelName,
                            sessionAddress,
                            streamId: registryEntry,
                            targetAddresses: uniqueTargetAddresses,
                            memberCount,
                        })
                    }
                } catch (error) {
                    if (!isMissingStreamError(error)) {
                        throw new AgentConnectError(
                            'SDK_ERROR',
                            error instanceof Error
                                ? error.message
                                : 'Failed to validate shared channel registry entry.',
                            { cause: error },
                        )
                    }
                    const nextChannels = { ...registry.channels }
                    delete nextChannels[registryKey]
                    await deps.writeAgentChannelRegistry(rootKeystorePath, {
                        ...registry,
                        channels: nextChannels,
                    })
                }
            }

            const { streamId } = await client.createGDMChannel(uniqueTargetAddresses)
            await client.updateGDMChannelProperties(
                streamId,
                channelName,
                deps.makeChannelSecretTopic(effectiveSecretHash),
            )
            await persistChannelBinding({
                streamId,
                secretHash: effectiveSecretHash,
                memberSetKey,
            })

            return buildConnectResult({
                agentName,
                channelName,
                sessionAddress,
                streamId,
                targetAddresses: uniqueTargetAddresses,
                memberCount,
                secret: effectiveSecret,
            })
        } catch (error) {
            if (error instanceof AgentConnectError) {
                throw error
            }
            throw new AgentConnectError(
                'SDK_ERROR',
                error instanceof Error ? error.message : 'Agent connect failed.',
                { cause: error },
            )
        } finally {
            await client.stop().catch(() => undefined)
        }
    })
}
