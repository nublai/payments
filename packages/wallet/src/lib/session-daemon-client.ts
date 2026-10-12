import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { z } from 'incur'
import type { Address, Hex } from 'viem'
import { resolveSessionDaemonPaths } from './session-daemon-paths'
import {
    parseDaemonResponse,
    serializeDaemonRequest,
    type DaemonErrorCode,
    type GetSessionSecretsResult,
    type DaemonRequest,
    type DaemonTypedData,
} from './session-daemon-protocol'

const pingResultSchema = z
    .object({
        ok: z.literal(true),
        startedAt: z.number(),
    })
    .passthrough()

const listResultSchema = z
    .object({
        startedAt: z.number(),
        keys: z.array(z.unknown()),
    })
    .passthrough()

const listKeySchema = z
    .object({
        name: z.string(),
        address: z.string(),
        expiresAt: z.number(),
    })
    .passthrough()

const signatureResultSchema = z
    .object({
        signature: z.string(),
    })
    .passthrough()

const loadKeyResultSchema = z
    .object({
        name: z.string(),
        address: z.string(),
        expiresAt: z.number(),
    })
    .passthrough()

const secretsResultSchema = z
    .object({
        name: z.string(),
        privateKey: z.string(),
        address: z.string(),
        expiresAt: z.number(),
        encryptionDevice: z.string().optional(),
    })
    .passthrough()

const removeResultSchema = z
    .object({
        ok: z.literal(true),
    })
    .passthrough()

const CONNECT_TIMEOUT_MS = 1_500

const REQUEST_TIMEOUT_MS = 10_000

export type SessionDaemonRpcError = {
    code: DaemonErrorCode
    message: string
}

export type SessionDaemonRpcResponse<T> =
    | {
          ok: true
          result: T
      }
    | {
          ok: false
          error: SessionDaemonRpcError
      }
    | null

export type SessionDaemonClientOptions = {
    /**
     * When set, request failures (connect timeout, socket error, invalid response, etc.)
     * are reported here instead of writing raw text to console.error.
     * Callers that use structured stderr (e.g. agent-listen NDJSON) should pass a
     * callback that writes a single JSON line so output stays parseable.
     */
    onRequestFailure?: (method: string, reason: string, details?: unknown) => void
}

export class SessionDaemonClient {
    private socketPath: string
    private onRequestFailure: SessionDaemonClientOptions['onRequestFailure']

    constructor(
        socketPathOrOptions?: string | SessionDaemonClientOptions,
        legacyOptions?: SessionDaemonClientOptions,
    ) {
        if (typeof socketPathOrOptions === 'string') {
            this.socketPath = socketPathOrOptions
            this.onRequestFailure = legacyOptions?.onRequestFailure
        } else if (socketPathOrOptions && typeof socketPathOrOptions === 'object') {
            this.socketPath = resolveSessionDaemonPaths().socketPath
            this.onRequestFailure = socketPathOrOptions.onRequestFailure
        } else {
            this.socketPath = resolveSessionDaemonPaths().socketPath
            this.onRequestFailure = undefined
        }
    }

    async ping(): Promise<SessionDaemonRpcResponse<{ ok: true; startedAt: number }>> {
        const response = await this.request({
            id: randomUUID(),
            method: 'ping',
            params: {},
        })

        if (!response || !response.ok) {
            return response
        }

        const ping = pingResultSchema.safeParse(response.result)

        if (!ping.success) {
            this.logRequestFailure('ping', 'Invalid result payload', response.result)

            return null
        }

        // SAFETY: ping schema accepted this result; return the original so extras and key order stay.
        return { ok: true, result: response.result as { ok: true; startedAt: number } }
    }

