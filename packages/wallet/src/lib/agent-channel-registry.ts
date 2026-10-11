import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'incur'

const AGENT_CHANNEL_REGISTRY_VERSION = 1 as const

const agentChannelRegistryFileSchema = z
    .object({
        version: z.literal(AGENT_CHANNEL_REGISTRY_VERSION),
        channels: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
    })
    .passthrough()

const agentChannelValuesSchema = z.union([z.record(z.string(), z.string()), z.array(z.string())])

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
        const file = agentChannelRegistryFileSchema.safeParse(parsed)

        if (!file.success) {
            throw new Error(`Unsupported agent channel registry format at ${path}`)
        }

        if (!agentChannelValuesSchema.safeParse(file.data.channels).success) {
            throw new Error(`Invalid agent channel registry entry at ${path}`)
        }

        // SAFETY: version and channels were checked; extra enumerable fields stay on parsed.
        return parsed as AgentChannelRegistryFile
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
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
