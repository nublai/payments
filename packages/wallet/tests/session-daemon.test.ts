import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import { encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { INTENT_TYPES } from '@nubl/relayer-client'
import { runSessionDaemon } from '../src/lib/session-daemon'
import { SessionDaemonClient } from '../src/lib/session-daemon-client'
import type { DaemonTypedData } from '../src/lib/session-daemon-protocol'
import { installFormerProdDeployments } from './helpers/former-deployment-env'

let restoreFormerProdDeployments = () => {}

beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})

afterAll(() => {
    restoreFormerProdDeployments()
})

const TEST_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945388cf6f64f6b5f8a6d4f7e7a3fa8f8ff7f0' as const

const originalSocket = process.env.TW_AGENT_SOCK

afterEach(async () => {
    if (originalSocket) {
        process.env.TW_AGENT_SOCK = originalSocket
    } else {
        delete process.env.TW_AGENT_SOCK
    }
})

test('daemon load/list/sign/expiry lifecycle works', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-session-daemon-test-'))
    process.env.TW_AGENT_SOCK = join(dir, 'session-daemon.sock')

    const daemon = await runSessionDaemon()
    const client = new SessionDaemonClient()

    const account = privateKeyToAccount(TEST_PRIVATE_KEY)

    const loadMismatch = await client.loadKey({
        name: 'default',
        privateKey: TEST_PRIVATE_KEY,
        address: '0x1111111111111111111111111111111111111111',
        durationSeconds: 5,
    })

    expect(loadMismatch?.ok).toBe(false)

    const load = await client.loadKey({
        name: 'default',
        privateKey: TEST_PRIVATE_KEY,
        address: account.address,
        durationSeconds: 1,
        kind: 'agent',
        encryptionDevice: '0x1234',
        // Lifecycle fixture signs arbitrary typed data, which only a phrase unlock may do.
        phraseConfirmed: true,
        env: 'prod',
    })

    expect(load?.ok).toBe(true)

    const list = await client.list()
    expect(list?.ok).toBe(true)

    if (list?.ok) {
        expect(list.result.keys).toHaveLength(1)
        expect(list.result.keys[0]?.name).toBe('default')
        expect(list.result.keys[0]?.kind).toBe('agent')
    }

    const secrets = await client.getSessionSecrets('default')
    expect(secrets?.ok).toBe(false)
    expect(JSON.stringify(secrets)).not.toContain(TEST_PRIVATE_KEY)

    const typedData = orchestratorIntent(account.address, '0x')

    const signed = await client.sign('default', typedData)
    expect(signed?.ok).toBe(true)

    if (signed?.ok) {
        const direct = await account.signTypedData(typedData)
        expect(signed.result).toBe(direct)
    }

    await new Promise((resolve) => setTimeout(resolve, 1_100))

    const expired = await client.sign('default', typedData)
    expect(expired?.ok).toBe(false)

    if (expired && !expired.ok) {
        expect(expired.error.code).toBe('SESSION_EXPIRED')
    }

    const missing = await client.sign('missing', typedData)
    expect(missing?.ok).toBe(false)

    if (missing && !missing.ok) {
        expect(missing.error.code).toBe('SESSION_NOT_FOUND')
    }

    await daemon.stop()
})

const ROUTER = '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f' as Address

const PROD_BASE_ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8' as Address

function routerMulticall(user: Address, innerSelector: Hex): Hex {
    return encodeFunctionData({
        abi: [
            {
                name: 'multicall',
                type: 'function',
                stateMutability: 'payable',
                inputs: [
                    {
                        name: 'calls',
                        type: 'tuple[]',
                        components: [
                            { name: 'target', type: 'address' },
                            { name: 'allowFailure', type: 'bool' },
                            { name: 'value', type: 'uint256' },
                            { name: 'callData', type: 'bytes' },
                        ],
                    },
                    { name: 'refundTo', type: 'address' },
                    { name: 'nftRecipient', type: 'address' },
                    { name: 'metadata', type: 'bytes' },
                ],
                outputs: [],
            },
        ],
        functionName: 'multicall',
        args: [
            [{ target: ROUTER, allowFailure: false, value: 0n, callData: innerSelector }],
            user,
            user,
            '0x',
        ],
    })
}

function orchestratorIntent(user: Address, data: Hex): DaemonTypedData {
    return {
        domain: {
            name: 'Orchestrator',
            version: '0.5.5',
            chainId: 8453,
            verifyingContract: PROD_BASE_ORCHESTRATOR,
        },
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message: {
            multichain: false,
            eoa: user,
            calls: [{ to: ROUTER, value: 0n, data }],
            nonce: 1n,
            payer: zeroAddress,
            paymentToken: zeroAddress,
            paymentMaxAmount: 0n,
            combinedGas: 0n,
            encodedPreCalls: [],
            encodedFundTransfers: [],
            settler: zeroAddress,
            expiry: 0n,
        },
    } as DaemonTypedData
}

test('a phrase-confirmed swap session signs only a relay quote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-swap-daemon-'))
    process.env.TW_AGENT_SOCK = join(dir, 'session-daemon.sock')
    const daemon = await runSessionDaemon()
    const client = new SessionDaemonClient()
    const account = privateKeyToAccount(TEST_PRIVATE_KEY)

    try {
        const load = await client.loadKey({
            name: 'swap',
            privateKey: TEST_PRIVATE_KEY,
            address: account.address,
            durationSeconds: 60,
            phraseConfirmed: true,
            swapSession: true,
            env: 'prod',
        })

        expect(load?.ok).toBe(true)

        const arbitrary: DaemonTypedData = {
            ...orchestratorIntent(account.address, '0x'),
            domain: {
                name: 'session-daemon-test',
                version: '1',
                chainId: 8453,
                verifyingContract: zeroAddress,
            },
        }

        const refused = await client.sign('swap', arbitrary)
        expect(refused?.ok).toBe(false)

        if (refused && !refused.ok) {
            expect(refused.error.message).toContain('not an Orchestrator intent')
        }

        const badInner = orchestratorIntent(account.address, routerMulticall(account.address, '0x12345678'))
        const refusedInner = await client.sign('swap', badInner)
        expect(refusedInner?.ok).toBe(false)

        if (refusedInner && !refusedInner.ok) {
            expect(refusedInner.error.message).toContain('not an allowlisted relay entrypoint')
        }

        const cleanup = orchestratorIntent(account.address, routerMulticall(account.address, '0x9bb43718'))
        const signed = await client.sign('swap', cleanup)
        expect(signed?.ok).toBe(true)

        if (signed?.ok) {
            const direct = await account.signTypedData(cleanup)
            expect(signed.result).toBe(direct)
        }

        const message = await client.signMessage('swap', '0x1234')
        expect(message?.ok).toBe(false)

        if (message && !message.ok) {
            expect(message.error.message).toContain('only signs relay quotes')
        }
    } finally {
        await daemon.stop()
    }
})

test('daemon drops oversized payload without newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-session-daemon-test-'))
    process.env.TW_AGENT_SOCK = join(dir, 'session-daemon.sock')
    const daemon = await runSessionDaemon()

    const socket = net.createConnection(process.env.TW_AGENT_SOCK!)

    const closed = new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
    })

    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('error', reject)
    })

    // Write more than 256KB with no newline to ensure the daemon enforces the cap pre-frame.
    socket.write('x'.repeat(260 * 1024))
    await closed

    await daemon.stop()
})
