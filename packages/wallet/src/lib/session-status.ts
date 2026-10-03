import { SessionDaemonClient } from './session-daemon-client'
import { resolveSessionDaemonPaths } from './session-daemon-paths'

export type SessionStatusResult = {
    type: 'session_status'
    status: 'running' | 'stopped'
    socketPath: string
    startedAt?: number
    keys: Array<{
        name: string
        address: string
        kind?: string
        expiresAt: number
        ttlSeconds: number
    }>
}

export async function executeSessionStatus(): Promise<SessionStatusResult> {
    const paths = resolveSessionDaemonPaths()
    const client = new SessionDaemonClient(paths.socketPath)
    const [ping, list] = await Promise.all([client.ping(), client.list()])

    if (!ping?.ok || !list?.ok) {
        return {
            type: 'session_status',
            status: 'stopped',
            socketPath: paths.socketPath,
            keys: [],
        }
    }

    const now = Date.now()

    return {
        type: 'session_status',
        status: 'running',
        socketPath: paths.socketPath,
        startedAt: ping.result.startedAt,
        keys: list.result.keys
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((entry) => ({
                name: entry.name,
                address: entry.address,
                kind: entry.kind,
                expiresAt: entry.expiresAt,
                ttlSeconds: Math.max(0, Math.floor((entry.expiresAt - now) / 1000)),
            })),
    }
}
