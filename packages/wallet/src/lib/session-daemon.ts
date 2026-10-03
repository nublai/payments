import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { getAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { isRecord } from './type-guards'
import {
    DAEMON_ERROR_CODES,
    normalizeSessionName,
    parseDaemonRequest,
    type DaemonErrorCode,
    type DaemonRequest,
    type DaemonResponse,
} from './session-daemon-protocol'
import {
    ensureSessionDaemonStateDir,
    readPidFromFile,
    resolveSessionDaemonPaths,
    type SessionDaemonPaths,
} from './session-daemon-paths'

const REQUEST_MAX_BYTES = 256 * 1024
const KEY_SWEEP_INTERVAL_MS = 30_000

type StoredKey = {
    privateKey: Buffer
    address: Address
    expiresAt: number
    kind?: string
    encryptionDevice?: Buffer
}

export type RunningSessionDaemon = {
    pid: number
    socketPath: string
    stop: () => Promise<void>
    /** Resolves when stop() is called. Await this to keep the process alive in foreground mode. */
    untilStopped: Promise<void>
}

function isErrnoCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === code
    )
}

async function unlinkIfExists(path: string): Promise<void> {
    try {
        await unlink(path)
    } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) {
            return
        }
        throw error
    }
}

async function readPid(path: string): Promise<number | undefined> {
    const pid = await readPidFromFile(path)
    if (pid !== undefined) {
        return pid
    }
    await unlinkIfExists(path)
    return undefined
}

function buildError(id: string, code: DaemonErrorCode, message: string): DaemonResponse {
    return {
        id,
        error: { code, message },
    }
}

function getLiveSessionOrWriteError(
    keyStore: Map<string, StoredKey>,
    sessionName: string,
    now: number,
    requestId: string,
    writeResponse: (response: DaemonResponse) => void,
): StoredKey | null {
    const entry = keyStore.get(sessionName)
    if (!entry) {
        writeResponse(
            buildError(
                requestId,
                DAEMON_ERROR_CODES.SESSION_NOT_FOUND,
                `Session not loaded: ${sessionName}`,
            ),
        )
        return null
    }
    if (entry.expiresAt <= now) {
        entry.privateKey.fill(0)
        entry.encryptionDevice?.fill(0)
        keyStore.delete(sessionName)
        writeResponse(
            buildError(
                requestId,
                DAEMON_ERROR_CODES.SESSION_EXPIRED,
                `Session expired: ${sessionName}`,
            ),
        )
        return null
    }
    return entry
}

function assertPrivateKeyHex(value: string): Hex {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error('privateKey must be a 32-byte hex string')
    }
    return value as Hex
}

function assertHexBytes(value: string): Hex {
    if (!/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
        throw new Error('message must be a hex string')
    }
    return value as Hex
}

function getNowMs(): number {
    return Date.now()
}

