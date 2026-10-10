import type { Call } from '@nubl/relayer-client'
import { getAddress, type Address, type Hex } from 'viem'
import { type EnvName } from './network-config'
import { isRecord } from './type-guards'

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
                version?: string
                solverChainId?: string
                solver?: string
                salt?: string
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

async function parseRelayResponse(response: Response): Promise<unknown> {
    const text = await response.text()

    if (!text) {
        return {}
    }

    try {
        return JSON.parse(text) as unknown
    } catch (error) {
        throw new RelayLinkError('INVALID_RESPONSE', 'relay.link returned invalid JSON.', {
            statusCode: response.status,
            details: error,
        })
    }
}

function getErrorMessage(payload: unknown, fallback: string): string {
    if (isRecord(payload) && typeof payload.message === 'string' && payload.message) {
        return payload.message
    }

    return fallback
}

async function postJson<TRequest, TResponse>(
    path: string,
    body: TRequest,
    deps: RelayLinkDeps,
): Promise<TResponse> {
    const response = await deps.fetch(`${deps.baseUrl}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: createTimeoutSignal(),
    })

    const payload = await readRelayPayload(response)

    return payload as TResponse
}

function assertNoRedirect(response: Response): void {
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new RelayLinkError('API_ERROR', 'relay.link redirected the request. Refusing to follow it.', {
            statusCode: response.status,
        })
    }
}

async function readRelayPayload(response: Response): Promise<unknown> {
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

async function getJson<TResponse>(
    path: string,
    searchParams: Record<string, string>,
    deps: RelayLinkDeps,
): Promise<TResponse> {
    const url = new URL(`${deps.baseUrl}${path}`)

    for (const [key, value] of Object.entries(searchParams)) {
        url.searchParams.set(key, value)
    }

    const response = await deps.fetch(url.toString(), {
        redirect: 'error',
        signal: createTimeoutSignal(),
    })

    return (await readRelayPayload(response)) as TResponse
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
    if (!isRecord(value)) {
        throw new RelayLinkError('INVALID_RESPONSE', 'relay.link returned an invalid step item.')
    }

    const data = isRecord(value.data) ? value.data : {}
    const check = isRecord(value.check) ? value.check : undefined
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

    if (typeof data.to !== 'string' || data.to.length === 0) {
        throw new RelayLinkError(
            'INVALID_RESPONSE',
            'relay.link returned an invalid to address in a step item.',
        )
    }

    let to: Address

    try {
        to = getAddress(data.to)
    } catch (error) {
        throw new RelayLinkError(
            'INVALID_RESPONSE',
            'relay.link returned an invalid to address in a step item.',
            { details: error },
        )
    }

    return {
        status: normalizeStepItemStatus(value.status),
        data: {
            to,
            data: calldata,
            value: valueString,
            chainId,
        },
        check:
            check && typeof check.endpoint === 'string' && typeof check.method === 'string'
                ? { endpoint: check.endpoint, method: check.method }
                : undefined,
    }
}

function normalizeStep(value: unknown): RelayStep {
    if (!isRecord(value) || !Array.isArray(value.items)) {
        throw new RelayLinkError('INVALID_RESPONSE', 'relay.link returned an invalid step.')
    }

    return {
        id: String(value.id ?? ''),
        action: typeof value.action === 'string' ? value.action : undefined,
        kind: typeof value.kind === 'string' ? value.kind : 'transaction',
        requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        items: value.items.map(normalizeStepItem),
    }
}

function normalizeQuoteResponse(payload: unknown): RelayQuoteResponse {
    if (!isRecord(payload) || !Array.isArray(payload.steps)) {
        throw new RelayLinkError('INVALID_RESPONSE', 'relay.link returned an invalid quote.')
    }

    return {
        requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
        steps: payload.steps.map(normalizeStep),
        fees: isRecord(payload.fees)
            ? (payload.fees as Record<string, RelayCurrencyAmount | undefined>)
            : undefined,
        details: isRecord(payload.details)
            ? (payload.details as RelayQuoteResponse['details'])
            : undefined,
        protocol: normalizeProtocol(payload.protocol),
    }
}

function normalizeProtocol(value: unknown): RelayQuoteResponse['protocol'] {
    if (!isRecord(value) || !isRecord(value.v2)) return undefined
    const orderData = value.v2.orderData

    return {
        v2: {
            orderId: typeof value.v2.orderId === 'string' ? value.v2.orderId : undefined,
            orderData: isRecord(orderData) ? orderData : undefined,
        },
    }
}

function normalizeIntentStatus(payload: unknown): RelayIntentStatus {
    if (!isRecord(payload) || typeof payload.status !== 'string') {
        throw new RelayLinkError(
            'INVALID_RESPONSE',
            'relay.link returned an invalid intent status response.',
        )
    }

    return {
        status: payload.status,
        requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
        txHashes: Array.isArray(payload.txHashes) ? (payload.txHashes as Hex[]) : undefined,
        inTxHashes: Array.isArray(payload.inTxHashes) ? (payload.inTxHashes as Hex[]) : undefined,
        details: payload.details,
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
    const payload = await postJson<RelayQuoteRequest, unknown>('/quote/v2', request, deps)
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
    const payload = await getJson<unknown>('/intents/status/v3', { requestId }, deps)

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