    async list(): Promise<
        SessionDaemonRpcResponse<{
            startedAt: number
            keys: Array<{ name: string; kind?: string; address: Address; expiresAt: number }>
        }>
    > {
        const response = await this.request({
            id: randomUUID(),
            method: 'list',
            params: {},
        })

        if (!response || !response.ok) {
            return response
        }

        const list = listResultSchema.safeParse(response.result)

        if (!list.success) {
            this.logRequestFailure('list', 'Invalid result payload', response.result)

            return null
        }

        for (const entry of list.data.keys) {
            const key = listKeySchema.safeParse(entry)

            if (!key.success) {
                this.logRequestFailure('list', 'Invalid key payload', entry)

                return null
            }
        }

        // SAFETY: schemas accepted this result; keep the original keys array so extras and key order stay.
        const original = response.result as {
            startedAt: number
            keys: Array<{ name: string; kind?: string; address: Address; expiresAt: number }>
        }

        return {
            ok: true,
            result: {
                startedAt: original.startedAt,
                keys: original.keys,
            },
        }
    }

    async sign(
        sessionName: string,
        typedData: DaemonTypedData,
    ): Promise<SessionDaemonRpcResponse<Hex>> {
        const response = await this.request<{ signature: Hex }>({
            id: randomUUID(),
            method: 'sign',
            params: { sessionName, typedData },
        })

        if (!response || !response.ok) {
            return response
        }

        const signed = signatureResultSchema.safeParse(response.result)

        if (!signed.success) {
            this.logRequestFailure('sign', 'Invalid result payload', response.result)

            return null
        }

        // SAFETY: signature schema accepted this string.
        return { ok: true, result: signed.data.signature as Hex }
    }

    async signMessage(sessionName: string, message: Hex): Promise<SessionDaemonRpcResponse<Hex>> {
        const response = await this.request<{ signature: Hex }>({
            id: randomUUID(),
            method: 'signMessage',
            params: { sessionName, message },
        })

        if (!response || !response.ok) {
            return response
        }

        const signed = signatureResultSchema.safeParse(response.result)

        if (!signed.success) {
            this.logRequestFailure('signMessage', 'Invalid result payload', response.result)

            return null
        }

        // SAFETY: signature schema accepted this string.
        return { ok: true, result: signed.data.signature as Hex }
    }

    async loadKey(input: {
        name: string
        privateKey: Hex
        address: Address
        durationSeconds: number
        kind?: string
        encryptionDevice?: Hex
        phraseConfirmed?: boolean
        swapSession?: boolean
        env?: 'dev' | 'stage' | 'prod'
    }): Promise<SessionDaemonRpcResponse<{ name: string; address: Address; expiresAt: number }>> {
        const response = await this.request({
            id: randomUUID(),
            method: 'loadKey',
            params: {
                name: input.name,
                privateKey: input.privateKey,
                address: input.address,
                durationSeconds: input.durationSeconds,
                kind: input.kind,
                encryptionDevice: input.encryptionDevice,
                phraseConfirmed: input.phraseConfirmed,
                swapSession: input.swapSession,
                env: input.env,
            },
        })

        if (!response || !response.ok) {
            return response
        }

        const loaded = loadKeyResultSchema.safeParse(response.result)

        if (!loaded.success) {
            this.logRequestFailure('loadKey', 'Invalid result payload', response.result)

            return null
        }

        return {
            ok: true,
            result: {
                name: loaded.data.name,
                // SAFETY: loadKey schema accepted address as a string.
                address: loaded.data.address as Address,
                expiresAt: loaded.data.expiresAt,
            },
        }
    }

    async getSessionSecrets(
        sessionName: string,
    ): Promise<SessionDaemonRpcResponse<GetSessionSecretsResult>> {
        const response = await this.request<GetSessionSecretsResult>({
            id: randomUUID(),
            method: 'getSessionSecrets',
            params: { sessionName },
        })

        if (!response || !response.ok) {
            return response
        }

        const secrets = secretsResultSchema.safeParse(response.result)

        if (!secrets.success) {
            this.logRequestFailure('getSessionSecrets', 'Invalid result payload', response.result)

            return {
                ok: false,
                error: {
                    code: 'INVALID_RESPONSE',
                    message: 'Daemon returned invalid data',
                },
            }
        }

        return {
            ok: true,
            result: {
                name: secrets.data.name,
                // SAFETY: secrets schema accepted privateKey as a string.
                privateKey: secrets.data.privateKey as Hex,
                // SAFETY: secrets schema accepted address as a string.
                address: secrets.data.address as Address,
                expiresAt: secrets.data.expiresAt,
                // SAFETY: secrets schema accepted encryptionDevice as a string when present.
                encryptionDevice: secrets.data.encryptionDevice as Hex | undefined,
            },
        }
    }

