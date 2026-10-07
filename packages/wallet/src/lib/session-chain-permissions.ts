import { createPublicClient, getAddress, http, type Address, type Hex } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import { getAddressesWithFallback } from '@nubl/contracts/deployments'
import { ERC20_SELECTORS, getChain } from '@nubl/relayer-client'
import {
    getChainNameByChainId,
    getUsdcTokenConfig,
    type EnvName,
} from './network-config'

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

function decodePackedCanExecute(packed: Hex): { target: Address; selector: Hex } {
    const value = BigInt(packed)
    const target = getAddress(`0x${(value >> 96n).toString(16).padStart(40, '0')}`)
    const selector = `0x${(value & 0xffffffffn).toString(16).padStart(8, '0')}` as Hex
    return { target, selector }
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
    const client = createPublicClient({
        chain: getChain(input.chainId, input.rpcUrl),
        transport: http(input.rpcUrl, { timeout: 10_000 }),
        batch: { multicall: false },
    })
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
