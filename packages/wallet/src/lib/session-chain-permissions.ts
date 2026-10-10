import { createPublicClient, getAddress, http, type Address, type Hex, type PublicClient } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import { getAddressesWithFallback } from '@nubl/contracts/deployments'
import { ERC20_SELECTORS, getChain } from '@nubl/relayer-client'
import {
    getChainNameByChainId,
    getUsdcTokenConfig,
    type EnvName,
} from './network-config'

/** GuardedExecutor wildcard key. Packed calls and checkers here apply to every key. */
export const ANY_KEYHASH =
    '0x3232323232323232323232323232323232323232323232323232323232323232' as Hex

const ESCROW_ESCROW_SELECTOR = '0x657061bf'

const ESCROW_REFUND_SELECTOR = '0x6023fda5'

const ESCROW_SETTLE_SELECTOR = '0xe7f921a2'

const SIMPLE_SETTLER_WRITE_SELECTOR = '0x84523a30'

const SPEND_PERIODS = ['minute', 'hour', 'day', 'week', 'month', 'year', 'forever'] as const

export type ChainPermission = {
    type: string
    to?: string
    selector?: string
    token?: string
    limit?: string
    period?: string
}

export type ChainKeyView = {
    hash: string
    expiry: string
    permissions: ChainPermission[]
}

export type GuardCleanup = {
    anyCalls: { target: Address; selector: Hex }[]
    checkers: { keyHash: Hex; target: Address }[]
}

export type SessionChainGuard = {
    /** Undefined when this chain's getKeys succeeded and the session key is not authorized. */
    key: ChainKeyView | undefined
    anyCalls: ChainPermission[]
    /** Call checkers for the session key plus ANY_KEYHASH. Any checker is elevated. */
    checkerCount: number
}

type PackedCanExecute = { target: Address; selector: Hex }

function decodePackedCanExecute(packed: Hex): PackedCanExecute {
    const value = BigInt(packed)
    const target = getAddress(`0x${(value >> 96n).toString(16).padStart(40, '0')}`)
    const selector = `0x${(value & 0xffffffffn).toString(16).padStart(8, '0')}` as Hex

    return { target, selector }
}

function chainClient(rpcUrl: string, chainId: number): PublicClient {
    return createPublicClient({
        chain: getChain(chainId, rpcUrl),
        transport: http(rpcUrl, { timeout: 10_000 }),
        batch: { multicall: false },
    })
}

function spendPeriodName(period: number): string {
    const name = SPEND_PERIODS[period]

    if (!name) {
        throw new Error(`Unreadable spend period ${period}`)
    }

    return name
}

/** USDC transfer and approve, plus escrow and settler calls when those addresses are known. */
export function narrowCallAllowlist(env: EnvName, chainId: number): Set<string> {
    const allowed = new Set<string>()

    const add = (target: string, selector: string) => {
        allowed.add(`${target.toLowerCase()}:${selector.toLowerCase()}`)
    }

    const chain = getChainNameByChainId(chainId)

    if (chain) {
        const usdc = getUsdcTokenConfig(chain).address
        add(usdc, ERC20_SELECTORS.TRANSFER)
        add(usdc, ERC20_SELECTORS.APPROVE)
    }

    const addresses = getAddressesWithFallback(env, chainId)

    if (addresses?.escrow) {
        add(addresses.escrow, ESCROW_ESCROW_SELECTOR)
        add(addresses.escrow, ESCROW_REFUND_SELECTOR)
        add(addresses.escrow, ESCROW_SETTLE_SELECTOR)
    }

    if (addresses?.simpleSettler) {
        add(addresses.simpleSettler, SIMPLE_SETTLER_WRITE_SELECTOR)
    }

    return allowed
}

/**
 * Session keys and their spend and call permissions, read from the account
 * contract over the wallet's own RPC. Throws when the RPC or the view calls fail.
 */
