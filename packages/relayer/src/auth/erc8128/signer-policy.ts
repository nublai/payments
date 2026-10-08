import { isAddress, type Address } from 'viem'

import { unwrapParams } from '../../lib/rpc-utils'
import { isLocalDevContext } from '../../config/runtime-context'
import { parseAuthProtectedMethods } from '../policy'

const BOUND_METHODS = new Set([
    'wallet_prepareCalls',
    'wallet_sendPreparedCalls',
    'wallet_prepareUpgradeAccount',
    'wallet_upgradeAccount',
])

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

/**
 * Account a prepare/send call claims. `authSigner` and `session_key` are not
 * included: those fields are whatever the client wrote, and they are not proof.
 */
export interface BoundAccount {
    eoa?: Address
    chainId?: number
}

/**
 * `accounts === null` means the body has no prepare/send/upgrade call to bind.
 * An empty list means a bindable call was present but named no account.
 * `otherProtectedMethods` are protected methods in the same HTTP body that are
 * not bound. Those require the allowlist; a binding does not cover them.
 */
export interface Erc8128Binding {
    accounts: BoundAccount[] | null
    otherProtectedMethods: string[]
}

export type SignerDecision =
    | { ok: true }
    | { ok: false; message: string; tryOnChain: boolean }

export function parseChainId(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        return value
    }

    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    const hex = /^0x[0-9a-fA-F]+$/.test(trimmed)
    const dec = /^[0-9]+$/.test(trimmed)

    if (!hex && !dec) return undefined
    const parsed = Number.parseInt(trimmed, hex ? 16 : 10)

    if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined

    return parsed
}

export function decideErc8128Signer(args: {
    env: { CONTEXT?: string; ERC8128_ALLOWED_SIGNERS?: string }
    signer: Address
    binding: Erc8128Binding
}): SignerDecision {
    const parsed = parseErc8128Allowlist(args.env.ERC8128_ALLOWED_SIGNERS)

    if (parsed.invalid.length > 0) {
        return {
            ok: false,
            tryOnChain: false,
            message: 'ERC8128_ALLOWED_SIGNERS contains an invalid address',
        }
    }

    if (!isAddress(args.signer)) {
        return { ok: false, tryOnChain: false, message: 'ERC-8128 signer is not an address' }
    }

    const signer = args.signer.toLowerCase()

    if (parsed.addresses.has(signer)) {
        return { ok: true }
    }

    // Local with no allowlist stays open so dev.sh and local scenarios keep working.
    if (isLocalDevContext(args.env) && parsed.addresses.size === 0) {
        return { ok: true }
    }

    if (args.binding.otherProtectedMethods.length > 0) {
        return {
            ok: false,
            tryOnChain: false,
            message: 'ERC-8128 signer must be allowlisted for this method',
        }
    }

    const accounts = args.binding.accounts

    if (!accounts || accounts.length === 0) {
        return {
            ok: false,
            tryOnChain: false,
            message: 'ERC-8128 signer is not allowlisted and is not bound to the intent account',
        }
    }

    if (accounts.every((account) => account.eoa?.toLowerCase() === signer)) {
        return { ok: true }
    }

    return {
        ok: false,
        tryOnChain: accounts.every((account) => !!account.eoa),
        message: 'ERC-8128 signer is not allowlisted and is not bound to the intent account',
    }
}

/**
 * Allowlist, intent EOA, or an on-chain key of that account.
 * A client-supplied `authSigner` / `session_key` is not consulted.
 */
export async function authorizeErc8128Signer(args: {
    env: { CONTEXT?: string; ERC8128_ALLOWED_SIGNERS?: string }
    signer: Address
    binding: Erc8128Binding
    isAccountKey: (account: Address, chainId: number, signer: Address) => Promise<boolean>
}): Promise<{ ok: true } | { ok: false; message: string }> {
    const decision = decideErc8128Signer(args)

    if (decision.ok || !decision.tryOnChain) return decision

    const accounts = args.binding.accounts ?? []
    const signer = args.signer.toLowerCase()

    for (const account of accounts) {
        if (account.eoa?.toLowerCase() === signer) continue

        if (!account.eoa || account.chainId === undefined) {
            return {
                ok: false,
                message:
                    'ERC-8128 signer is not allowlisted and is not an on-chain key of the intent account',
            }
        }

        const onChain = await args.isAccountKey(account.eoa, account.chainId, args.signer)

        if (!onChain) {
            return {
                ok: false,
                message:
                    'ERC-8128 signer is not allowlisted and is not an on-chain key of the intent account',
            }
        }
    }

    return { ok: true }
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
        const record = item as { chainId?: unknown; intent?: { eoa?: unknown } }
        const eoa = asAddress(record.intent?.eoa)

        // Ignore quote.authSigner. It is client-controlled until the HMAC, and even then
        // it is only a hint. Authorization uses the EOA or an on-chain key.
        if (!eoa) return null
        accounts.push({ eoa, chainId: parseChainId(record.chainId) })
    }

    return accounts
}

function accountsFromPrepare(params: Record<string, unknown> | undefined): BoundAccount[] | null {
    const eoa = asAddress(params?.from)

    // Ignore session_key. Decoding it only echoes an address the client chose.
    if (!eoa) return null

    return [{ eoa, chainId: parseChainId(params?.chain_id) }]
}

function accountsFromUpgrade(
    method: string,
    params: Record<string, unknown> | undefined,
): BoundAccount[] | null {
    const source = method === 'wallet_upgradeAccount' ? params?.context : params

    if (!source || typeof source !== 'object') return null
    const record = source as { address?: unknown; chainId?: unknown }
    const eoa = asAddress(record.address)

    if (!eoa) return null

    return [{ eoa, chainId: parseChainId(record.chainId) }]
}

/**
 * Accounts a signed HTTP request claims to act for, plus any other protected
 * methods in the same JSON-RPC batch. Auth is one decision for the whole body.
 */
export function bindingFromRpcBody(
    body: unknown,
    protectedMethods: ReadonlySet<string> = parseAuthProtectedMethods(undefined),
): Erc8128Binding {
    const items = Array.isArray(body) ? body : [body]
    const accounts: BoundAccount[] = []
    const otherProtectedMethods: string[] = []
    let sawBindable = false

    for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const record = item as { method?: unknown; params?: unknown }

        if (typeof record.method !== 'string') continue

        if (protectedMethods.has(record.method) && !BOUND_METHODS.has(record.method)) {
            otherProtectedMethods.push(record.method)
        }

        if (!BOUND_METHODS.has(record.method)) continue
        sawBindable = true
        const params = unwrapParams<Record<string, unknown>>(record.params)

        const extracted =
            record.method === 'wallet_prepareCalls'
                ? accountsFromPrepare(params)
                : record.method === 'wallet_sendPreparedCalls'
                  ? accountsFromSend(params)
                  : accountsFromUpgrade(record.method, params)

        if (!extracted) return { accounts: [], otherProtectedMethods }
        accounts.push(...extracted)
    }

    return { accounts: sawBindable ? accounts : null, otherProtectedMethods }
}
