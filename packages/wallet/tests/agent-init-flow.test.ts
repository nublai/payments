import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import { ExportedDeviceSchema } from '@towns-labs/proto'
import { getAddress } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { executeAgentInit } from '../src/lib/agent-init'
import type { AgentClient } from '../src/lib/agent-runtime'
import {
    createRootKeystore,
    createSessionKeystore,
    isAgentKeystore,
    readSessionKeystoreFile,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
    type AgentSessionKeystoreV2,
} from '../src/lib/keystore'

async function setupWallet(sessionName = 'alice') {
    const password = 'pw'
    const dir = await mkdtemp(join(tmpdir(), 'wallet-agent-init-'))
    const rootPath = join(dir, 'default.keystore.json')
    const sessionPath = join(dir, 'sessions', `${sessionName}.json`)
    const rootPrivateKey = generatePrivateKey()
    const sessionPrivateKey = generatePrivateKey()
    const root = await createRootKeystore({
        password,
        rootPrivateKey,
        env: 'prod',
        relayerUrl: 'https://relayer-worker.towns.com/',
        rpcUrl: 'https://mainnet.base.org',
        chainId: 8453,
        activeSession: sessionName,
    })
    const session = await createSessionKeystore({
        password,
        sessionPrivateKey,
        network: root.network,
        delegated: root.addresses.root,
        name: sessionName,
        checkpoint: 'authorized',
    })
    await writeRootKeystoreFile(rootPath, root)
    await writeSessionKeystoreFile(sessionPath, session)
    return { dir, password, rootPath, sessionPath, session }
}

function makeClient(): AgentClient {
    return {
        initializeUser: mock(async () => undefined),
        uploadDeviceKeys: mock(async () => undefined),
        createGDMChannel: mock(async () => ({ streamId: 'unused' })),
        updateGDMChannelProperties: mock(async () => undefined),
        getStream: mock(async () => {
            throw new Error('unused')
        }),
        initStream: mock(async () => {
            throw new Error('unused')
        }),
        sendChannelMessage_Text: mock(async () => ({ eventId: 'unused' })),
        sendMessage: mock(async () => ({ eventId: 'unused' })),
        on: mock(() => undefined),
        off: mock(() => undefined),
        startSync: mock(() => undefined),
        stop: mock(async () => undefined),
        cryptoBackend: {
            exportDevice: mock(async () =>
                create(ExportedDeviceSchema, {
                    pickleKey: 'pickle',
                    pickledAccount: new Uint8Array([1, 2, 3]),
                    hybridGroupSessions: [],
                }),
            ),
        },
    }
}

test('executeAgentInit upgrades an existing session to an agent', async () => {
    const wallet = await setupWallet()
    const client = makeClient()

    try {
        const result = await executeAgentInit(
            {
                env: 'prod',
                keystorePath: wallet.rootPath,
                agentName: 'alice',
                password: wallet.password,
            },
            { createAgentClient: mock(async (_input) => client) },
        )

        const stored = await readSessionKeystoreFile(wallet.sessionPath)
        expect(result).toEqual({
            type: 'agent_init',
            status: 'complete',
            name: 'alice',
            address: getAddress(wallet.session.addresses.session),
        })
        expect(stored.kind).toBe('agent')
        expect(stored.checkpoint).toBe('complete')
    } finally {
        await rm(wallet.dir, { recursive: true, force: true })
    }
})

test('executeAgentInit is idempotent for an already-initialized agent', async () => {
    const wallet = await setupWallet()
    const client = makeClient()

    try {
        await executeAgentInit(
            {
                env: 'prod',
                keystorePath: wallet.rootPath,
                agentName: 'alice',
                password: wallet.password,
            },
            { createAgentClient: mock(async (_input) => client) },
        )

        const result = await executeAgentInit(
            {
                env: 'prod',
                keystorePath: wallet.rootPath,
                agentName: 'alice',
                password: wallet.password,
            },
            {
                createAgentClient: mock(async (_input) => {
                    throw new Error('should not create client')
                }),
            },
        )

        expect(result).toEqual({
            type: 'agent_init',
            status: 'already_initialized',
            name: 'alice',
            address: getAddress(wallet.session.addresses.session),
        })
    } finally {
        await rm(wallet.dir, { recursive: true, force: true })
    }
})

test('executeAgentInit resumes a partial agent keystore and preserves named channels', async () => {
    const wallet = await setupWallet()
    const client = makeClient()

    try {
        const partialKeystore: AgentSessionKeystoreV2 = {
            ...(await readSessionKeystoreFile(wallet.sessionPath)),
            kind: 'agent',
            checkpoint: 'authorized',
            secrets: {
                ...(await readSessionKeystoreFile(wallet.sessionPath)).secrets,
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
        await writeSessionKeystoreFile(wallet.sessionPath, partialKeystore, { overwrite: true })

        const result = await executeAgentInit(
            {
                env: 'prod',
                keystorePath: wallet.rootPath,
                agentName: 'alice',
                password: wallet.password,
            },
            { createAgentClient: mock(async (_input) => client) },
        )

        const stored = await readSessionKeystoreFile(wallet.sessionPath)
        expect(result.status).toBe('complete')
        expect(stored.kind).toBe('agent')
        expect(isAgentKeystore(stored)).toBe(true)
        if (!isAgentKeystore(stored)) {
            throw new Error('Expected agent keystore')
        }
        expect(stored.namedChannels).toEqual(partialKeystore.namedChannels)
    } finally {
        await rm(wallet.dir, { recursive: true, force: true })
    }
})
