import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPidFromFile, resolveSessionDaemonPaths } from './session-daemon-paths'
import { SessionDaemonClient } from './session-daemon-client'
import { runSessionDaemonEntry } from './session-daemon'

const START_TIMEOUT_MS = 5_000

export type SessionStartDeps = {
    runSessionDaemonEntry: (
        keepStdio: boolean,
    ) => Promise<import('./session-daemon').RunningSessionDaemon>
}

export type SessionStartResult = {
    type: 'session_start'
    status: 'complete'
    pid: number
    socketPath: string
    alreadyRunning: boolean
    /** When set (foreground mode), await this to keep the process alive until the daemon is stopped (e.g. Ctrl+C). */
    untilStopped?: Promise<void>
}

function isErrnoCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === code
    )
}

export function resolveDaemonEntrypoint(input?: {
    argvEntry?: string
    moduleUrl?: string
    isBun?: boolean
    exists?: (path: string) => boolean
}): string {
    const exists = input?.exists ?? existsSync
    const isBun = input?.isBun ?? Boolean(process.versions.bun)
    const moduleFile = fileURLToPath(input?.moduleUrl ?? import.meta.url)
    const moduleDir = dirname(moduleFile)
    const argvEntry = input?.argvEntry ?? process.argv[1]

    const candidates: string[] = []
    if (argvEntry) {
        const argvDir = dirname(resolve(argvEntry))
        candidates.push(resolve(argvDir, 'session-daemon.js'))
    }
    candidates.push(
        resolve(moduleDir, '../session-daemon.js'),
        resolve(moduleDir, '../session-daemon.ts'),
        resolve(moduleDir, 'session-daemon.js'),
    )

    for (const candidate of candidates) {
        if (candidate.endsWith('.ts') && !isBun) {
            continue
        }
        if (exists(candidate)) {
            return candidate
        }
    }
    throw new Error(`Session daemon entrypoint not found. Checked: ${candidates.join(', ')}`)
}

export async function executeSessionStart(
    options?: { foreground?: boolean },
    depsArg?: Partial<SessionStartDeps>,
): Promise<SessionStartResult> {
    const runEntry = depsArg?.runSessionDaemonEntry ?? runSessionDaemonEntry
    const paths = resolveSessionDaemonPaths()
    const client = new SessionDaemonClient(paths.socketPath)

    const existingPid = await readPidFromFile(paths.pidPath)
    if (existingPid) {
        try {
            process.kill(existingPid, 0)
            const ping = await client.ping()
            if (ping?.ok) {
                return {
                    type: 'session_start',
                    status: 'complete',
                    pid: existingPid,
                    socketPath: paths.socketPath,
                    alreadyRunning: true,
                }
            }
            debugSessionStart('Found stale pid with no healthy ping', { pid: existingPid })
        } catch (error) {
            if (!isErrnoCode(error, 'ESRCH')) {
                throw error
            }
            debugSessionStart('Stale pid file; process no longer exists', { pid: existingPid })
        }
    }

    if (options?.foreground) {
        const daemon = await runEntry(true)
        return {
            type: 'session_start',
            status: 'complete',
            pid: process.pid,
            socketPath: paths.socketPath,
            alreadyRunning: false,
            untilStopped: daemon.untilStopped,
        }
    }

    const daemonEntry = resolveDaemonEntrypoint()
    await access(daemonEntry, constants.F_OK)

    const child = spawn(process.execPath, [daemonEntry], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
    })

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Daemon failed to start within 5s'))
        }, START_TIMEOUT_MS)

        child.stdout?.on('data', (chunk: Buffer) => {
            if (chunk.toString('utf8').includes('ready')) {
                clearTimeout(timeout)
                resolve()
            }
        })
        child.once('error', (error) => {
            clearTimeout(timeout)
            reject(error)
        })
        child.once('exit', (code) => {
            clearTimeout(timeout)
            reject(new Error(`Daemon exited with code ${String(code)}`))
        })
    })

    child.stdout?.destroy()
    child.unref()

    const pid = await readPidFromFile(paths.pidPath)
    if (!pid) {
        throw new Error('Daemon started but pid file was not written')
    }

    return {
        type: 'session_start',
        status: 'complete',
        pid,
        socketPath: paths.socketPath,
        alreadyRunning: false,
    }
}

function debugSessionStart(message: string, details?: unknown): void {
    if (process.env.TW_DAEMON_DEBUG !== '1') {
        return
    }
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
    console.error(`[tw daemon start] ${message}${suffix}`)
}
