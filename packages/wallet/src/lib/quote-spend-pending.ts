import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem'
import type { EnvName } from './network-config'
import {
    quoteSpendRestoreCalls,
    type QuoteSpendSlot,
} from './quote-spend'
import type { SwapCallGrant } from './swap-session'

export const PENDING_QUOTE_LIMIT_VERSION = 1

export type PendingQuoteLimitRecord = {
    version: typeof PENDING_QUOTE_LIMIT_VERSION
    account: Address
    keyHash: Hex
    chainId: number
    env: EnvName
    rpcUrl: string
    relayerUrl: string
    slots: Array<{
        token: Address
        previousLimit: string | null
        installedLimit: string
    }>
    /**
     * canExecute rows this quote added. Missing on records written before
     * grants were tracked. Release and crash recovery revoke each one.
     * A grant the key already had is not recorded here.
     */
    callGrants?: Array<{ target: Address; selector: Hex }>
    /**
     * Key expiry this quote installed. Missing on older records, and when the
     * key already expired sooner than the quote window. Release restores
     * `previous` only when the on-chain key still matches `installed`, the
     * stored permissions, and the stored limits. `0` means the key did not expire.
     * Permissions and limits are the full post-install sets. Older records omit them.
     */
    keyExpiry?: {
        previous: string
        installed: string
        keyType: number
        isSuperAdmin: boolean
        publicKey: Hex
        permissions?: Array<{ target: Address; selector: Hex }>
        limits?: Array<{ token: Address; period: number; limit: string }>
    }
}

export function pendingQuoteLimitPath(keystorePath: string): string {
    return `${keystorePath}.pending-quote-limit.json`
}

export async function pendingQuoteLimitExists(keystorePath: string): Promise<boolean> {
    try {
        await access(pendingQuoteLimitPath(keystorePath))
        return true
    } catch {
        return false
    }
}

export async function readPendingQuoteLimit(
    keystorePath: string,
): Promise<PendingQuoteLimitRecord | undefined> {
    const path = pendingQuoteLimitPath(keystorePath)
    let text: string
    try {
        text = await readFile(path, 'utf8')
    } catch (error) {
        if (isEnoent(error)) return undefined
        throw error
    }
    const parsed = JSON.parse(text) as PendingQuoteLimitRecord
    if (parsed.version !== PENDING_QUOTE_LIMIT_VERSION) {
        throw new Error(`Unsupported pending quote limit at ${path}.`)
    }
    if (!isAddress(parsed.account) || !Array.isArray(parsed.slots)) {
        throw new Error(`Pending quote limit at ${path} is incomplete.`)
    }
    if (parsed.callGrants !== undefined && !Array.isArray(parsed.callGrants)) {
        throw new Error(`Pending quote limit at ${path} has invalid call grants.`)
    }
    for (const grant of parsed.callGrants ?? []) {
        if (!isAddress(grant.target) || !isHex(grant.selector) || grant.selector.length !== 10) {
            throw new Error(`Pending quote limit at ${path} has an invalid call grant.`)
        }
    }
    if (parsed.keyExpiry !== undefined) {
        const expiry = parsed.keyExpiry
        if (
            typeof expiry.previous !== 'string' ||
            typeof expiry.installed !== 'string' ||
            !/^\d+$/.test(expiry.previous) ||
            !/^\d+$/.test(expiry.installed) ||
            typeof expiry.keyType !== 'number' ||
            typeof expiry.isSuperAdmin !== 'boolean' ||
            !isHex(expiry.publicKey)
        ) {
            throw new Error(`Pending quote limit at ${path} has an invalid key expiry.`)
        }
        if (expiry.permissions !== undefined && !Array.isArray(expiry.permissions)) {
            throw new Error(`Pending quote limit at ${path} has invalid key permissions.`)
        }
        for (const permission of expiry.permissions ?? []) {
            if (
                !isAddress(permission.target) ||
                !isHex(permission.selector) ||
                permission.selector.length !== 10
            ) {
                throw new Error(`Pending quote limit at ${path} has an invalid key permission.`)
            }
        }
        if (expiry.limits !== undefined && !Array.isArray(expiry.limits)) {
            throw new Error(`Pending quote limit at ${path} has invalid key limits.`)
        }
        for (const limit of expiry.limits ?? []) {
            if (
                !isAddress(limit.token) ||
                typeof limit.period !== 'number' ||
                !Number.isInteger(limit.period) ||
                typeof limit.limit !== 'string' ||
                !/^\d+$/.test(limit.limit)
            ) {
                throw new Error(`Pending quote limit at ${path} has an invalid key limit.`)
            }
        }
    }
    return parsed
}

