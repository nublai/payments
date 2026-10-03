import { SessionDaemonClient } from './session-daemon-client'
import { parseSessionName } from './session-common'

export class SessionLockError extends Error {
    code: 'DAEMON_UNAVAILABLE' | 'SESSION_LOCK_FAILED'

    constructor(code: SessionLockError['code'], message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'SessionLockError'
        this.code = code
        this.cause = options?.cause
    }
}

export type SessionLockResult = {
    type: 'session_lock'
    status: 'complete'
    ok: true
    name: string
}

export async function executeSessionLock(input: {
    sessionName: string
}): Promise<SessionLockResult> {
    const sessionName = parseSessionName(input.sessionName)
    const client = new SessionDaemonClient()
    const response = await client.remove(sessionName)

    if (response === null) {
        throw new SessionLockError(
            'DAEMON_UNAVAILABLE',
            'Session daemon is not running. Run `tw daemon start` first.',
        )
    }

    if (!response.ok) {
        throw new SessionLockError('SESSION_LOCK_FAILED', response.error.message)
    }

    return {
        type: 'session_lock',
        status: 'complete',
        ok: true,
        name: sessionName,
    }
}
