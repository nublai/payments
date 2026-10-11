import type { Call } from '@nubl/relayer-client'
import { z } from 'incur'
import { getAddress, type Address, type Hex } from 'viem'
import { type EnvName } from './network-config'
import { isRecord } from './type-guards'

const errorMessageSchema = z
    .object({
        message: z.string(),
    })
    .passthrough()

const stepItemFieldsSchema = z
    .object({
        status: z.unknown().optional(),
        data: z.unknown().optional(),
        check: z.unknown().optional(),
    })
    .passthrough()

const stepItemDataSchema = z
    .object({
        to: z.unknown().optional(),
        data: z.unknown().optional(),
        value: z.unknown().optional(),
        chainId: z.unknown().optional(),
    })
    .passthrough()

const stepCheckSchema = z
    .object({
        endpoint: z.string(),
        method: z.string(),
    })
    .passthrough()

const stepFieldsSchema = z
    .object({
        items: z.array(z.unknown()),
        id: z.unknown().optional(),
        action: z.unknown().optional(),
        kind: z.unknown().optional(),
        requestId: z.unknown().optional(),
    })
    .passthrough()

const quoteFieldsSchema = z
    .object({
        steps: z.array(z.unknown()),
        requestId: z.unknown().optional(),
        fees: z.unknown().optional(),
        details: z.unknown().optional(),
        protocol: z.unknown().optional(),
    })
    .passthrough()

const protocolV2Schema = z
    .object({
        v2: z
            .object({
                orderId: z.unknown().optional(),
                orderData: z.unknown().optional(),
            })
            .passthrough(),
    })
    .passthrough()

const intentStatusSchema = z
    .object({
        status: z.string(),
        requestId: z.unknown().optional(),
        txHashes: z.unknown().optional(),
        inTxHashes: z.unknown().optional(),
        details: z.unknown().optional(),
    })
    .passthrough()

export type RelayQuoteRequest = {
    user: Address
    recipient?: Address
    originChainId: number
    destinationChainId: number
    originCurrency: Address
    destinationCurrency: Address
    amount: string
    tradeType: 'EXACT_INPUT'
    slippageTolerance: string
}

export type RelayStepItem = {
    status: 'complete' | 'incomplete'
    data: {
        to: Address
        data: Hex
        value: string
        chainId: number
    }
    check?: {
        endpoint: string
        method: string
    }
}

export type RelayStep = {
    id: string
    action?: string
    kind: 'transaction' | 'signature' | string
    requestId?: string
    items: RelayStepItem[]
}

export type RelayCurrencyAmount = {
    amount: string
    amountFormatted?: string
    amountUsd?: string
    minimumAmount?: string
    currency?: {
        symbol?: string
        name?: string
        decimals?: number
        address?: Address
    }
}

export type RelayQuoteResponse = {
    requestId?: string
    steps: RelayStep[]
    fees?: Record<string, RelayCurrencyAmount | undefined>
    details?: {
        operation?: string
        currencyIn?: RelayCurrencyAmount
        currencyOut?: RelayCurrencyAmount
        totalImpact?: { usd?: string; percent?: string }
        rate?: string
        timeEstimate?: number
    }
    protocol?: {
        v2?: {
            orderId?: string
            orderData?: {
                version?: unknown
                solverChainId?: unknown
                solver?: unknown
                salt?: unknown
                inputs?: unknown
                output?: unknown
                fees?: unknown
            }
        }
    }
}

export type RelayIntentStatus = {
    status: string
    requestId?: string
    txHashes?: Hex[]
    inTxHashes?: Hex[]
    details?: unknown
}

export class RelayLinkError extends Error {
    code: 'API_ERROR' | 'INVALID_RESPONSE' | 'MISSING_REQUEST_ID' | 'TIMEOUT'
    statusCode?: number
    details?: unknown

    constructor(
        code: RelayLinkError['code'],
        message: string,
        options?: { statusCode?: number; details?: unknown },
    ) {
        super(message)
        this.name = 'RelayLinkError'
        this.code = code
        this.statusCode = options?.statusCode
        this.details = options?.details
    }
}

type RelayLinkDeps = {
    fetch: typeof fetch
    sleep: (ms: number) => Promise<void>
    baseUrl: string
}

