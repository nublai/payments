import { expect, test } from 'bun:test'
import { executeSessionStop, type SessionStopDeps } from '../src/lib/session-stop'
import { typedMock } from './helpers/typed-mock'

test('executeSessionStop does not unlink pid/socket when process does not exit after SIGTERM', async () => {
    process.env.TW_AGENT_SOCK = '/tmp/tw-session-stop-nonexit.sock'

    const unlinkMock = typedMock<SessionStopDeps['unlink']>(async () => {})

    const result = await executeSessionStop({
        readPidFromFile: async () => 12345,
        createClient: () => ({
            ping: async () => ({ ok: true as const, result: { ok: true as const, startedAt: 1 } }),
        }),
        sendSignal: () => {},
        waitForExit: async () => false,
        unlink: unlinkMock,
    })

    expect(result.ok).toBe(false)
    expect(result.stopped).toBe(false)
    expect(result.warning).toContain('did not exit')
    expect(unlinkMock).toHaveBeenCalledTimes(0)
})

test('executeSessionStop reports cleanup unlink errors on stale pid/socket cleanup', async () => {
    process.env.TW_AGENT_SOCK = '/tmp/tw-session-stop-stale.sock'

    const unlinkMock = typedMock<SessionStopDeps['unlink']>(async (path) => {
        if (String(path).endsWith('.pid')) {
            throw new Error('permission denied')
        }
    })

    const result = await executeSessionStop({
        readPidFromFile: async () => 45678,
        createClient: () => ({ ping: async () => null }),
        sendSignal: (_pid, signal) => {
            if (signal === 0) {
                const error: NodeJS.ErrnoException = new Error('no such process')
                error.code = 'ESRCH'
                throw error
            }
        },
        waitForExit: async () => true,
        unlink: unlinkMock,
    })

    expect(result.ok).toBe(true)
    expect(result.stopped).toBe(false)
    expect(result.cleanupErrors).toHaveLength(1)
    expect(result.cleanupErrors?.[0]).toContain('permission denied')
})
