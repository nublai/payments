import { isAddress, type Address } from 'viem'

import { unwrapParams } from '../../lib/rpc-utils'
import { sessionAddressFromEncodedKey } from '../../lib/session-address'
import { isLocalDevContext } from '../../config/runtime-context'

export interface AllowlistParse {
    addresses: Set<string>
    invalid: string[]
}

export function parseErc8128Allowlist(value: string | undefined): AllowlistParse {
    const addresses = new Set<string>()
    const invalid: string[] = []
    if (!value) return { addresses, invalid }

    for (const part of value.split(',')) {
        const trimmed = part.trim()
        if (!trimmed) continue
        if (!isAddress(trimmed)) {
            invalid.push(trimmed)
            continue
        }
        addresses.add(trimmed.toLowerCase())
    }
    return { addresses, invalid }
}

export interface BoundAccount {
    eoa?: Address
    authSigner?: Address
}

/**
 * `accounts === null` means the body has no prepare/send call to bind.
 * An empty list means a bindable call was present but named no account.
 */
export interface Erc8128Binding {
    accounts: BoundAccount[] | null
}

export function decideErc8128Signer(args: {
    env: { CONTEXT?: string; ERC8128_ALLOWED_SIGNERS?: string }
    signer: Address
    binding: Erc8128Binding
}): { ok: true } | { ok: false; message: string } {
    const parsed = parseErc8128Allowlist(args.env.ERC8128_ALLOWED_SIGNERS)
    if (parsed.invalid.length > 0) {
        return {
            ok: false,
            message: 'ERC8128_ALLOWED_SIGNERS contains an invalid address',
        }
    }
    if (!isAddress(args.signer)) {
        return { ok: false, message: 'ERC-8128 signer is not an address' }
    }

    const signer = args.signer.toLowerCase()
    if (parsed.addresses.has(signer)) {
        return { ok: true }
    }

    // Local with no allowlist stays open so dev.sh and local scenarios keep working.
    if (isLocalDevContext(args.env) && parsed.addresses.size === 0) {
        return { ok: true }
    }

    const accounts = args.binding.accounts
    if (
        accounts &&
        accounts.length > 0 &&
        accounts.every((account) => accountAuthorizes(account, signer))
    ) {
        return { ok: true }
    }

    return {
        ok: false,
        message: 'ERC-8128 signer is not allowlisted and is not bound to the intent account',
    }
}

function accountAuthorizes(account: BoundAccount, signer: string): boolean {
    if (account.eoa && account.eoa.toLowerCase() === signer) return true
    if (account.authSigner && account.authSigner.toLowerCase() === signer) return true
    return false
}

function asAddress(value: unknown): Address | undefined {
    if (typeof value === 'string' && isAddress(value)) return value
    return undefined
}

function accountsFromSend(params: Record<string, unknown> | undefined): BoundAccount[] | null {
    const context = params?.context
    if (!context || typeof context !== 'object') return null
    const quote = (context as { quote?: { quotes?: unknown } }).quote
    if (!quote || !Array.isArray(quote.quotes) || quote.quotes.length === 0) return null

    const accounts: BoundAccount[] = []
    for (const item of quote.quotes) {
        if (!item || typeof item !== 'object') return null
        const record = item as { intent?: { eoa?: unknown }; authSigner?: unknown }
        const account: BoundAccount = {
            eoa: asAddress(record.intent?.eoa),
            authSigner: asAddress(record.authSigner),
        }
        if (!account.eoa && !account.authSigner) return null
        accounts.push(account)
    }
    return accounts
}

function accountsFromPrepare(params: Record<string, unknown> | undefined): BoundAccount[] | null {
    const eoa = asAddress(params?.from)
    const authSigner = sessionAddressFromEncodedKey(
        typeof params?.session_key === 'string' ? params.session_key : undefined,
    )
    if (!eoa && !authSigner) return null
    return [{ eoa, authSigner }]
}

/**
 * Accounts a signed HTTP request claims to act for.
 * The quote HMAC (checked on send) is what makes these fields authentic.
 */
export function bindingFromRpcBody(body: unknown): Erc8128Binding {
    const items = Array.isArray(body) ? body : [body]
    const accounts: BoundAccount[] = []
    let sawBindable = false

    for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const record = item as { method?: unknown; params?: unknown }
        if (
            record.method !== 'wallet_sendPreparedCalls' &&
            record.method !== 'wallet_prepareCalls'
        ) {
            continue
        }
        sawBindable = true
        const params = unwrapParams<Record<string, unknown>>(record.params)
        const extracted =
            record.method === 'wallet_prepareCalls'
                ? accountsFromPrepare(params)
                : accountsFromSend(params)
        if (!extracted) return { accounts: [] }
        accounts.push(...extracted)
    }

    return { accounts: sawBindable ? accounts : null }
}
