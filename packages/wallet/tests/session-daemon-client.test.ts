import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionDaemonClient } from '../src/lib/session-daemon-client'

const originalSocket = process.env.TW_AGENT_SOCK

afterEach(async () => {
    if (originalSocket) {
        process.env.TW_AGENT_SOCK = originalSocket
    } else {
        delete process.env.TW_AGENT_SOCK
    }
})

async function withSocketServer(
    handler: (socket: net.Socket) => void,
    run: () => Promise<void>,
): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'tw-daemon-client-test-'))
    const socketPath = join(dir, 'daemon.sock')
    process.env.TW_AGENT_SOCK = socketPath

    const server = net.createServer(handler)
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => resolve())
    })

    try {
        await run()
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(dir, { recursive: true, force: true })
    }
}

test('SessionDaemonClient returns null on response id mismatch', async () => {
    await withSocketServer(
        (socket) => {
            socket.once('data', () => {
                socket.write('{"id":"wrong-id","result":{"ok":true,"startedAt":1}}\n')
            })
        },
        async () => {
            const client = new SessionDaemonClient()
            const ping = await client.ping()
            expect(ping).toBeNull()
        },
    )
})

test('SessionDaemonClient returns null on malformed response payload', async () => {
    await withSocketServer(
        (socket) => {
            socket.once('data', () => {
                socket.write('not-json\n')
            })
        },
        async () => {
            const client = new SessionDaemonClient()
            const ping = await client.ping()
            expect(ping).toBeNull()
        },
    )
})
