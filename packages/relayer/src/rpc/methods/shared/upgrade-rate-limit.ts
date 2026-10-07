import type { RpcContext } from '../../types'
import type { Env } from '../../../types/env'
import { logger } from '../../../lib/logger'
import { RpcError, RATE_LIMITED, SERVICE_UNAVAILABLE } from '../../errors'
import { getSignerPool } from './signer-pool'

export type UpgradeRateKind = 'prepare' | 'upgrade'
export type UpgradeRateAction = 'peek' | 'commit' | 'reserve' | 'release'

export interface RateBucket {
    key: string
    limit: number
    windowSeconds: number
}

const ACCOUNT_WINDOW_SECONDS = 10 * 60
const GLOBAL_WINDOW_SECONDS = 10 * 60

/**
 * One authenticated identity may succeed a handful of times per window.
 * The per-IP ceiling stays well below the per-chain ceiling, so one NAT
 * or the shared `unknown` bucket cannot spend the chain budget.
 * Upgrade slots are reserved in the same step that decides to broadcast.
 */
const LIMITS: Record<UpgradeRateKind, { account: number; ip: number; global: number }> = {
    prepare: { account: 10, ip: 400, global: 2_000 },
    upgrade: { account: 5, ip: 100, global: 2_000 },
}

export function rateWindowStart(nowSeconds: number, windowSeconds: number): number {
    return nowSeconds - (nowSeconds % windowSeconds)
}

export function rateWindowId(key: string, windowStart: number): string {
    return `${key}@${windowStart}`
}

export function upgradeRateBuckets(input: {
    kind: UpgradeRateKind
    chainId: number
    account: string
    ip: string
    identity?: string
}): RateBucket[] {
    const limits = LIMITS[input.kind]
    const subject = (input.identity ?? input.account).toLowerCase()
    return [
        {
            key: `${input.kind}:identity:${input.chainId}:${subject}`,
            limit: limits.account,
            windowSeconds: ACCOUNT_WINDOW_SECONDS,
        },
        {
            key: `${input.kind}:ip:${input.chainId}:${input.ip}`,
            limit: limits.ip,
            windowSeconds: GLOBAL_WINDOW_SECONDS,
        },
        {
            key: `${input.kind}:global:${input.chainId}`,
            limit: limits.global,
            windowSeconds: GLOBAL_WINDOW_SECONDS,
        },
    ]
}

function slidingCount(
    store: Map<string, number>,
    key: string,
    nowSeconds: number,
    windowSeconds: number,
): number {
    const earliest = nowSeconds - windowSeconds
    const prefix = `${key}#`
    let total = 0
    for (const [id, hits] of store) {
        if (!id.startsWith(prefix) || !Number.isFinite(hits)) continue
        const timestamp = Number(id.slice(prefix.length))
        if (timestamp > earliest && timestamp <= nowSeconds) total += hits
    }
    return total
}

/**
 * Sliding window. A hit in the last second of a fixed window still counts
 * during the first second of the next one, so the quota cannot be doubled
 * by waiting for the boundary.
 * `store` maps `${key}#${second}` and `${key}@${fixedWindowStart}` to hits.
 */
export function peekRateLimit(
    store: Map<string, number>,
    buckets: RateBucket[],
    nowSeconds: number,
): { allowed: boolean } {
    for (const bucket of buckets) {
        if (slidingCount(store, bucket.key, nowSeconds, bucket.windowSeconds) >= bucket.limit) {
            return { allowed: false }
        }
    }
    return { allowed: true }
}

export function consumeRateLimit(
    store: Map<string, number>,
    buckets: RateBucket[],
    nowSeconds: number,
): { allowed: boolean } {
    if (!peekRateLimit(store, buckets, nowSeconds).allowed) {
        return { allowed: false }
    }

    for (const bucket of buckets) {
        const secondId = `${bucket.key}#${nowSeconds}`
        store.set(secondId, (store.get(secondId) ?? 0) + 1)
        const windowStart = rateWindowStart(nowSeconds, bucket.windowSeconds)
        const windowId = rateWindowId(bucket.key, windowStart)
        store.set(windowId, (store.get(windowId) ?? 0) + 1)
    }

    return { allowed: true }
}

