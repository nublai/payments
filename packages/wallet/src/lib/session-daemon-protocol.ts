import type { PrepareCallsResponse } from '@nubl/relayer-client'
import type { Address, Hex } from 'viem'
import type { EnvName } from './network-config'
import { isRecord } from './type-guards'

export const DAEMON_ERROR_CODES = {
    SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    INVALID_REQUEST: 'INVALID_REQUEST',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    /** Client-only: daemon responded ok but result failed validation. */
    INVALID_RESPONSE: 'INVALID_RESPONSE',
} as const

export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[keyof typeof DAEMON_ERROR_CODES]

export type DaemonTypedData = PrepareCallsResponse['typedData']

export type DaemonRequest =
    | { id: string; method: 'ping'; params: Record<string, never> }
    | { id: string; method: 'list'; params: Record<string, never> }
    | {
          id: string
          method: 'sign'
          params: {
              sessionName: string
              typedData: DaemonTypedData
          }
      }
    | {
          id: string
          method: 'signMessage'
          params: {
              sessionName: string
              message: Hex
          }
      }
    | {
          id: string
          method: 'loadKey'
          params: {
              name: string
              privateKey: Hex
              address: Address
              durationSeconds: number
              kind?: string
              encryptionDevice?: Hex
              /** Recorded by unlock. Sign requests cannot change it. */
              phraseConfirmed?: boolean
              /** Recorded by unlock when the key is a swap session. */
              swapSession?: boolean
              env?: EnvName
          }
      }
    | {
          id: string
          method: 'getSessionSecrets'
          params: {
              sessionName: string
          }
      }
    | {
          id: string
          method: 'remove'
          params: {
              sessionName: string
          }
      }

export type GetSessionSecretsResult = {
    name: string
    privateKey: Hex
    address: Address
    expiresAt: number
    encryptionDevice?: Hex
}

export type DaemonResponse =
    | {
          id: string
          result: unknown
          error?: never
      }
    | {
          id: string
          result?: never
          error: {
              code: DaemonErrorCode
              message: string
          }
      }

export const BIGINT_TAG_PREFIX = '$bigint:'

/** JSON-shaped typed data, plus bigint before encode and after decode. */
export type TypedDataJson =
    | string
    | number
    | boolean
    | bigint
    | null
    | undefined
    | TypedDataJson[]
    | { [key: string]: TypedDataJson }

function mapTypedDataBigInt(value: unknown, revive: boolean): TypedDataJson {
    if (typeof value === 'bigint') {
        return `${BIGINT_TAG_PREFIX}${value.toString()}`
    }

    if (typeof value === 'string' && revive && value.startsWith(BIGINT_TAG_PREFIX)) {
        const raw = value.slice(BIGINT_TAG_PREFIX.length)

        if (/^-?\d+$/.test(raw)) {
            return BigInt(raw)
        }

        return value
    }

    if (Array.isArray(value)) {
        return value.map((entry) => mapTypedDataBigInt(entry, revive))
    }

    if (isRecord(value)) {
        const mapped: { [key: string]: TypedDataJson } = {}

        for (const [key, entry] of Object.entries(value)) {
            mapped[key] = mapTypedDataBigInt(entry, revive)
        }

        return mapped
    }

    // SAFETY: after bigint/array/record, a typed-data node is a JSON leaf.
    return value as string | number | boolean | null | undefined
}

/** The four Intent fields this file reads after `isRecord` at the parse site. */
type ParsedTypedDataRecord = {
    primaryType?: unknown
    domain?: unknown
    types?: unknown
    message?: unknown
}

function reviveTypedDataInPlace(value: ParsedTypedDataRecord): void {
    const nodes: unknown[] = [value]

    while (nodes.length > 0) {
        const node = nodes.pop()

        if (Array.isArray(node)) {
            for (let index = 0; index < node.length; index++) {
                const entry = node[index]

                if (Array.isArray(entry) || isRecord(entry)) {
                    nodes.push(entry)
                } else {
                    node[index] = mapTypedDataBigInt(entry, true)
                }
            }

            continue
        }

        if (!isRecord(node)) {
            continue
        }

        for (const key of Object.keys(node)) {
            const entry = node[key]

            if (Array.isArray(entry) || isRecord(entry)) {
                nodes.push(entry)
            } else {
                node[key] = mapTypedDataBigInt(entry, true)
            }
        }
    }
}

function hasIntentTypedDataKeys(value: ParsedTypedDataRecord): boolean {
    return (
        value.primaryType === 'Intent' &&
        isRecord(value.domain) &&
        isRecord(value.types) &&
        isRecord(value.message)
    )
}

export function encodeTypedDataBigInt(typedData: DaemonTypedData): TypedDataJson {
    return mapTypedDataBigInt(typedData, false)
}

export function decodeTypedDataBigInt(value: ParsedTypedDataRecord): DaemonTypedData {
    if (!hasIntentTypedDataKeys(value)) {
        throw new Error('Invalid daemon typed data')
    }

    reviveTypedDataInPlace(value)

    // SAFETY: only primaryType 'Intent' and object domain/types/message are checked here. Swap sessions go through reviewSwapSessionSignature and phrase-less through assessPhraseLessIntent before signTypedData; a non-swap session with phraseConfirmed signs as-is. viem 2.45.1 local signTypedData throws on an invalid verifyingContract, empty or unknown types, a bad address or uint in the message, and missing message fields; it still signs an empty domain, extra domain keys, a non-string name, a non-numeric chainId string, extra message fields (ignored), and a well-formed types table that is not the Intent schema.
    return value as DaemonTypedData
}