    async remove(sessionName: string): Promise<SessionDaemonRpcResponse<{ ok: true }>> {
        const response = await this.request({
            id: randomUUID(),
            method: 'remove',
            params: { sessionName },
        })

        if (!response || !response.ok) {
            return response
        }

        const removed = removeResultSchema.safeParse(response.result)

        if (!removed.success) {
            this.logRequestFailure('remove', 'Invalid result payload', response.result)

            return null
        }

        return { ok: true, result: { ok: true } }
    }

    private async request<T>(request: DaemonRequest): Promise<SessionDaemonRpcResponse<T>> {
        const socket = new net.Socket()
        let buffer = ''

        return new Promise((resolve) => {
            let settled = false

            const done = (value: SessionDaemonRpcResponse<T>) => {
                if (settled) {
                    return
                }

                settled = true
                clearTimeout(connectTimer)
                clearTimeout(requestTimer)
                socket.destroy()
                resolve(value)
            }

            const connectTimer = setTimeout(() => {
                this.logRequestFailure(request.method, 'Connect timeout', {
                    socketPath: this.socketPath,
                })
                done(null)
            }, CONNECT_TIMEOUT_MS)

            let requestTimer: ReturnType<typeof setTimeout> | undefined

            const armRequestTimer = () => {
                requestTimer = setTimeout(() => {
                    this.logRequestFailure(request.method, 'Request timeout', {
                        id: request.id,
                    })
                    done(null)
                }, REQUEST_TIMEOUT_MS)
            }

            socket.on('error', (error) => {
                this.logRequestFailure(request.method, 'Socket error', {
                    message: error.message,
                })
                done(null)
            })

            socket.on('data', (chunk) => {
                buffer += chunk.toString('utf8')
                const newlineIdx = buffer.indexOf('\n')

                if (newlineIdx === -1) {
                    return
                }

                const line = buffer.slice(0, newlineIdx)
                buffer = buffer.slice(newlineIdx + 1)

                try {
                    const response = parseDaemonResponse(line)

                    if (response.id !== request.id) {
                        this.logRequestFailure(request.method, 'Response id mismatch', {
                            expected: request.id,
                            received: response.id,
                        })
                        done(null)

                        return
                    }

                    if ('error' in response && response.error) {
                        done({
                            ok: false,
                            error: response.error,
                        })

                        return
                    }

                    done({ ok: true, result: response.result as T })
                } catch (error) {
                    this.logRequestFailure(request.method, 'Response parse failure', {
                        message: error instanceof Error ? error.message : String(error),
                    })
                    done(null)
                }
            })

            socket.connect(this.socketPath, () => {
                clearTimeout(connectTimer)
                armRequestTimer()

                try {
                    const payload = `${serializeDaemonRequest(request)}\n`
                    socket.write(payload)
                } catch (error) {
                    this.logRequestFailure(request.method, 'Write failure', {
                        message: error instanceof Error ? error.message : String(error),
                    })
                    done(null)
                }
            })
        })
    }

    /** Reports request failure via onRequestFailure when set, else console.error (for CLI callers without structured stderr). */
    private logRequestFailure(method: string, reason: string, details?: unknown): void {
        if (this.onRequestFailure) {
            this.onRequestFailure(method, reason, details)

            return
        }

        const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
        console.error(`[tw daemon client] ${method}: ${reason}${suffix}`)
    }
}
