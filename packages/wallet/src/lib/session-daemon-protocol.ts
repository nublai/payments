import type { PrepareCallsResponse } from '@nubl/relayer-client'
import { z } from 'incur'
import type { Address, Hex } from 'viem'
import type { EnvName } from './network-config'
import { isRecord } from './type-guards'

const jsonObjectSchema = z.object({}).passthrough()

const daemonIdSchema = z.object({ id: z.string() }).passthrough()

const daemonMethodSchema = z.object({ method: z.string() }).passthrough()

const daemonParamsSchema = z.object({ params: jsonObjectSchema }).passthrough()

const signParamsSchema = z
    .object({
        sessionName: z.string(),
    })
    .passthrough()

const signTypedDataSchema = z
    .object({
        typedData: jsonObjectSchema,
    })
    .passthrough()

const signMessageParamsSchema = z
    .object({
        sessionName: z.string(),
        message: z.string(),
    })
    .passthrough()

const loadKeyParamsSchema = z
    .object({
        name: z.string(),
        privateKey: z.string(),
        address: z.string(),
        durationSeconds: z.number(),
        kind: z.string().optional(),
        encryptionDevice: z.string().optional(),
        phraseConfirmed: z.boolean().optional(),
        swapSession: z.boolean().optional(),
        env: z.enum(['dev', 'stage', 'prod']).optional(),
    })
    .passthrough()

const sessionNameParamsSchema = z
    .object({
        sessionName: z.string(),
    })
    .passthrough()

const daemonErrorFieldsSchema = z
    .object({
        code: z.string(),
        message: z.string(),
    })
    .passthrough()

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

/** A record the parse site already proved with `isRecord`. */
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

export function encodeTypedDataBigInt(typedData: DaemonTypedData): TypedDataJson {
    return mapTypedDataBigInt(typedData, false)
}

export function decodeTypedDataBigInt(value: ParsedTypedDataRecord): DaemonTypedData {
    reviveTypedDataInPlace(value)

    // SAFETY: parseDaemonRequest only proves typedData is a record; this function revives `$bigint:` tags. The swap path reviews the payload. The phrase-less path allows only Orchestrator intents. The phrase-confirmed path refuses anything that is not primaryType 'Intent' with typesMatch, refuses a custom EIP712Domain, and checks domain.chainId (number or bigint, in the env's chains) and verifyingContract against that chain's Orchestrator before signTypedData.
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
    const parsed: unknown = JSON.parse(raw)

    if (!jsonObjectSchema.safeParse(parsed).success || !daemonMethodSchema.safeParse(parsed).success) {
        throw new Error('Invalid daemon request payload')
    }

    const withId = daemonIdSchema.safeParse(parsed)

    if (!withId.success) {
        throw new Error('Invalid daemon request id')
    }

    // SAFETY: method and id schemas accepted parsed as an object with those strings.
    const envelope = parsed as { method: string; id: string; params?: unknown }
    const method = envelope.method
    const id = envelope.id

    if (!isKnownDaemonMethod(method)) {
        throw new Error(`Unknown daemon method: ${String(method)}`)
    }

    if (!daemonParamsSchema.safeParse(parsed).success) {
        throw new Error('Invalid daemon request params')
    }

    const params = envelope.params

    switch (method) {
        case 'ping':
        case 'list':
            return {
                id,
                method,
                params: {},
            }
        case 'sign': {
            if (!signParamsSchema.safeParse(params).success) {
                throw new Error('Invalid sign params.sessionName')
            }

            if (!signTypedDataSchema.safeParse(params).success) {
                throw new Error('Invalid sign params.typedData')
            }

            // SAFETY: sign schemas accepted sessionName as a string and typedData as an object.
            // Revive walks the original parse so an own __proto__ key is included.
            const signParams = params as { sessionName: string; typedData: ParsedTypedDataRecord }

            return {
                id,
                method: 'sign',
                params: {
                    sessionName: signParams.sessionName,
                    typedData: decodeTypedDataBigInt(signParams.typedData),
                },
            }
        }

        case 'signMessage': {
            const signMessage = signMessageParamsSchema.safeParse(params)

            if (!signMessage.success) {
                throw new Error('Invalid signMessage params')
            }

            return {
                id,
                method: 'signMessage',
                params: {
                    sessionName: signMessage.data.sessionName,
                    message: signMessage.data.message as Hex,
                },
            }
        }

        case 'loadKey': {
            const loadKey = loadKeyParamsSchema.safeParse(params)

            if (!loadKey.success) {
                throw new Error('Invalid loadKey params')
            }

            return {
                id,
                method: 'loadKey',
                params: {
                    name: loadKey.data.name,
                    privateKey: loadKey.data.privateKey as Hex,
                    address: loadKey.data.address as Address,
                    durationSeconds: loadKey.data.durationSeconds,
                    kind: loadKey.data.kind,
                    encryptionDevice: loadKey.data.encryptionDevice as Hex | undefined,
                    phraseConfirmed: loadKey.data.phraseConfirmed,
                    swapSession: loadKey.data.swapSession,
                    env: loadKey.data.env,
                },
            }
        }

        case 'getSessionSecrets': {
            const getSecrets = sessionNameParamsSchema.safeParse(params)

            if (!getSecrets.success) {
                throw new Error('Invalid getSessionSecrets params.sessionName')
            }

            return {
                id,
                method: 'getSessionSecrets',
                params: {
                    sessionName: getSecrets.data.sessionName,
                },
            }
        }

        case 'remove': {
            const remove = sessionNameParamsSchema.safeParse(params)

            if (!remove.success) {
                throw new Error('Invalid remove params.sessionName')
            }

            return {
                id,
                method: 'remove',
                params: {
                    sessionName: remove.data.sessionName,
                },
            }
        }

        default: {
            const _: never = method
            throw new Error(`Unhandled daemon method: ${String(method)}`)
        }
    }
}

export function parseDaemonResponse(raw: string): DaemonResponse {
    const parsed: unknown = JSON.parse(raw)

    if (!jsonObjectSchema.safeParse(parsed).success) {
        throw new Error('Invalid daemon response payload')
    }

    const withId = daemonIdSchema.safeParse(parsed)

    if (!withId.success) {
        throw new Error('Invalid daemon response id')
    }

    // SAFETY: id schema accepted parsed as an object with a string id.
    const envelope = parsed as { id: string; error?: unknown; result?: unknown }

    if ('error' in envelope) {
        if (!jsonObjectSchema.safeParse(envelope.error).success) {
            throw new Error('Invalid daemon response error')
        }

        const errorFields = daemonErrorFieldsSchema.safeParse(envelope.error)

        if (!errorFields.success) {
            throw new Error('Invalid daemon response error payload')
        }

        const code = errorFields.data.code
        const message = errorFields.data.message

        if (!Object.values(DAEMON_ERROR_CODES).includes(code as DaemonErrorCode)) {
            throw new Error(`Unknown daemon response error code: ${code}`)
        }

        return {
            id: envelope.id,
            error: {
                code: code as DaemonErrorCode,
                message,
            },
        }
    }

    return {
        id: envelope.id,
        result: envelope.result,
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
