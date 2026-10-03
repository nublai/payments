import { afterEach, expect, mock, test } from 'bun:test'
import { executeSessionStart, resolveDaemonEntrypoint } from '../src/lib/session-start'
import { runSessionDaemonEntry } from '../src/lib/session-daemon'

const originalSocket = process.env.TW_AGENT_SOCK

afterEach(() => {
    if (originalSocket) {
        process.env.TW_AGENT_SOCK = originalSocket
    } else {
        delete process.env.TW_AGENT_SOCK
    }
})

test('resolveDaemonEntrypoint prefers daemon next to argv entry for built cli', () => {
    const found = resolveDaemonEntrypoint({
        argvEntry: '/work/packages/wallet/dist/cli.js',
        moduleUrl: 'file:///work/packages/wallet/src/lib/session-start.ts',
        exists: (path) => path === '/work/packages/wallet/dist/session-daemon.js',
        isBun: false,
    })

    expect(found).toBe('/work/packages/wallet/dist/session-daemon.js')
})

test('resolveDaemonEntrypoint falls back to source ts entry in bun dev mode', () => {
    const found = resolveDaemonEntrypoint({
        argvEntry: '/work/packages/wallet/src/cli.ts',
        moduleUrl: 'file:///work/packages/wallet/src/lib/session-start.ts',
        exists: (path) => path === '/work/packages/wallet/src/session-daemon.ts',
        isBun: true,
    })

    expect(found).toBe('/work/packages/wallet/src/session-daemon.ts')
})

test('resolveDaemonEntrypoint throws when no candidate exists', () => {
    expect(() =>
        resolveDaemonEntrypoint({
            argvEntry: '/work/packages/wallet/dist/cli.js',
            moduleUrl: 'file:///work/packages/wallet/src/lib/session-start.ts',
            exists: () => false,
            isBun: false,
        }),
    ).toThrow('Session daemon entrypoint not found')
})

test('executeSessionStart with foreground calls runSessionDaemonEntry with keepStdio true', async () => {
    const uniqueDir = `/tmp/tw-session-start-foreground-${Date.now()}`
    process.env.TW_AGENT_SOCK = `${uniqueDir}/session.sock`
    const runEntryMock = mock(async (_keepStdio: boolean) => ({
        pid: process.pid,
        socketPath: process.env.TW_AGENT_SOCK!,
        stop: async () => {},
        untilStopped: Promise.resolve(),
    }))
    const result = await executeSessionStart(
        { foreground: true },
        {
            runSessionDaemonEntry: runEntryMock,
        },
    )
    expect(runEntryMock).toHaveBeenCalledTimes(1)
    expect(runEntryMock).toHaveBeenCalledWith(true)
    expect(result.type).toBe('session_start')
    expect(result.status).toBe('complete')
    expect(result.alreadyRunning).toBe(false)
    expect(result.untilStopped).toBeDefined()
})

test('runSessionDaemonEntry in foreground mode keeps stdio streams writable', async () => {
    const uniqueDir = `/tmp/tw-session-start-smoke-${Date.now()}`
    process.env.TW_AGENT_SOCK = `${uniqueDir}/session.sock`

    const originalStdoutDestroy = process.stdout.destroy
    const originalStderrDestroy = process.stderr.destroy
    const stdoutDestroyMock = mock(() => process.stdout)
    const stderrDestroyMock = mock(() => process.stderr)
    process.stdout.destroy = stdoutDestroyMock as typeof process.stdout.destroy
    process.stderr.destroy = stderrDestroyMock as typeof process.stderr.destroy

    try {
        const daemon = await runSessionDaemonEntry(true)
        expect(process.stdout.write('')).toBe(true)
        expect(process.stderr.write('')).toBe(true)
        expect(stdoutDestroyMock).toHaveBeenCalledTimes(0)
        expect(stderrDestroyMock).toHaveBeenCalledTimes(0)
        await daemon.stop()
    } finally {
        process.stdout.destroy = originalStdoutDestroy
        process.stderr.destroy = originalStderrDestroy
    }
})