/** Drop one reservation from the same second buckets. Counts do not go below zero. */
export function releaseRateLimit(
    store: Map<string, number>,
    buckets: RateBucket[],
    nowSeconds: number,
): void {
    for (const bucket of buckets) {
        const secondId = `${bucket.key}#${nowSeconds}`
        const next = (store.get(secondId) ?? 0) - 1
        if (next <= 0) store.delete(secondId)
        else store.set(secondId, next)

        const windowStart = rateWindowStart(nowSeconds, bucket.windowSeconds)
        const windowId = rateWindowId(bucket.key, windowStart)
        const windowNext = (store.get(windowId) ?? 0) - 1
        if (windowNext <= 0) store.delete(windowId)
        else store.set(windowId, windowNext)
    }
}

export function upgradeClientIp(request: Request | undefined): string {
    const raw = request?.headers.get('cf-connecting-ip')?.trim() ?? ''
    if (!/^[A-Za-z0-9.:]{1,128}$/.test(raw)) return 'unknown'
    return canonicalUpgradeIp(raw) ?? 'unknown'
}

/**
 * One bucket per IPv4, and one bucket per IPv6 /64. Text form is normalized
 * first: compressed zeros, mixed case, and IPv4-mapped addresses.
 * An IPv4-mapped address buckets as its IPv4.
 */
function canonicalUpgradeIp(raw: string): string | undefined {
    const dotted = parseIpv4(raw)
    if (dotted) return formatIpv4(dotted)

    const bytes = parseIpv6(raw)
    if (!bytes) return undefined
    if (isIpv4Mapped(bytes)) {
        return formatIpv4([bytes[12], bytes[13], bytes[14], bytes[15]])
    }

    for (let index = 8; index < 16; index++) bytes[index] = 0
    return formatIpv6(bytes)
}

function parseIpv4(text: string): [number, number, number, number] | undefined {
    const parts = text.split('.')
    if (parts.length !== 4) return undefined
    const octets: number[] = []
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return undefined
        const value = Number(part)
        if (value > 255) return undefined
        octets.push(value)
    }
    return [octets[0], octets[1], octets[2], octets[3]]
}

function formatIpv4(octets: [number, number, number, number] | number[]): string {
    return `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`
}

function parseIpv6(text: string): Uint8Array | undefined {
    let input = text.toLowerCase()
    if (input.includes('.')) {
        const splitAt = input.lastIndexOf(':')
        if (splitAt < 0) return undefined
        const v4 = parseIpv4(input.slice(splitAt + 1))
        if (!v4) return undefined
        const hi = ((v4[0] << 8) | v4[1]).toString(16)
        const lo = ((v4[2] << 8) | v4[3]).toString(16)
        input = `${input.slice(0, splitAt)}:${hi}:${lo}`
    }

    const halves = input.split('::')
    if (halves.length > 2) return undefined
    const head = halves[0] === '' ? [] : halves[0].split(':')
    const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
    if (halves.length === 1 && head.length !== 8) return undefined
    if (halves.length === 2 && head.length + tail.length > 7) return undefined
    const groups =
        halves.length === 2
            ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
            : head
    if (groups.length !== 8) return undefined

    const bytes = new Uint8Array(16)
    for (let index = 0; index < 8; index++) {
        const group = groups[index]
        if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
        const value = Number.parseInt(group, 16)
        bytes[index * 2] = value >> 8
        bytes[index * 2 + 1] = value & 0xff
    }
    return bytes
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
    for (let index = 0; index < 10; index++) {
        if (bytes[index] !== 0) return false
    }
    return bytes[10] === 0xff && bytes[11] === 0xff
}

function formatIpv6(bytes: Uint8Array): string {
    const groups: string[] = []
    for (let index = 0; index < 8; index++) {
        const value = (bytes[index * 2] << 8) | bytes[index * 2 + 1]
        groups.push(value.toString(16))
    }

    let bestStart = -1
    let bestLength = 0
    let index = 0
    while (index < 8) {
        if (groups[index] !== '0') {
            index++
            continue
        }
        let end = index
        while (end < 8 && groups[end] === '0') end++
        if (end - index > bestLength) {
            bestStart = index
            bestLength = end - index
        }
        index = end
    }

    if (bestLength < 2) return groups.join(':')
    const head = groups.slice(0, bestStart).join(':')
    const tail = groups.slice(bestStart + bestLength).join(':')
    if (head === '' && tail === '') return '::'
    if (head === '') return `::${tail}`
    if (tail === '') return `${head}::`
    return `${head}::${tail}`
}