export function normalizeSessionName(name: string): string {
    return name.trim()
}

export function serializeDaemonRequest(request: DaemonRequest): string {
    if (request.method !== 'sign') {
        return JSON.stringify(request)
    }

    return JSON.stringify({
        ...request,
        params: {
            ...request.params,
            typedData: encodeTypedDataBigInt(request.params.typedData),
        },
    })
}

export function parseDaemonRequest(raw: string): DaemonRequest {
    const parsed = JSON.parse(raw) as unknown

    if (!isRecord(parsed) || typeof parsed.method !== 'string') {
        throw new Error('Invalid daemon request payload')
    }

    if (typeof parsed.id !== 'string') {
        throw new Error('Invalid daemon request id')
    }

    if (!isKnownDaemonMethod(parsed.method)) {
        throw new Error(`Unknown daemon method: ${String(parsed.method)}`)
    }

    if (!isRecord(parsed.params)) {
        throw new Error('Invalid daemon request params')
    }

    switch (parsed.method) {
        case 'ping':
        case 'list':
            return {
                id: parsed.id,
                method: parsed.method,
                params: {},
            }
        case 'sign': {
            if (typeof parsed.params.sessionName !== 'string') {
                throw new Error('Invalid sign params.sessionName')
            }

            if (!isRecord(parsed.params.typedData)) {
                throw new Error('Invalid sign params.typedData')
            }

            return {
                id: parsed.id,
                method: 'sign',
                params: {
                    sessionName: parsed.params.sessionName,
                    typedData: decodeTypedDataBigInt(parsed.params.typedData),
                },
            }
        }

        case 'signMessage': {
            if (
                typeof parsed.params.sessionName !== 'string' ||
                typeof parsed.params.message !== 'string'
            ) {
                throw new Error('Invalid signMessage params')
            }

            return {
                id: parsed.id,
                method: 'signMessage',
                params: {
                    sessionName: parsed.params.sessionName,
                    message: parsed.params.message as Hex,
                },
            }
        }

        case 'loadKey': {
            if (
                typeof parsed.params.name !== 'string' ||
                typeof parsed.params.privateKey !== 'string' ||
                typeof parsed.params.address !== 'string' ||
                typeof parsed.params.durationSeconds !== 'number' ||
                (parsed.params.kind !== undefined && typeof parsed.params.kind !== 'string') ||
                (parsed.params.encryptionDevice !== undefined &&
                    typeof parsed.params.encryptionDevice !== 'string') ||
                (parsed.params.phraseConfirmed !== undefined &&
                    typeof parsed.params.phraseConfirmed !== 'boolean') ||
                (parsed.params.swapSession !== undefined &&
                    typeof parsed.params.swapSession !== 'boolean') ||
                (parsed.params.env !== undefined &&
                    parsed.params.env !== 'dev' &&
                    parsed.params.env !== 'stage' &&
                    parsed.params.env !== 'prod')
            ) {
                throw new Error('Invalid loadKey params')
            }

            return {
                id: parsed.id,
                method: 'loadKey',
                params: {
                    name: parsed.params.name,
                    privateKey: parsed.params.privateKey as Hex,
                    address: parsed.params.address as Address,
                    durationSeconds: parsed.params.durationSeconds,
                    kind: parsed.params.kind,
                    encryptionDevice: parsed.params.encryptionDevice as Hex | undefined,
                    phraseConfirmed: parsed.params.phraseConfirmed,
                    swapSession: parsed.params.swapSession,
                    env: parsed.params.env,
                },
            }
        }

        case 'getSessionSecrets': {
            if (typeof parsed.params.sessionName !== 'string') {
                throw new Error('Invalid getSessionSecrets params.sessionName')
            }

            return {
                id: parsed.id,
                method: 'getSessionSecrets',
                params: {
                    sessionName: parsed.params.sessionName,
                },
            }
        }

        case 'remove': {
            if (typeof parsed.params.sessionName !== 'string') {
                throw new Error('Invalid remove params.sessionName')
            }

            return {
                id: parsed.id,
                method: 'remove',
                params: {
                    sessionName: parsed.params.sessionName,
                },
            }
        }

        default: {
            const _: never = parsed.method
            throw new Error(`Unhandled daemon method: ${String(parsed.method)}`)
        }
    }
}

export function parseDaemonResponse(raw: string): DaemonResponse {
    const parsed = JSON.parse(raw) as unknown

    if (!isRecord(parsed)) {
        throw new Error('Invalid daemon response payload')
    }

    if (typeof parsed.id !== 'string') {
        throw new Error('Invalid daemon response id')
    }

    if ('error' in parsed) {
        if (!isRecord(parsed.error)) {
            throw new Error('Invalid daemon response error')
        }

        const code = parsed.error.code
        const message = parsed.error.message

        if (typeof code !== 'string' || typeof message !== 'string') {
            throw new Error('Invalid daemon response error payload')
        }

        if (!Object.values(DAEMON_ERROR_CODES).includes(code as DaemonErrorCode)) {
            throw new Error(`Unknown daemon response error code: ${code}`)
        }

        return {
            id: parsed.id,
            error: {
                code: code as DaemonErrorCode,
                message,
            },
        }
    }

    return {
        id: parsed.id,
        result: parsed.result,
    }
}

export function isKnownDaemonMethod(method: string): method is DaemonRequest['method'] {
    return (
        method === 'ping' ||
        method === 'list' ||
        method === 'sign' ||
        method === 'signMessage' ||
        method === 'loadKey' ||
        method === 'getSessionSecrets' ||
        method === 'remove'
    )
}