export async function runSessionDaemon(options?: {
    paths?: SessionDaemonPaths
    onReady?: (state: { pid: number; socketPath: string }) => Promise<void> | void
}): Promise<RunningSessionDaemon> {
    const startedAt = getNowMs()
    const paths = options?.paths ?? resolveSessionDaemonPaths()
    await ensureSessionDaemonStateDir(paths.stateDir)

    const existingPid = await readPid(paths.pidPath)
    if (existingPid !== undefined) {
        try {
            process.kill(existingPid, 0)
            throw new Error(`Session daemon already running with pid ${existingPid}`)
        } catch (error) {
            if (!isErrnoCode(error, 'ESRCH')) {
                throw error
            }
        }
    }

    const keyStore = new Map<string, StoredKey>()
    const sockets = new Set<net.Socket>()
    const sweepTimer = setInterval(() => {
        const now = getNowMs()
        for (const [name, key] of keyStore.entries()) {
            if (key.expiresAt <= now) {
                key.privateKey.fill(0)
                key.encryptionDevice?.fill(0)
                keyStore.delete(name)
            }
        }
    }, KEY_SWEEP_INTERVAL_MS)
    sweepTimer.unref()

    const server = net.createServer((socket) => {
        sockets.add(socket)
        socket.setEncoding('utf8')
        let buffer = ''
        let chain = Promise.resolve()

        const writeResponse = (response: DaemonResponse) => {
            socket.write(`${JSON.stringify(response)}\n`)
        }

        socket.on('data', (chunk: string) => {
            buffer += chunk
            if (Buffer.byteLength(buffer, 'utf8') > REQUEST_MAX_BYTES) {
                socket.destroy()
                return
            }
            for (;;) {
                const newlineIdx = buffer.indexOf('\n')
                if (newlineIdx === -1) {
                    break
                }
                const line = buffer.slice(0, newlineIdx)
                buffer = buffer.slice(newlineIdx + 1)

                chain = chain.then(async () => {
                    if (Buffer.byteLength(line, 'utf8') > REQUEST_MAX_BYTES) {
                        writeResponse(
                            buildError(
                                randomUUID(),
                                DAEMON_ERROR_CODES.INVALID_REQUEST,
                                'Request exceeds 256KB limit',
                            ),
                        )
                        return
                    }

                    let requestId: string = randomUUID()
                    try {
                        const pre = JSON.parse(line) as unknown
                        if (isRecord(pre) && typeof pre.id === 'string') {
                            requestId = pre.id
                        }
                    } catch {
                        /* use random requestId */
                    }

                    let request: DaemonRequest
                    try {
                        request = parseDaemonRequest(line)
                    } catch (error) {
                        debugDaemon('Invalid request payload', {
                            linePreview: line.slice(0, 200),
                            error: error instanceof Error ? error.message : String(error),
                        })
                        writeResponse(
                            buildError(
                                requestId,
                                DAEMON_ERROR_CODES.INVALID_REQUEST,
                                'Invalid JSON payload',
                            ),
                        )
                        return
                    }

                    try {
                        switch (request.method) {
                            case 'ping': {
                                writeResponse({
                                    id: request.id,
                                    result: {
                                        ok: true,
                                        startedAt,
                                    },
                                })
                                return
                            }
                            case 'list': {
                                writeResponse({
                                    id: request.id,
                                    result: {
                                        startedAt,
                                        keys: Array.from(keyStore.entries()).map(
                                            ([name, entry]) => ({
                                                name,
                                                kind: entry.kind,
                                                address: entry.address,
                                                expiresAt: entry.expiresAt,
                                            }),
                                        ),
                                    },
                                })
                                return
                            }
                            case 'loadKey': {
                                const name = normalizeSessionName(request.params.name)
                                if (!name) {
                                    writeResponse(
                                        buildError(
                                            request.id,
                                            DAEMON_ERROR_CODES.INVALID_REQUEST,
                                            'Session name is required',
                                        ),
                                    )
                                    return
                                }
                                if (
                                    !Number.isFinite(request.params.durationSeconds) ||
                                    request.params.durationSeconds <= 0
                                ) {
                                    writeResponse(
                                        buildError(
                                            request.id,
                                            DAEMON_ERROR_CODES.INVALID_REQUEST,
                                            'durationSeconds must be positive',
                                        ),
                                    )
                                    return
                                }

                                let privateKeyHex: Hex
                                let messageAddress: Address
                                try {
                                    privateKeyHex = assertPrivateKeyHex(request.params.privateKey)
                                    messageAddress = getAddress(request.params.address)
                                } catch (error) {
                                    writeResponse(
                                        buildError(
                                            request.id,
                                            DAEMON_ERROR_CODES.INVALID_REQUEST,
                                            error instanceof Error
                                                ? error.message
                                                : 'Invalid key input',
                                        ),
                                    )
                                    return
                                }

                                const account = privateKeyToAccount(privateKeyHex)
                                if (getAddress(account.address) !== messageAddress) {
                                    writeResponse(
                                        buildError(
                                            request.id,
                                            DAEMON_ERROR_CODES.INVALID_REQUEST,
                                            'Session key address mismatch',
                                        ),
                                    )
                                    return
                                }

                                const existing = keyStore.get(name)
                                if (existing) {
                                    existing.privateKey.fill(0)
                                    existing.encryptionDevice?.fill(0)
                                }

                                const keyBuffer = Buffer.from(privateKeyHex.slice(2), 'hex')
                                let encryptionDevice: Buffer | undefined
                                if (request.params.encryptionDevice !== undefined) {
                                    const encryptionDeviceHex = assertHexBytes(
                                        request.params.encryptionDevice,
                                    )
                                    encryptionDevice = Buffer.from(
                                        encryptionDeviceHex.slice(2),
                                        'hex',
                                    )
                                }
                                const expiresAt = getNowMs() + request.params.durationSeconds * 1000
                                keyStore.set(name, {
                                    privateKey: keyBuffer,
                                    address: messageAddress,
                                    expiresAt,
                                    kind: request.params.kind,
                                    encryptionDevice,
                                })

                                writeResponse({
                                    id: request.id,
                                    result: {
                                        name,
                                        address: messageAddress,
                                        expiresAt,
                                    },
                                })
                                return
                            }
                            case 'getSessionSecrets': {
                                const sessionName = normalizeSessionName(request.params.sessionName)
                                const now = getNowMs()
                                const entry = getLiveSessionOrWriteError(
                                    keyStore,
                                    sessionName,
                                    now,
                                    request.id,
                                    writeResponse,
                                )
                                if (!entry) {
                                    return
                                }
                                writeResponse({
                                    id: request.id,
                                    result: {
                                        name: sessionName,
                                        privateKey: `0x${entry.privateKey.toString('hex')}`,
                                        address: entry.address,
                                        expiresAt: entry.expiresAt,
                                        ...(entry.encryptionDevice
                                            ? {
                                                  encryptionDevice: `0x${entry.encryptionDevice.toString('hex')}`,
                                              }
                                            : {}),
                                    },
                                })
                                return
                            }
                            case 'remove': {
                                const sessionName = normalizeSessionName(request.params.sessionName)
                                const existing = keyStore.get(sessionName)
                                if (existing) {
                                    existing.privateKey.fill(0)
                                    existing.encryptionDevice?.fill(0)
                                    keyStore.delete(sessionName)
                                }
                                writeResponse({ id: request.id, result: { ok: true } })
                                return
                            }
                            case 'sign': {
                                const sessionName = normalizeSessionName(request.params.sessionName)
                                const now = getNowMs()
                                const entry = getLiveSessionOrWriteError(
                                    keyStore,
                                    sessionName,
                                    now,
                                    request.id,
                                    writeResponse,
                                )
                                if (!entry) {
                                    return
                                }
                                const privateKey = `0x${entry.privateKey.toString('hex')}` as Hex
                                const account = privateKeyToAccount(privateKey)
                                const signature = await account.signTypedData(
                                    request.params.typedData,
                                )
                                writeResponse({ id: request.id, result: { signature } })
                                return
                            }
                            case 'signMessage': {
                                const sessionName = normalizeSessionName(request.params.sessionName)
                                const now = getNowMs()
                                const entry = getLiveSessionOrWriteError(
                                    keyStore,
                                    sessionName,
                                    now,
                                    request.id,
                                    writeResponse,
                                )
                                if (!entry) {
                                    return
                                }
                                const privateKey = `0x${entry.privateKey.toString('hex')}` as Hex
                                const account = privateKeyToAccount(privateKey)
                                const messageHex = assertHexBytes(request.params.message)
                                const signature = await account.signMessage({
                                    message: { raw: Buffer.from(messageHex.slice(2), 'hex') },
                                })
                                writeResponse({ id: request.id, result: { signature } })
                                return
                            }
                        }
                    } catch (error) {
                        debugDaemon('Method error', {
                            method: request.method,
                            id: request.id,
                            error: error instanceof Error ? error.message : String(error),
                        })
                        writeResponse(
                            buildError(
                                request.id,
                                DAEMON_ERROR_CODES.INTERNAL_ERROR,
                                error instanceof Error ? error.message : 'Internal daemon error',
                            ),
                        )
                    }
                })
            }
        })

        socket.on('close', () => {
            sockets.delete(socket)
        })

        socket.on('error', (error) => {
            debugDaemon('Socket error', {
                socketPath: paths.socketPath,
                message: error.message,
            })
            sockets.delete(socket)
        })
    })

    let shuttingDown = false
    let handleSignal: ((signal: NodeJS.Signals) => void) | undefined
    let resolveUntilStopped: () => void
    const untilStopped = new Promise<void>((resolve) => {
        resolveUntilStopped = resolve
    })

    const stop = async () => {
        if (shuttingDown) {
            return
        }
        shuttingDown = true

        try {
            await new Promise<void>((resolve) => {
                server.close(() => resolve())
                setTimeout(() => resolve(), 2_000).unref()
            })

            clearInterval(sweepTimer)

            for (const entry of keyStore.values()) {
                entry.privateKey.fill(0)
                entry.encryptionDevice?.fill(0)
            }
            keyStore.clear()

            for (const socket of sockets) {
                socket.destroy()
            }
            sockets.clear()

            await unlinkIfExists(paths.socketPath)
            await unlinkIfExists(paths.pidPath)
            if (handleSignal) {
                process.removeListener('SIGTERM', handleSignal)
                process.removeListener('SIGINT', handleSignal)
            }
        } catch (error) {
            debugDaemon('Stop cleanup error', {
                error: error instanceof Error ? error.message : String(error),
            })
        } finally {
            resolveUntilStopped()
        }
    }

    await unlinkIfExists(paths.socketPath)

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(paths.socketPath, () => {
            server.off('error', reject)
            resolve()
        })
    })

    await writeFile(paths.pidPath, `${process.pid}\n`, { flag: 'wx' })

    handleSignal = (signal: NodeJS.Signals) => {
        void (async () => {
            try {
                await stop()
            } catch (error) {
                debugDaemon('Stop failed during signal shutdown', {
                    signal,
                    error: error instanceof Error ? error.message : String(error),
                })
            } finally {
                if (handleSignal) {
                    process.removeListener('SIGTERM', handleSignal)
                    process.removeListener('SIGINT', handleSignal)
                }
                process.exit(signal === 'SIGINT' ? 130 : 0)
            }
        })()
    }

    process.on('SIGTERM', handleSignal)
    process.on('SIGINT', handleSignal)

    await options?.onReady?.({ pid: process.pid, socketPath: paths.socketPath })

    return {
        pid: process.pid,
        socketPath: paths.socketPath,
        stop,
        untilStopped,
    }
}

export async function runSessionDaemonEntry(keepStdio = false): Promise<RunningSessionDaemon> {
    return runSessionDaemon({
        onReady: keepStdio
            ? async () => {
                  process.stdout.write('ready\n')
              }
            : async () => {
                  process.stdout.write('ready\n')
                  await Promise.resolve()
                  process.stdout.destroy()
                  process.stderr.destroy()
              },
    })
}

function debugDaemon(message: string, details?: unknown): void {
    if (process.env.TW_DAEMON_DEBUG !== '1') {
        return
    }
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
    console.error(`[tw daemon] ${message}${suffix}`)
}
