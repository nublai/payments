import { getAddress } from 'viem'
import { parseAgentName, parseChannelName } from './agent-identifiers'
import {
    decryptAgentDevice,
    decryptSessionPrivateKey,
    readCompleteAgentSession,
} from './agent-sessions'
import { defaultCreateAgentClient, isErrnoNotFound } from './agent-runtime'
import type { EnvName } from './network-config'

type AgentSendErrorCode =
    | 'AGENT_NOT_FOUND'
    | 'INVALID_CHANNEL'
    | 'CHANNEL_NOT_FOUND'
    | 'STREAM_NOT_FOUND'
    | 'SDK_ERROR'
    | 'UNKNOWN'

export class AgentSendError extends Error {
    code: AgentSendErrorCode
    cause?: unknown

    constructor(code: AgentSendErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AgentSendError'
        this.code = code
        this.cause = options?.cause
    }
}

export type AgentSendResult = {
    type: 'agent_send'
    status: 'complete'
    streamId: string
    eventId: string
}

type AgentSendDeps = {
    readCompleteAgentSession: typeof readCompleteAgentSession
    decryptSessionPrivateKey: typeof decryptSessionPrivateKey
    decryptAgentDevice: typeof decryptAgentDevice
    createAgentClient: typeof defaultCreateAgentClient
}

function getDefaultDeps(): AgentSendDeps {
    return {
        readCompleteAgentSession,
        decryptSessionPrivateKey,
        decryptAgentDevice,
        createAgentClient: defaultCreateAgentClient,
    }
}

export async function executeAgentSend(
    options: {
        env: EnvName
        name?: string
        keystorePath?: string
        from: string
        streamId?: string
        channel?: string
        replyTo?: string
        message: string
        password: string
    },
    depsArg?: Partial<AgentSendDeps>,
): Promise<AgentSendResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const agentName = parseAgentName(options.from)
    let channelName: string | undefined
    if (options.channel !== undefined) {
        try {
            channelName = parseChannelName(options.channel)
        } catch (error) {
            throw new AgentSendError(
                'INVALID_CHANNEL',
                error instanceof Error ? error.message : 'Invalid channel name.',
                { cause: error },
            )
        }
    }

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
            throw new AgentSendError('AGENT_NOT_FOUND', `Agent not found: ${agentName}`, {
                cause: error,
            })
        }
        throw error
    }

    const streamId =
        channelName !== undefined
            ? session.sessionKeystore.namedChannels?.[channelName]?.streamId
            : options.streamId

    if (channelName !== undefined && !streamId) {
        throw new AgentSendError(
            'CHANNEL_NOT_FOUND',
            `Channel not found for agent "${agentName}": ${channelName}`,
        )
    }
    if (!streamId) {
        throw new AgentSendError('STREAM_NOT_FOUND', 'A target stream ID is required.')
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

        let streamView
        try {
            streamView = await client.getStream(streamId)
        } catch (error) {
            throw new AgentSendError(
                'STREAM_NOT_FOUND',
                `Stream not found or agent is not a member: ${streamId}`,
                { cause: error },
            )
        }

        const selfUserId = getAddress(session.sessionKeystore.addresses.session).toLowerCase()
        const joinedUsers = new Set(
            Array.from(streamView.getMembers().joinedUsers).map((member) =>
                getAddress(member as `0x${string}`).toLowerCase(),
            ),
        )
        if (!joinedUsers.has(selfUserId)) {
            throw new AgentSendError(
                'STREAM_NOT_FOUND',
                `Stream not found or agent is not a member: ${streamId}`,
            )
        }

        await client.initStream(streamId)
        const { eventId } = options.replyTo
            ? await client.sendChannelMessage_Text(streamId, {
                  replyId: options.replyTo,
                  replyPreview: '\u{1F648}',
                  content: {
                      body: options.message,
                      mentions: [],
                      attachments: [],
                  },
              })
            : await client.sendMessage(streamId, options.message)
        return {
            type: 'agent_send',
            status: 'complete',
            streamId,
            eventId,
        }
    } catch (error) {
        if (error instanceof AgentSendError) {
            throw error
        }
        throw new AgentSendError(
            'SDK_ERROR',
            error instanceof Error ? error.message : 'Agent send failed.',
            { cause: error },
        )
    } finally {
        await client.stop().catch(() => undefined)
    }
}
