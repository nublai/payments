import { expect, mock, test } from 'bun:test'
import { executeSessionStop } from '../src/lib/session-stop'

test('executeSessionStop does not unlink pid/socket when process does not exit after SIGTERM', async () => {
    process.env.TW_AGENT_SOCK = '/tmp/tw-session-stop-nonexit.sock'

    const unlinkMock = mock(async (_path: string) => {})

    const result = await executeSessionStop({
        readPidFromFile: async () => 12345,
        createClient: () => ({
            ping: async () => ({ ok: true as const, result: { ok: true as const, startedAt: 1 } }),
        }),
        sendSignal: () => {},
        waitForExit: async () => false,
        unlink: unlinkMock as unknown as typeof import('node:fs/promises').unlink,
    })

    expect(result.ok).toBe(false)
    expect(result.stopped).toBe(false)
    expect(result.warning).toContain('did not exit')
    expect(unlinkMock).toHaveBeenCalledTimes(0)
})

test('executeSessionStop reports cleanup unlink errors on stale pid/socket cleanup', async () => {
    process.env.TW_AGENT_SOCK = '/tmp/tw-session-stop-stale.sock'

    const unlinkMock = mock(async (path: string) => {
        if (path.endsWith('.pid')) {
            throw new Error('permission denied')
        }
    })

    const result = await executeSessionStop({
        readPidFromFile: async () => 45678,
        createClient: () => ({ ping: async () => null }),
        sendSignal: (_pid, signal) => {
            if (signal === 0) {
                const error = new Error('no such process') as Error & { code?: string }
                error.code = 'ESRCH'
                throw error
            }
        },
        waitForExit: async () => true,
        unlink: unlinkMock as unknown as typeof import('node:fs/promises').unlink,
    })

    expect(result.ok).toBe(true)
    expect(result.stopped).toBe(false)
    expect(result.cleanupErrors).toHaveLength(1)
    expect(result.cleanupErrors?.[0]).toContain('permission denied')
})