type RelayPollOptions = {
    timeoutMs: number
    intervals: Array<{ untilMs: number; everyMs: number }>
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000

function getDefaultDeps(env: EnvName = 'prod'): RelayLinkDeps {
    return {
        fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        baseUrl: getRelayLinkBaseUrl(env),
    }
}

export function getRelayLinkBaseUrl(env: EnvName): string {
    return env === 'dev' ? 'https://api.testnets.relay.link' : 'https://api.relay.link'
}

export function getRelayIntentStatusUrl(requestId: string, env: EnvName): string {
    const url = new URL('/intents/status/v3', getRelayLinkBaseUrl(env))
    url.searchParams.set('requestId', requestId)

    return url.toString()
}

export function sumQuoteFeeUsd(quote: RelayQuoteResponse): string {
    const values = Object.values(quote.fees ?? {})
        .map((fee) => Number(fee?.amountUsd ?? 0))
        .filter((value) => Number.isFinite(value))

    return values.reduce((total, value) => total + value, 0).toFixed(2)
}

type RelayJson =
    | string
    | number
    | boolean
    | null
    | RelayJson[]
    | { [key: string]: RelayJson }

async function parseRelayResponse(response: Response): Promise<RelayJson> {
    const text = await response.text()

    if (!text) {
        return {}
    }

    try {
        const parsed: unknown = JSON.parse(text)

        // SAFETY: JSON.parse yields a JSON value; RelayJson is that tree.
        return parsed as RelayJson
    } catch (error) {
        throw new RelayLinkError('INVALID_RESPONSE', 'relay.link returned invalid JSON.', {
            statusCode: response.status,
            details: error,
        })
    }
}

function getErrorMessage(payload: RelayJson, fallback: string): string {
    const parsed = errorMessageSchema.safeParse(payload)

    if (parsed.success && parsed.data.message) {
        return parsed.data.message
    }

    return fallback
}

async function postJson<TRequest>(
    path: string,
    body: TRequest,
    deps: RelayLinkDeps,
): Promise<RelayJson> {
    const response = await deps.fetch(`${deps.baseUrl}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: createTimeoutSignal(),
    })

    return await readRelayPayload(response)
}

function assertNoRedirect(response: Response): void {
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new RelayLinkError('API_ERROR', 'relay.link redirected the request. Refusing to follow it.', {
            statusCode: response.status,
        })
    }
}

async function readRelayPayload(response: Response): Promise<RelayJson> {
    assertNoRedirect(response)
    const payload = await parseRelayResponse(response)

    if (!response.ok) {
        throw new RelayLinkError(
            'API_ERROR',
            getErrorMessage(payload, `relay.link request failed with ${response.status}.`),
            {
                statusCode: response.status,
                details: payload,
            },
        )
    }

    return payload
}

async function getJson(
    path: string,
    searchParams: Record<string, string>,
    deps: RelayLinkDeps,
): Promise<RelayJson> {
    const url = new URL(`${deps.baseUrl}${path}`)

    for (const [key, value] of Object.entries(searchParams)) {
        url.searchParams.set(key, value)
    }

    const response = await deps.fetch(url.toString(), {
        redirect: 'error',
        signal: createTimeoutSignal(),
    })

    return await readRelayPayload(response)
}

function createTimeoutSignal(): AbortSignal | undefined {
    if (typeof AbortSignal === 'undefined') {
        return undefined
    }

    if (typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS)
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS)
    controller.signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true })

    return controller.signal
}

function isHexData(value: string): value is Hex {
    return /^0x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0
}

function normalizeStepItemStatus(value: unknown): RelayStepItem['status'] {
    if (value === 'complete' || value === 'incomplete') {
        return value
    }

    throw new RelayLinkError('INVALID_RESPONSE', 'relay.link returned an invalid step status.')
}

function normalizeStepItem(value: unknown): RelayStepItem {
    const item = stepItemFieldsSchema.safeParse(value)

    if (!item.success) {
        throw new RelayLinkError('INVALID_RESPONSE', 'relay.link returned an invalid step item.')
    }

    const dataParsed = stepItemDataSchema.safeParse(item.data.data)
    const data = dataParsed.success ? dataParsed.data : {}
    const check = isRecord(item.data.check) ? item.data.check : undefined
    const calldata = String(data.data ?? '0x')

    if (!isHexData(calldata)) {
        throw new RelayLinkError(
            'INVALID_RESPONSE',
            'relay.link returned invalid calldata in a step item.',
        )
    }

    const valueString = String(data.value ?? '0')

    if (!/^\d+$/.test(valueString)) {
        throw new RelayLinkError(
            'INVALID_RESPONSE',
            'relay.link returned an invalid value in a step item.',
        )
    }

    const chainId = Number(data.chainId ?? 0)

    if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new RelayLinkError(
            'INVALID_RESPONSE',
            'relay.link returned an invalid chainId in a step item.',
        )
    }

    const toField = data.to

    if (typeof toField !== 'string' || toField.length === 0) {
        throw new RelayLinkError(
            'INVALID_RESPONSE',
            'relay.link returned an invalid to address in a step item.',
        )
    }

    let to: Address

    try {
        to = getAddress(toField)
    } catch (error) {
        throw new RelayLinkError(
            'INVALID_RESPONSE',
            'relay.link returned an invalid to address in a step item.',
            { details: error },
        )
    }

    const checkFields = stepCheckSchema.safeParse(check)

    return {
        status: normalizeStepItemStatus(item.data.status),
        data: {
            to,
            data: calldata,
            value: valueString,
            chainId,
        },
        check: checkFields.success
            ? { endpoint: checkFields.data.endpoint, method: checkFields.data.method }
            : undefined,
    }
}

function normalizeStep(value: unknown): RelayStep {
    const step = stepFieldsSchema.safeParse(value)

    if (!step.success) {
        throw new RelayLinkError('INVALID_RESPONSE', 'relay.link returned an invalid step.')
    }

    return {
        id: String(step.data.id ?? ''),
        action: typeof step.data.action === 'string' ? step.data.action : undefined,
        kind: typeof step.data.kind === 'string' ? step.data.kind : 'transaction',
        requestId: typeof step.data.requestId === 'string' ? step.data.requestId : undefined,
        items: step.data.items.map(normalizeStepItem),
    }
}

function normalizeQuoteResponse(payload: RelayJson): RelayQuoteResponse {
    const quote = quoteFieldsSchema.safeParse(payload)

    if (!quote.success) {
        throw new RelayLinkError('INVALID_RESPONSE', 'relay.link returned an invalid quote.')
    }

    return {
        requestId: typeof quote.data.requestId === 'string' ? quote.data.requestId : undefined,
        steps: quote.data.steps.map(normalizeStep),
        // SAFETY: quote schema accepted fees/details as unknown; extras stay on the original objects.
        fees: isRecord(quote.data.fees)
            ? (quote.data.fees as Record<string, RelayCurrencyAmount | undefined>)
            : undefined,
        details: isRecord(quote.data.details)
            ? (quote.data.details as RelayQuoteResponse['details'])
            : undefined,
        protocol: normalizeProtocol(quote.data.protocol),
    }
}

function normalizeProtocol(value: unknown): RelayQuoteResponse['protocol'] {
    const protocol = protocolV2Schema.safeParse(value)

    if (!protocol.success) return undefined

    const v2 = protocol.data.v2

    return {
        v2: {
            orderId: typeof v2.orderId === 'string' ? v2.orderId : undefined,
            // SAFETY: orderData stays on the original v2 object when it is a record.
            orderData: isRecord(v2.orderData)
                ? (v2.orderData as {
                      version?: unknown
                      solverChainId?: unknown
                      solver?: unknown
                      salt?: unknown
                      inputs?: unknown
                      output?: unknown
                      fees?: unknown
                  })
                : undefined,
        },
    }
}

function normalizeIntentStatus(payload: RelayJson): RelayIntentStatus {
    const status = intentStatusSchema.safeParse(payload)

    if (!status.success) {
        throw new RelayLinkError(
            'INVALID_RESPONSE',
            'relay.link returned an invalid intent status response.',
        )
    }

    return {
        status: status.data.status,
        requestId: typeof status.data.requestId === 'string' ? status.data.requestId : undefined,
        txHashes: Array.isArray(status.data.txHashes) ? (status.data.txHashes as Hex[]) : undefined,
        inTxHashes: Array.isArray(status.data.inTxHashes)
            ? (status.data.inTxHashes as Hex[])
            : undefined,
        details: status.data.details,
    }
}

function isTerminalStatus(status: string): boolean {
    return status === 'success' || status === 'failure' || status.startsWith('refund')
}

function getIntervalForElapsed(
    elapsedMs: number,
    intervals: Array<{ untilMs: number; everyMs: number }>,
): number {
    for (const interval of intervals) {
        if (elapsedMs <= interval.untilMs) {
            return interval.everyMs
        }
    }

    return intervals[intervals.length - 1]?.everyMs ?? 1000
}

export function slippagePercentToBps(percent: number): string {
    if (!Number.isFinite(percent) || percent <= 0) {
        throw new Error('Slippage must be a positive percentage value.')
    }

    const bps = Math.round(percent * 100)

    if (bps <= 0) {
        throw new Error('Slippage percentage is too small to represent in basis points.')
    }

    return String(bps)
}

export function stepsToRelayerCalls(steps: RelayStep[]): Call[] {
    return steps
        .filter((step) => step.kind === 'transaction')
        .flatMap((step) =>
            step.items
                .filter((item) => item.status === 'incomplete')
                .map((item) => ({
                    target: item.data.to,
                    value: BigInt(item.data.value),
                    data: item.data.data,
                })),
        )
}

export function extractRequestId(quote: RelayQuoteResponse): string {
    if (quote.requestId) {
        return quote.requestId
    }

    let firstParseError: unknown
    let firstMalformedEndpoint: string | undefined

    for (const step of quote.steps) {
        if (step.requestId) {
            return step.requestId
        }

        for (const item of step.items) {
            const endpoint = item.check?.endpoint

            if (!endpoint) continue

            try {
                const requestId = new URL(endpoint).searchParams.get('requestId')

                if (requestId) {
                    return requestId
                }
            } catch (error) {
                if (firstParseError === undefined) {
                    firstParseError = error
                    firstMalformedEndpoint = endpoint
                }

                continue
            }
        }
    }

    throw new RelayLinkError(
        'MISSING_REQUEST_ID',
        'relay.link quote did not include a requestId for bridge status tracking.',
        firstParseError === undefined
            ? undefined
            : {
                  details: {
                      parseError: firstParseError,
                      endpoint: firstMalformedEndpoint,
                  },
              },
    )
}

export async function getQuote(
    request: RelayQuoteRequest,
    depsArg?: Partial<RelayLinkDeps> & { env?: EnvName },
): Promise<RelayQuoteResponse> {
    const deps = { ...getDefaultDeps(depsArg?.env), ...depsArg }
    const payload = await postJson<RelayQuoteRequest>('/quote/v2', request, deps)
    const quote = normalizeQuoteResponse(payload)

    if (quote.steps.length === 0) {
        throw new RelayLinkError('INVALID_RESPONSE', 'relay.link returned an empty quote.')
    }

    return quote
}

export async function getIntentStatus(
    requestId: string,
    depsArg?: Partial<RelayLinkDeps> & { env?: EnvName },
): Promise<RelayIntentStatus> {
    const deps = { ...getDefaultDeps(depsArg?.env), ...depsArg }
    const payload = await getJson('/intents/status/v3', { requestId }, deps)

    return normalizeIntentStatus(payload)
}

export async function pollIntentStatus(
    requestId: string,
    opts: RelayPollOptions,
    depsArg?: Partial<RelayLinkDeps> & { env?: EnvName },
): Promise<RelayIntentStatus> {
    const deps = { ...getDefaultDeps(depsArg?.env), ...depsArg }
    const startedAt = Date.now()
    let latestStatus = await getIntentStatus(requestId, deps)

    if (isTerminalStatus(latestStatus.status)) {
        return latestStatus
    }

    while (Date.now() - startedAt < opts.timeoutMs) {
        const elapsedMs = Date.now() - startedAt
        await deps.sleep(getIntervalForElapsed(elapsedMs, opts.intervals))
        latestStatus = await getIntentStatus(requestId, deps)

        if (isTerminalStatus(latestStatus.status)) {
            return latestStatus
        }
    }

    throw new RelayLinkError(
        'TIMEOUT',
        `relay.link intent ${requestId} did not reach a terminal state before timeout.`,
        { details: latestStatus },
    )
}