export async function readAccountKeysFromChain(input: {
    rpcUrl: string
    chainId: number
    account: Address
}): Promise<ChainKeyView[]> {
    const client = chainClient(input.rpcUrl, input.chainId)

    const keysResult = await client.readContract({
        address: input.account,
        abi: accountAbi,
        functionName: 'getKeys',
    })

    const keys = keysResult[0]
    const keyHashes = keysResult[1]

    if (keys.length === 0) return []

    const infos = await client.readContract({
        address: input.account,
        abi: accountAbi,
        functionName: 'spendAndExecuteInfos',
        args: [keyHashes],
    })

    const spends = infos[0]
    const executes = infos[1]

    if (spends.length !== keys.length || executes.length !== keys.length) {
        throw new Error('Permission lookup did not return an entry for every key')
    }

    return keys.map((key, index) => {
        const permissions: ChainPermission[] = []

        for (const packed of executes[index]!) {
            const decoded = decodePackedCanExecute(packed)
            permissions.push({
                type: 'call',
                to: decoded.target,
                selector: decoded.selector,
            })
        }

        for (const spend of spends[index]!) {
            permissions.push({
                type: 'spend',
                token: spend.token,
                period: spendPeriodName(Number(spend.period)),
                limit: spend.limit.toString(),
            })
        }

        return {
            hash: keyHashes[index]!,
            expiry: key.expiry.toString(),
            permissions,
        }
    })
}

/**
 * One chain's session key, the ANY_KEYHASH call list, and call checkers.
 * Throws when any view fails. Call checkers are enumerated by `callCheckerInfos`;
 * a checker is an arbitrary contract, so a non-empty list cannot be proven narrow.
 */
export async function readSessionChainGuard(input: {
    rpcUrl: string
    chainId: number
    account: Address
    keyHash: Hex
}): Promise<SessionChainGuard> {
    const client = chainClient(input.rpcUrl, input.chainId)

    const keys = await readAccountKeysFromChain({
        rpcUrl: input.rpcUrl,
        chainId: input.chainId,
        account: input.account,
    })

    const key = keys.find((entry) => entry.hash.toLowerCase() === input.keyHash.toLowerCase())

    const anyPacked = await client.readContract({
        address: input.account,
        abi: accountAbi,
        functionName: 'canExecutePackedInfos',
        args: [ANY_KEYHASH],
    })

    const anyCalls: ChainPermission[] = anyPacked.map((packed) => {
        const decoded = decodePackedCanExecute(packed)

        return { type: 'call', to: decoded.target, selector: decoded.selector }
    })

    const hashes = key ? [input.keyHash, ANY_KEYHASH] : [ANY_KEYHASH]
    let checkerCount = 0

    for (const hash of hashes) {
        const infos = await client.readContract({
            address: input.account,
            abi: accountAbi,
            functionName: 'callCheckerInfos',
            args: [hash],
        })

        checkerCount += infos.filter((info) => info.checker !== '0x0000000000000000000000000000000000000000').length
    }

    return { key, anyCalls, checkerCount }
}

/** ANY_KEYHASH calls and call checkers for the given keys plus ANY_KEYHASH. */
export async function readGuardCleanup(input: {
    rpcUrl: string
    chainId: number
    account: Address
    keyHashes: readonly Hex[]
}): Promise<GuardCleanup> {
    const client = chainClient(input.rpcUrl, input.chainId)

    const anyPacked = await client.readContract({
        address: input.account,
        abi: accountAbi,
        functionName: 'canExecutePackedInfos',
        args: [ANY_KEYHASH],
    })

    const anyCalls = anyPacked.map((packed) => decodePackedCanExecute(packed))
    const checkers: GuardCleanup['checkers'] = []
    const hashes = [...input.keyHashes, ANY_KEYHASH]

    for (const keyHash of hashes) {
        const infos = await client.readContract({
            address: input.account,
            abi: accountAbi,
            functionName: 'callCheckerInfos',
            args: [keyHash],
        })

        for (const info of infos) {
            if (info.checker === '0x0000000000000000000000000000000000000000') continue
            checkers.push({ keyHash, target: getAddress(info.target) })
        }
    }

    return { anyCalls, checkers }
}