export async function writePendingQuoteLimit(
    keystorePath: string,
    record: PendingQuoteLimitRecord,
): Promise<void> {
    const path = pendingQuoteLimitPath(keystorePath)
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    await rename(temporary, path)
}

export async function clearPendingQuoteLimit(keystorePath: string): Promise<void> {
    try {
        await unlink(pendingQuoteLimitPath(keystorePath))
    } catch (error) {
        if (isEnoent(error)) return
        throw error
    }
}

export function pendingRecordFromSlots(input: {
    account: Address
    keyHash: Hex
    chainId: number
    env: EnvName
    rpcUrl: string
    relayerUrl: string
    slots: readonly QuoteSpendSlot[]
    callGrants?: readonly SwapCallGrant[]
    keyExpiry?: PendingQuoteLimitRecord['keyExpiry']
}): PendingQuoteLimitRecord {
    return {
        version: PENDING_QUOTE_LIMIT_VERSION,
        account: getAddress(input.account),
        keyHash: input.keyHash,
        chainId: input.chainId,
        env: input.env,
        rpcUrl: input.rpcUrl,
        relayerUrl: input.relayerUrl,
        slots: input.slots.map((slot) => ({
            token: getAddress(slot.token),
            previousLimit: slot.previousLimit === null ? null : slot.previousLimit.toString(),
            installedLimit: slot.installedLimit.toString(),
        })),
        callGrants: (input.callGrants ?? []).map((grant) => ({
            target: getAddress(grant.target),
            selector: grant.selector,
        })),
        ...(input.keyExpiry ? { keyExpiry: input.keyExpiry } : {}),
    }
}

export function grantsFromPending(record: PendingQuoteLimitRecord): SwapCallGrant[] {
    return (record.callGrants ?? []).map((grant) => ({
        target: getAddress(grant.target),
        selector: grant.selector,
    }))
}

export function slotsFromPending(record: PendingQuoteLimitRecord): QuoteSpendSlot[] {
    return record.slots.map((slot) => ({
        token: getAddress(slot.token),
        previousLimit: slot.previousLimit === null ? null : BigInt(slot.previousLimit),
        installedLimit: BigInt(slot.installedLimit),
    }))
}

/**
 * Calls that put the key back, given what the chain's minute slot is now.
 * A limit we never landed is left alone. A pre-existing minute limit is set
 * back. A minute period this quote added is removed.
 */
export function restoreCallsForChain(input: {
    record: PendingQuoteLimitRecord
    minuteLimits: ReadonlyMap<string, bigint | null>
}): { calls: ReturnType<typeof quoteSpendRestoreCalls>; unexpected: string | undefined } {
    const slots: { token: Address; previousLimit: bigint | null }[] = []
    for (const slot of slotsFromPending(input.record)) {
        const current = input.minuteLimits.get(slot.token.toLowerCase()) ?? null
        if (current === slot.installedLimit) {
            slots.push({ token: slot.token, previousLimit: slot.previousLimit })
            continue
        }
        const alreadyRestored =
            (slot.previousLimit === null && current === null) ||
            (slot.previousLimit !== null && current === slot.previousLimit)
        if (alreadyRestored) continue
        return {
            calls: [],
            unexpected: `minute limit for ${slot.token} is ${current?.toString() ?? 'unset'}, not the quote limit ${slot.installedLimit.toString()} or the previous limit ${slot.previousLimit?.toString() ?? 'unset'}`,
        }
    }
    return {
        calls: quoteSpendRestoreCalls({
            keyHash: input.record.keyHash,
            account: input.record.account,
            slots,
        }),
        unexpected: undefined,
    }
}

function isEnoent(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
    )
}
