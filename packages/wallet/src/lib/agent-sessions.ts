import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { ExportedDeviceSchema, type ExportedDevice } from '@towns-labs/proto'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { resolveKeystorePath } from './account-create'
import {
    type AnySessionKeystore,
    decryptBufferSecret,
    decryptSessionKeystore,
    deriveKeystoreKey,
    encryptBufferSecret,
    isAgentKeystore,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    writeSessionKeystoreFile,
    type AgentSessionKeystoreV2,
} from './keystore'
import type { EnvName } from './network-config'
import { listSessionNames } from './session-common'
import { parseAgentName } from './agent-identifiers'

export type AgentNamedChannelRecord = NonNullable<AgentSessionKeystoreV2['namedChannels']>[string]

function resolveAgentSessionPath(
    rootKeystorePath: string,
    agentName: string,
    sessionsDir = 'sessions',
): string {
    return resolveSessionKeystorePath(rootKeystorePath, parseAgentName(agentName), sessionsDir)
}

async function resolveWalletProfile(input: { env: EnvName; name?: string; keystorePath?: string }) {
    const rootKeystorePath = resolveKeystorePath(input)
    const bundle = await readKeystoreBundle(rootKeystorePath)
    return {
        rootKeystorePath,
        bundle,
    }
}

export async function readAgentSession(input: {
    env: EnvName
    name?: string
    keystorePath?: string
    agentName: string
}) {
    const profile = await resolveWalletProfile(input)
    const sessionPath = resolveAgentSessionPath(
        profile.rootKeystorePath,
        input.agentName,
        profile.bundle.root.sessionRef.dir,
    )
    const sessionKeystore = await readSessionKeystoreFile(sessionPath)
    return {
        ...profile,
        sessionPath,
        sessionKeystore,
    }
}

export async function readCompleteAgentSession(input: {
    env: EnvName
    name?: string
    keystorePath?: string
    agentName: string
}) {
    const session = await readAgentSession(input)
    if (
        !isAgentKeystore(session.sessionKeystore) ||
        session.sessionKeystore.checkpoint !== 'complete'
    ) {
        throw new Error(`Agent ${input.agentName} is not initialized.`)
    }
    return {
        ...session,
        sessionKeystore: session.sessionKeystore,
    }
}

async function listLocalAgents(input: {
    env: EnvName
    name?: string
    keystorePath?: string
}): Promise<Array<{ name: string; address: Address; sessionPath: string }>> {
    const { rootKeystorePath, bundle } = await resolveWalletProfile(input)
    const names = await listSessionNames(rootKeystorePath, bundle.root.sessionRef.dir)
    const sessions = await Promise.all(
        names.map(async (sessionName) => {
            const sessionPath = resolveSessionKeystorePath(
                rootKeystorePath,
                sessionName,
                bundle.root.sessionRef.dir,
            )
            const session = await readSessionKeystoreFile(sessionPath)
            return { session, sessionPath }
        }),
    )

    return sessions.flatMap(({ session, sessionPath }) =>
        session.kind === 'agent'
            ? [
                  {
                      name: session.name,
                      address: getAddress(session.addresses.session),
                      sessionPath,
                  },
              ]
            : [],
    )
}

export async function resolveAgentTargetAddresses(input: {
    env: EnvName
    name?: string
    keystorePath?: string
    targets: string[]
}): Promise<Address[]> {
    const localAgents = await listLocalAgents(input)
    const localByName = new Map(localAgents.map((agent) => [agent.name, agent.address]))
    const addresses = new Set<Address>()

    for (const target of input.targets) {
        const local = localByName.get(target)
        if (local) {
            addresses.add(local)
            continue
        }
        if (isAddress(target)) {
            addresses.add(getAddress(target))
            continue
        }
        throw new Error(`Unknown agent or address: ${target}`)
    }

    return Array.from(addresses)
}

export async function decryptAgentDevice(
    keystore: AgentSessionKeystoreV2,
    password: string,
): Promise<ExportedDevice> {
    const key = await deriveKeystoreKey(password, keystore.kdf.params)
    try {
        const binary = decryptBufferSecret(keystore.secrets.encryptionDevice, key)
        return fromBinary(ExportedDeviceSchema, binary)
    } finally {
        key.fill(0)
    }
}

export async function finalizeAgentSessionKeystore(input: {
    baseKeystore: AnySessionKeystore
    password: string
    exportedDevice: ExportedDevice
    namedChannels?: Record<string, AgentNamedChannelRecord>
}): Promise<AgentSessionKeystoreV2> {
    const key = await deriveKeystoreKey(input.password, input.baseKeystore.kdf.params)
    try {
        const encryptionDevice = encryptBufferSecret(
            toBinary(ExportedDeviceSchema, input.exportedDevice),
            key,
        )
        return {
            ...input.baseKeystore,
            kind: 'agent',
            checkpoint: 'complete',
            secrets: {
                ...input.baseKeystore.secrets,
                encryptionDevice,
            },
            namedChannels: input.namedChannels,
        }
    } finally {
        key.fill(0)
    }
}

export async function writeAgentSession(
    sessionPath: string,
    keystore: AgentSessionKeystoreV2,
): Promise<void> {
    await writeSessionKeystoreFile(sessionPath, keystore, { overwrite: true })
}

export async function decryptSessionPrivateKey(
    sessionKeystore: AnySessionKeystore,
    password: string,
): Promise<Hex> {
    const decrypted = await decryptSessionKeystore(sessionKeystore, password)
    return decrypted.sessionPrivateKey
}