async function postUpgradeRateLimit(
    env: Env,
    chainId: number,
    ctx: RpcContext,
    input: {
        action: UpgradeRateAction
        kind: UpgradeRateKind
        account: string
        identity: string
        reservedAt?: number
    },
): Promise<{ allowed: boolean; reservedAt?: number }> {
    const ip = upgradeClientIp(ctx.request)
    const pool = getSignerPool(env, chainId)

    let response: Response
    try {
        response = await pool.fetch(`http://do/upgrade-rate-limit?poolName=pool-${chainId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: input.action,
                kind: input.kind,
                chainId,
                account: input.account,
                identity: input.identity,
                ip,
                ...(input.reservedAt !== undefined ? { reservedAt: input.reservedAt } : {}),
            }),
        })
    } catch (error) {
        logger.error({ error, kind: input.kind, chainId }, 'upgrade rate limit unavailable')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Account upgrade failed')
    }

    if (!response.ok) {
        let detail = 'unknown'
        try {
            detail = await response.text()
        } catch {
            detail = 'unreadable rate limit response'
        }
        logger.error({ detail, kind: input.kind, chainId }, 'upgrade rate limit failed')
        throw new RpcError(SERVICE_UNAVAILABLE, 'Account upgrade failed')
    }

    const result = (await response.json()) as { allowed?: boolean; reservedAt?: number }
    return {
        allowed: result.allowed === true,
        reservedAt: typeof result.reservedAt === 'number' ? result.reservedAt : undefined,
    }
}

export async function assertUpgradeRateCapacity(
    env: Env,
    chainId: number,
    ctx: RpcContext,
    input: { kind: UpgradeRateKind; account: string; identity: string },
): Promise<void> {
    const result = await postUpgradeRateLimit(env, chainId, ctx, { ...input, action: 'peek' })
    if (!result.allowed) {
        throw new RpcError(RATE_LIMITED, 'Upgrade rate limit exceeded')
    }
}

/**
 * Take the identity, IP, and global slots together. The caller broadcasts
 * only after this returns. `reservedAt` is the second those slots occupy.
 */
export async function reserveUpgradeRateLimit(
    env: Env,
    chainId: number,
    ctx: RpcContext,
    input: { kind: UpgradeRateKind; account: string; identity: string },
): Promise<number> {
    const result = await postUpgradeRateLimit(env, chainId, ctx, { ...input, action: 'reserve' })
    if (!result.allowed) {
        throw new RpcError(RATE_LIMITED, 'Upgrade rate limit exceeded')
    }
    return result.reservedAt ?? Math.floor(Date.now() / 1000)
}

/** Give back a reservation that never reached eth_sendRawTransaction. */
export async function releaseUpgradeRateLimit(
    env: Env,
    chainId: number,
    ctx: RpcContext,
    input: { kind: UpgradeRateKind; account: string; identity: string; reservedAt: number },
): Promise<void> {
    try {
        await postUpgradeRateLimit(env, chainId, ctx, { ...input, action: 'release' })
    } catch (error) {
        logger.error({ error, kind: input.kind, chainId }, 'upgrade rate limit release failed')
    }
}

export async function recordUpgradeRateLimit(
    env: Env,
    chainId: number,
    ctx: RpcContext,
    input: { kind: UpgradeRateKind; account: string; identity: string },
): Promise<void> {
    try {
        const result = await postUpgradeRateLimit(env, chainId, ctx, {
            ...input,
            action: 'commit',
        })
        if (!result.allowed) {
            logger.warn({ kind: input.kind, chainId }, 'upgrade rate limit commit rejected')
        }
    } catch (error) {
        logger.error({ error, kind: input.kind, chainId }, 'upgrade rate limit commit failed')
    }
}
