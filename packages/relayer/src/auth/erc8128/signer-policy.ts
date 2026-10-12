import { isAddress, type Address } from 'viem'
import { z } from 'zod'

import { unwrapParams } from '../../lib/rpc-utils'
import { isLocalDevContext } from '../../config/runtime-context'
import { parseAuthProtectedMethods } from '../policy'

const integerChainIdSchema = z.number().refine((value) => Number.isInteger(value) && value > 0)

const rpcItemSchema = z
    .object({
        method: z.string(),
        params: z.unknown().optional(),
    })
    .passthrough()

const sendContextSchema = z
    .object({
        quote: z
            .object({
                quotes: z.array(z.unknown()),
            })
            .passthrough(),
    })
    .passthrough()

const quoteItemSchema = z
    .object({
        intent: z.unknown().optional(),
        chainId: z.unknown().optional(),
    })
    .passthrough()

const intentEoaSchema = z
    .object({
        eoa: z.unknown().optional(),
    })
    .passthrough()

const upgradeSourceSchema = z
    .object({
        address: z.unknown().optional(),
        chainId: z.unknown().optional(),
    })
    .passthrough()

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
    const asNumber = integerChainIdSchema.safeParse(value)

    if (asNumber.success) return asNumber.data

    const asString = z.string().safeParse(value)

    if (!asString.success) return undefined
    const trimmed = asString.data.trim()
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
    const parsed = z.string().safeParse(value)

    if (parsed.success && isAddress(parsed.data)) return parsed.data

    return undefined
}

type RpcBindingParams = {
    from?: unknown
    chain_id?: unknown
    address?: unknown
    chainId?: unknown
    context?: unknown
}

function accountsFromSend(params: RpcBindingParams | undefined): BoundAccount[] | null {
    const context = sendContextSchema.safeParse(params?.context)

    if (!context.success || context.data.quote.quotes.length === 0) return null

    const accounts: BoundAccount[] = []

    for (const item of context.data.quote.quotes) {
        const quote = quoteItemSchema.safeParse(item)

        if (!quote.success) return null

        const intent = intentEoaSchema.safeParse(quote.data.intent)
        const eoa = intent.success ? asAddress(intent.data.eoa) : undefined

        // Ignore quote.authSigner. It is client-controlled until the HMAC, and even then
        // it is only a hint. Authorization uses the EOA or an on-chain key.
        if (!eoa) return null
        accounts.push({
            eoa,
            chainId: Object.hasOwn(quote.data, 'chainId')
                ? parseChainId(quote.data.chainId)
                : undefined,
        })
    }

    return accounts
}

function accountsFromPrepare(params: RpcBindingParams | undefined): BoundAccount[] | null {
    const eoa = asAddress(params?.from)

    // Ignore session_key. Decoding it only echoes an address the client chose.
    if (!eoa) return null

    return [{ eoa, chainId: parseChainId(params?.chain_id) }]
}

function accountsFromUpgrade(
    method: string,
    params: RpcBindingParams | undefined,
): BoundAccount[] | null {
    const source = upgradeSourceSchema.safeParse(
        method === 'wallet_upgradeAccount' ? params?.context : params,
    )

    if (!source.success) return null
    const eoa = Object.hasOwn(source.data, 'address') ? asAddress(source.data.address) : undefined

    if (!eoa) return null

    return [
        {
            eoa,
            chainId: Object.hasOwn(source.data, 'chainId')
                ? parseChainId(source.data.chainId)
                : undefined,
        },
    ]
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
        const record = rpcItemSchema.safeParse(item)

        if (!record.success) continue

        if (protectedMethods.has(record.data.method) && !BOUND_METHODS.has(record.data.method)) {
            otherProtectedMethods.push(record.data.method)
        }

        if (!BOUND_METHODS.has(record.data.method)) continue
        sawBindable = true

        const params = unwrapParams<RpcBindingParams>(record.data.params)

        const extracted =
            record.data.method === 'wallet_prepareCalls'
                ? accountsFromPrepare(params)
                : record.data.method === 'wallet_sendPreparedCalls'
                  ? accountsFromSend(params)
                  : accountsFromUpgrade(record.data.method, params)

        if (!extracted) return { accounts: [], otherProtectedMethods }
        accounts.push(...extracted)
    }

    return { accounts: sawBindable ? accounts : null, otherProtectedMethods }
}
