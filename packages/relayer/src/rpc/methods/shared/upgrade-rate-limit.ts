import type { RpcContext } from '../../types'
import type { Env } from '../../../types/env'
import { logger } from '../../../lib/logger'
import { RpcError, RATE_LIMITED, SERVICE_UNAVAILABLE } from '../../errors'
import { getSignerPool } from './signer-pool'

export type UpgradeRateKind = 'prepare' | 'upgrade'

export interface RateBucket {
    key: string
    limit: number
    windowSeconds: number
}

const ACCOUNT_WINDOW_SECONDS = 10 * 60
const GLOBAL_WINDOW_SECONDS = 10 * 60

/**
 * Per-account caps stop a single EOA from being retried into a gas drain.
 * The IP and global caps bound an authenticated caller who rotates accounts.
 * Anonymous callers never reach this: upgrade methods always require auth.
 */
const LIMITS: Record<UpgradeRateKind, { account: number; ip: number; global: number }> = {
    prepare: { account: 10, ip: 120, global: 120 },
    upgrade: { account: 5, ip: 120, global: 120 },
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
}): RateBucket[] {
    const limits = LIMITS[input.kind]
    const account = input.account.toLowerCase()
    return [
        {
            key: `${input.kind}:account:${input.chainId}:${account}`,
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

/**
 * Fixed-window counter. Rejects without incrementing when any bucket is full.
 * `store` maps rateWindowId -> hits and is updated only when the call is allowed.
 */
export function consumeRateLimit(
    store: Map<string, number>,
    buckets: RateBucket[],
    nowSeconds: number,
): { allowed: boolean } {
    const windows = buckets.map((bucket) => {
        const windowStart = rateWindowStart(nowSeconds, bucket.windowSeconds)
        return {
            bucket,
            id: rateWindowId(bucket.key, windowStart),
        }
    })

    for (const window of windows) {
        const hits = store.get(window.id) ?? 0
        if (hits >= window.bucket.limit) {
            return { allowed: false }
        }
    }

    for (const window of windows) {
        store.set(window.id, (store.get(window.id) ?? 0) + 1)
    }

    return { allowed: true }
}

export function upgradeClientIp(request: Request | undefined): string {
    const raw = request?.headers.get('cf-connecting-ip')?.trim() ?? ''
    if (/^[A-Za-z0-9.:]{1,128}$/.test(raw)) {
        return raw
    }
    return 'unknown'
}

export async function enforceUpgradeRateLimit(
    env: Env,
    chainId: number,
    ctx: RpcContext,
    input: { kind: UpgradeRateKind; account: string },
): Promise<void> {
    const ip = upgradeClientIp(ctx.request)
    const pool = getSignerPool(env, chainId)

    let response: Response
    try {
        response = await pool.fetch(`http://do/upgrade-rate-limit?poolName=pool-${chainId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                kind: input.kind,
                chainId,
                account: input.account,
                ip,
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

    const result = (await response.json()) as { allowed?: boolean }
    if (result.allowed !== true) {
        throw new RpcError(RATE_LIMITED, 'Upgrade rate limit exceeded')
    }
}
