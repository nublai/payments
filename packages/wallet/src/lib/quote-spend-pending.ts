import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem'
import { z } from 'incur'
import type { EnvName } from './network-config'
import {
    quoteSpendRestoreCalls,
    type QuoteSpendSlot,
} from './quote-spend'
import type { SwapCallGrant } from './swap-session'

export const PENDING_QUOTE_LIMIT_VERSION = 1

const pendingGrantSchema = z
    .object({
        target: z.string(),
        selector: z.string(),
    })
    .passthrough()

const pendingLimitSchema = z
    .object({
        token: z.string(),
        period: z.number().int(),
        limit: z.string().regex(/^\d+$/),
    })
    .passthrough()

const pendingKeyExpiryCoreSchema = z
    .object({
        previous: z.string().regex(/^\d+$/),
        installed: z.string().regex(/^\d+$/),
        keyType: z.number(),
        isSuperAdmin: z.boolean(),
        publicKey: z.string(),
    })
    .passthrough()

const pendingKeyExpiryExtrasSchema = z
    .object({
        permissions: z.unknown().optional(),
        limits: z.unknown().optional(),
    })
    .passthrough()

const pendingQuoteVersionSchema = z.object({ version: z.unknown() }).passthrough()

const pendingQuoteLimitFileSchema = z
    .object({
        version: z.literal(PENDING_QUOTE_LIMIT_VERSION),
        account: z.string(),
        slots: z.array(z.unknown()),
        callGrants: z.unknown().optional(),
        keyExpiry: z.unknown().optional(),
    })
    .passthrough()

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

    const parsed: unknown = JSON.parse(text)
    const versionEnvelope = pendingQuoteVersionSchema.safeParse(parsed)

    if (!versionEnvelope.success) {
        // SAFETY: schema rejected parsed; read .version like main so null throws TypeError.
        const version = (parsed as { version?: unknown }).version

        if (version !== PENDING_QUOTE_LIMIT_VERSION) {
            throw new Error(`Unsupported pending quote limit at ${path}.`)
        }
    } else if (versionEnvelope.data.version !== PENDING_QUOTE_LIMIT_VERSION) {
        throw new Error(`Unsupported pending quote limit at ${path}.`)
    }

    const file = pendingQuoteLimitFileSchema.safeParse(parsed)

    if (!file.success || !isAddress(file.data.account)) {
        throw new Error(`Pending quote limit at ${path} is incomplete.`)
    }

    if (file.data.callGrants !== undefined) {
        const grants = z.array(z.unknown()).safeParse(file.data.callGrants)

        if (!grants.success) {
            throw new Error(`Pending quote limit at ${path} has invalid call grants.`)
        }

        for (const grant of grants.data) {
            const row = pendingGrantSchema.safeParse(grant)

            if (!row.success) {
                // SAFETY: schema rejected grant; read .target like main so null throws TypeError.
                void (grant as { target?: unknown }).target
                throw new Error(`Pending quote limit at ${path} has an invalid call grant.`)
            }

            if (!isAddress(row.data.target) || !isHex(row.data.selector) || row.data.selector.length !== 10) {
                throw new Error(`Pending quote limit at ${path} has an invalid call grant.`)
            }
        }
    }

    if (file.data.keyExpiry !== undefined) {
        const expiry = file.data.keyExpiry
        const core = pendingKeyExpiryCoreSchema.safeParse(expiry)

        if (!core.success) {
            // SAFETY: schema rejected expiry; read .previous like main so null throws TypeError.
            void (expiry as { previous?: unknown }).previous
            throw new Error(`Pending quote limit at ${path} has an invalid key expiry.`)
        }

        if (!isHex(core.data.publicKey)) {
            throw new Error(`Pending quote limit at ${path} has an invalid key expiry.`)
        }

        const extras = pendingKeyExpiryExtrasSchema.safeParse(expiry)

        if (extras.success && extras.data.permissions !== undefined) {
            const permissions = z.array(z.unknown()).safeParse(extras.data.permissions)

            if (!permissions.success) {
                throw new Error(`Pending quote limit at ${path} has invalid key permissions.`)
            }

            for (const permission of permissions.data) {
                const row = pendingGrantSchema.safeParse(permission)

                if (!row.success) {
                    // SAFETY: schema rejected permission; read .target like main so null throws TypeError.
                    void (permission as { target?: unknown }).target
                    throw new Error(`Pending quote limit at ${path} has an invalid key permission.`)
                }

                if (
                    !isAddress(row.data.target) ||
                    !isHex(row.data.selector) ||
                    row.data.selector.length !== 10
                ) {
                    throw new Error(`Pending quote limit at ${path} has an invalid key permission.`)
                }
            }
        }

        if (extras.success && extras.data.limits !== undefined) {
            const limits = z.array(z.unknown()).safeParse(extras.data.limits)

            if (!limits.success) {
                throw new Error(`Pending quote limit at ${path} has invalid key limits.`)
            }

            for (const limit of limits.data) {
                const row = pendingLimitSchema.safeParse(limit)

                if (!row.success) {
                    // SAFETY: schema rejected limit; read .token like main so null throws TypeError.
                    void (limit as { token?: unknown }).token
                    throw new Error(`Pending quote limit at ${path} has an invalid key limit.`)
                }

                if (!isAddress(row.data.token)) {
                    throw new Error(`Pending quote limit at ${path} has an invalid key limit.`)
                }
            }
        }
    }

    // SAFETY: the file passed the same field checks as main; extra keys stay on parsed.
    return parsed as PendingQuoteLimitRecord
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
    const record: PendingQuoteLimitRecord = {
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
    }

    if (input.keyExpiry) {
        record.keyExpiry = input.keyExpiry
    }

    return record
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

type RestoredCallsForChain = {
    calls: ReturnType<typeof quoteSpendRestoreCalls>
    unexpected: string | undefined
}

/**
 * Calls that put the key back, given what the chain's minute slot is now.
 * A limit we never landed is left alone. A pre-existing minute limit is set
 * back. A minute period this quote added is removed.
 */
export function restoreCallsForChain(input: {
    record: PendingQuoteLimitRecord
    minuteLimits: ReadonlyMap<string, bigint | null>
}): RestoredCallsForChain {
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

function isEnoent(error: unknown): error is { code: 'ENOENT' } {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
    )
}
