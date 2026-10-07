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
    if (/^[A-Za-z0-9.:]{1,128}$/.test(raw)) {
        return raw
    }
    return 'unknown'
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
