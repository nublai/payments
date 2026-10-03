import { unlink } from 'node:fs/promises'
import { readPidFromFile, resolveSessionDaemonPaths } from './session-daemon-paths'
import { SessionDaemonClient } from './session-daemon-client'

export type SessionStopResult = {
    type: 'session_stop'
    status: 'complete'
    ok: boolean
    stopped: boolean
    pid?: number
    warning?: string
    cleanupErrors?: string[]
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        try {
            process.kill(pid, 0)
            await new Promise((resolve) => setTimeout(resolve, 100))
        } catch {
            return true
        }
    }
    return false
}

type SessionStopDeps = {
    readPidFromFile: typeof readPidFromFile
    createClient: (socketPath: string) => Pick<SessionDaemonClient, 'ping'>
    sendSignal: (pid: number, signal: NodeJS.Signals | 0) => void
    waitForExit: (pid: number) => Promise<boolean>
    unlink: typeof unlink
}

function getDefaultDeps(): SessionStopDeps {
    return {
        readPidFromFile,
        createClient: (socketPath) => new SessionDaemonClient(socketPath),
        sendSignal: (pid, signal) => process.kill(pid, signal),
        waitForExit,
        unlink,
    }
}

async function safeUnlink(path: string, deps: SessionStopDeps): Promise<string | undefined> {
    try {
        await deps.unlink(path)
        return undefined
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'ENOENT'
        ) {
            return undefined
        }
        const message = error instanceof Error ? error.message : String(error)
        debugSessionStop('Failed to unlink stale file', { path, message })
        return `${path}: ${message}`
    }
}

export async function executeSessionStop(
    depsArg?: Partial<SessionStopDeps>,
): Promise<SessionStopResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const paths = resolveSessionDaemonPaths()
    const pid = await deps.readPidFromFile(paths.pidPath)
    if (!pid) {
        return {
            type: 'session_stop',
            status: 'complete',
            ok: true,
            stopped: false,
        }
    }

    const client = deps.createClient(paths.socketPath)
    const ping = await client.ping()

    let processAlive = true
    try {
        deps.sendSignal(pid, 0)
    } catch {
        processAlive = false
    }

    if (!processAlive || !ping?.ok) {
        const cleanupErrors = (
            await Promise.all([safeUnlink(paths.pidPath, deps), safeUnlink(paths.socketPath, deps)])
        ).filter((value): value is string => value !== undefined)
        return {
            type: 'session_stop',
            status: 'complete',
            ok: true,
            stopped: false,
            pid,
            cleanupErrors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
        }
    }

    deps.sendSignal(pid, 'SIGTERM')
    const exited = await deps.waitForExit(pid)
    if (!exited) {
        return {
            type: 'session_stop',
            status: 'complete',
            ok: false,
            stopped: false,
            pid,
            warning: `Daemon process ${pid} did not exit within 5s after SIGTERM.`,
        }
    }

    const cleanupErrors: string[] = []
    const pidUnlinkError = await safeUnlink(paths.pidPath, deps)
    if (pidUnlinkError) {
        cleanupErrors.push(pidUnlinkError)
    }
    const sockUnlinkError = await safeUnlink(paths.socketPath, deps)
    if (sockUnlinkError) {
        cleanupErrors.push(sockUnlinkError)
    }

    return {
        type: 'session_stop',
        status: 'complete',
        ok: true,
        stopped: true,
        pid,
        cleanupErrors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
    }
}

function debugSessionStop(message: string, details?: unknown): void {
    if (process.env.TW_DAEMON_DEBUG !== '1') {
        return
    }
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
    console.error(`[tw daemon stop] ${message}${suffix}`)
}
