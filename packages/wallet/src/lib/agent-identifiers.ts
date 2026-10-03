import { createHash, randomBytes } from 'node:crypto'
import type { StreamStateView } from '@towns-labs/sdk'
import { getAddress, type Address } from 'viem'

const AGENT_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/
const CHANNEL_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,62}$/
const CHANNEL_SECRET_TOPIC_PREFIX = 'tw-agent-secret:'
const USER_STREAM_PREFIX = 'a8'

export function parseAgentName(value: string): string {
    const normalized = value.trim()
    if (!AGENT_NAME_REGEX.test(normalized)) {
        throw new Error(
            `Invalid agent name "${value}". Use lowercase letters, numbers, and hyphens only.`,
        )
    }
    return normalized
}

export function resolveAgentName(options: { from?: string }, env: { TW_AGENT?: string }): string {
    const raw = options.from ?? env.TW_AGENT
    if (!raw) {
        throw new Error(
            'No agent specified. Use --from <name> or set TW_AGENT environment variable.',
        )
    }
    return parseAgentName(raw)
}

export function assertAgentPasswordAvailable(input: {
    envPassword?: string
    passwordStdin?: boolean
    isInteractive: boolean
}): void {
    if (input.envPassword || input.passwordStdin || input.isInteractive) {
        return
    }
    throw new Error(
        'Password required. Set TW_PASSWORD environment variable for non-interactive use.',
    )
}

export function parseChannelName(value: string): string {
    const normalized = value.trim().toLowerCase()
    if (!CHANNEL_NAME_REGEX.test(normalized)) {
        throw new Error(
            `Invalid channel name "${value}". Use lowercase letters, numbers, hyphens, or underscores.`,
        )
    }
    return normalized
}

export function normalizeChannelSecret(value: string): string {
    const normalized = value.trim()
    if (!normalized) {
        throw new Error('Channel secret cannot be empty.')
    }
    return normalized
}

export function generateChannelSecret(bytes = 18): string {
    return randomBytes(bytes).toString('base64url')
}

export function hashChannelSecret(secret: string): string {
    return createHash('sha256').update(normalizeChannelSecret(secret), 'utf8').digest('hex')
}

export function makeChannelSecretTopic(secretHash: string): string {
    return `${CHANNEL_SECRET_TOPIC_PREFIX}${secretHash}`
}

export function makeUserStreamIdForAddress(address: string): string {
    return `${USER_STREAM_PREFIX}${getAddress(address).toLowerCase().slice(2)}`.padEnd(64, '0')
}

export function getStreamMemberSetKey(stream: StreamStateView): string {
    return Array.from(stream.getMembers().joinedUsers)
        .map((member) => getAddress(member as Address).toLowerCase())
        .sort()
        .join(':')
}
