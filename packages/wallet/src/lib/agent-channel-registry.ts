import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const AGENT_CHANNEL_REGISTRY_VERSION = 1 as const

export type AgentChannelRegistryFile = {
    version: typeof AGENT_CHANNEL_REGISTRY_VERSION
    channels: Record<string, string>
}

function defaultRegistry(): AgentChannelRegistryFile {
    return {
        version: AGENT_CHANNEL_REGISTRY_VERSION,
        channels: {},
    }
}

function resolveAgentChannelRegistryPath(rootKeystorePath: string): string {
    return join(dirname(rootKeystorePath), 'agent-channels.json')
}

export function makeAgentChannelRegistryKey(input: {
    channelName: string
    memberSetKey: string
    secretHash: string
}): string {
    return `${input.channelName}|${input.memberSetKey}|${input.secretHash}`
}

export async function readAgentChannelRegistry(
    rootKeystorePath: string,
): Promise<AgentChannelRegistryFile> {
    const path = resolveAgentChannelRegistryPath(rootKeystorePath)

    try {
        const raw = await readFile(path, 'utf8')
        const parsed = JSON.parse(raw) as unknown

        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !('version' in parsed) ||
            (parsed as { version?: unknown }).version !== AGENT_CHANNEL_REGISTRY_VERSION ||
            !('channels' in parsed) ||
            typeof (parsed as { channels?: unknown }).channels !== 'object' ||
            (parsed as { channels?: unknown }).channels === null
        ) {
            throw new Error(`Unsupported agent channel registry format at ${path}`)
        }

        const channels = (parsed as { channels: Record<string, unknown> }).channels

        for (const [key, value] of Object.entries(channels)) {
            if (typeof key !== 'string' || typeof value !== 'string') {
                throw new Error(`Invalid agent channel registry entry at ${path}`)
            }
        }

        return parsed as AgentChannelRegistryFile
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'ENOENT'
        ) {
            return defaultRegistry()
        }

        throw error
    }
}

export async function writeAgentChannelRegistry(
    rootKeystorePath: string,
    registry: AgentChannelRegistryFile,
): Promise<void> {
    const path = resolveAgentChannelRegistryPath(rootKeystorePath)
    const directory = dirname(path)
    const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`

    await mkdir(directory, { recursive: true })
    await writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })
    await rename(tempPath, path)

    if (process.platform !== 'win32') {
        await chmod(path, 0o600)
    }

    const file = await stat(path)

    if (file.size === 0) {
        await unlink(path)
        throw new Error(`Refusing to keep empty channel registry at ${path}`)
    }
}
