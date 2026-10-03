import { randomBytes } from 'node:crypto'
import { getAddress, type Address } from 'viem'
import { parseAgentName } from './agent-identifiers'
import {
    decryptSessionPrivateKey,
    finalizeAgentSessionKeystore,
    readAgentSession,
    writeAgentSession,
} from './agent-sessions'
import { defaultCreateAgentClient } from './agent-runtime'
import type { EnvName } from './network-config'

export type AgentInitResult = {
    type: 'agent_init'
    status: 'complete' | 'already_initialized'
    name: string
    address: Address
}

type AgentInitDeps = {
    createAgentClient: typeof defaultCreateAgentClient
}

function getDefaultDeps(): AgentInitDeps {
    return {
        createAgentClient: defaultCreateAgentClient,
    }
}

export async function executeAgentInit(
    options: {
        env: EnvName
        name?: string
        keystorePath?: string
        agentName: string
        password: string
    },
    depsArg?: Partial<AgentInitDeps>,
): Promise<AgentInitResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const agentName = parseAgentName(options.agentName)
    const session = await readAgentSession({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
        agentName,
    })

    if (
        session.sessionKeystore.kind === 'agent' &&
        session.sessionKeystore.checkpoint === 'complete'
    ) {
        return {
            type: 'agent_init',
            status: 'already_initialized',
            name: agentName,
            address: getAddress(session.sessionKeystore.addresses.session),
        }
    }

    const sessionPrivateKey = await decryptSessionPrivateKey(
        session.sessionKeystore,
        options.password,
    )
    const pickleKey = randomBytes(32).toString('base64')
    const client = await deps.createAgentClient({
        env: options.env,
        sessionPrivateKey,
    })

    try {
        await client.initializeUser({
            encryptionDeviceInit: {
                pickleKey,
            },
            skipSync: true,
        })
        await client.uploadDeviceKeys()
        const exportedDevice = await client.cryptoBackend?.exportDevice()
        if (!exportedDevice) {
            throw new Error('Failed to export encryption device')
        }

        const agentKeystore = await finalizeAgentSessionKeystore({
            baseKeystore: session.sessionKeystore,
            password: options.password,
            exportedDevice,
            namedChannels:
                session.sessionKeystore.kind === 'agent'
                    ? session.sessionKeystore.namedChannels
                    : undefined,
        })
        await writeAgentSession(session.sessionPath, agentKeystore)

        return {
            type: 'agent_init',
            status: 'complete',
            name: agentName,
            address: getAddress(agentKeystore.addresses.session),
        }
    } finally {
        await client.stop().catch(() => undefined)
    }
}
