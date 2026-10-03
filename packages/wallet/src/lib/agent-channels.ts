import { getAddress, type Address } from 'viem'
import { parseAgentName } from './agent-identifiers'
import {
    decryptAgentDevice,
    decryptSessionPrivateKey,
    readCompleteAgentSession,
} from './agent-sessions'
import { defaultCreateAgentClient, isErrnoNotFound } from './agent-runtime'
import type { EnvName } from './network-config'

type AgentChannelsErrorCode = 'AGENT_NOT_FOUND' | 'SDK_ERROR' | 'UNKNOWN'

export class AgentChannelsError extends Error {
    code: AgentChannelsErrorCode
    cause?: unknown

    constructor(code: AgentChannelsErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AgentChannelsError'
        this.code = code
        this.cause = options?.cause
    }
}

export type AgentChannelsResult = {
    type: 'agent_channels'
    agent: {
        name: string
        address: Address
    }
    channels: Array<{
        name: string
        streamId: string
        members: Address[]
        memberCount: number
    }>
    staleChannels: Array<{
        name: string
        streamId: string
        reason: 'stream_missing'
    }>
}

type AgentChannelsDeps = {
    readCompleteAgentSession: typeof readCompleteAgentSession
    decryptSessionPrivateKey: typeof decryptSessionPrivateKey
    decryptAgentDevice: typeof decryptAgentDevice
    createAgentClient: typeof defaultCreateAgentClient
}

function getDefaultDeps(): AgentChannelsDeps {
    return {
        readCompleteAgentSession,
        decryptSessionPrivateKey,
        decryptAgentDevice,
        createAgentClient: defaultCreateAgentClient,
    }
}

export async function executeAgentChannels(
    options: {
        env: EnvName
        name?: string
        keystorePath?: string
        from: string
        password: string
    },
    depsArg?: Partial<AgentChannelsDeps>,
): Promise<AgentChannelsResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const agentName = parseAgentName(options.from)

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
            throw new AgentChannelsError('AGENT_NOT_FOUND', `Agent not found: ${agentName}`, {
                cause: error,
            })
        }
        throw error
    }

    const sessionPrivateKey = await deps.decryptSessionPrivateKey(
        session.sessionKeystore,
        options.password,
    )
    const exportedDevice = await deps.decryptAgentDevice(session.sessionKeystore, options.password)
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

        const channels: AgentChannelsResult['channels'] = []
        const staleChannels: AgentChannelsResult['staleChannels'] = []
        const namedChannels = Object.entries(session.sessionKeystore.namedChannels ?? {}).sort(
            ([left], [right]) => left.localeCompare(right),
        )

        for (const [name, binding] of namedChannels) {
            try {
                const stream = (await client.initStream(binding.streamId)).view
                const members = Array.from(stream.getMembers().joinedUsers)
                    .map((member) => getAddress(member as Address))
                    .sort((left, right) => left.localeCompare(right))

                channels.push({
                    name,
                    streamId: binding.streamId,
                    members,
                    memberCount: members.length,
                })
            } catch {
                staleChannels.push({
                    name,
                    streamId: binding.streamId,
                    reason: 'stream_missing',
                })
            }
        }

        return {
            type: 'agent_channels',
            agent: {
                name: agentName,
                address: getAddress(session.sessionKeystore.addresses.session),
            },
            channels,
            staleChannels,
        }
    } catch (error) {
        if (error instanceof AgentChannelsError) {
            throw error
        }
        throw new AgentChannelsError(
            'SDK_ERROR',
            error instanceof Error ? error.message : 'Agent channels failed.',
            { cause: error },
        )
    } finally {
        await client.stop().catch(() => undefined)
    }
}
