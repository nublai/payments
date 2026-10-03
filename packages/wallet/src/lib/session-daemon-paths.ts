import { chmod, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Read and parse PID from file; returns undefined on missing/invalid. Does not unlink. */
export async function readPidFromFile(path: string): Promise<number | undefined> {
    try {
        const raw = (await readFile(path, 'utf8')).trim()
        const pid = Number.parseInt(raw, 10)
        return Number.isFinite(pid) && pid > 0 ? pid : undefined
    } catch {
        return undefined
    }
}

export type SessionDaemonPaths = {
    stateDir: string
    socketPath: string
    pidPath: string
}

function resolveDefaultStateDir(): string {
    const customRuntimeDir = process.env.XDG_RUNTIME_DIR
    if (process.platform === 'linux' && customRuntimeDir) {
        return resolve(customRuntimeDir, 'agentic-payments-tw')
    }

    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'unknown'
    return resolve(tmpdir(), `agentic-payments-tw-${uid}`)
}

export function resolveSessionDaemonPaths(): SessionDaemonPaths {
    const envSocketPath = process.env.TW_AGENT_SOCK
    if (envSocketPath) {
        const socketPath = resolve(envSocketPath)
        return {
            stateDir: dirname(socketPath),
            socketPath,
            pidPath: resolve(dirname(socketPath), 'session-daemon.pid'),
        }
    }

    const stateDir = resolveDefaultStateDir()
    return {
        stateDir,
        socketPath: join(stateDir, 'session-daemon.sock'),
        pidPath: join(stateDir, 'session-daemon.pid'),
    }
}

export async function ensureSessionDaemonStateDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
}
