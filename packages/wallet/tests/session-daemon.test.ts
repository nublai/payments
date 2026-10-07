import { afterEach, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import { privateKeyToAccount } from 'viem/accounts'
import { runSessionDaemon } from '../src/lib/session-daemon'
import { SessionDaemonClient } from '../src/lib/session-daemon-client'

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

    const typedData = {
        domain: { name: 'session-daemon-test' },
        types: {
            EIP712Domain: [{ name: 'name', type: 'string' }],
            Intent: [{ name: 'nonce', type: 'uint256' }],
        },
        primaryType: 'Intent' as const,
        message: { nonce: 1n },
    }

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
