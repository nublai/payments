import {
    createPublicClient,
    erc20Abi,
    getAddress,
    http,
    zeroAddress,
    type Address,
    type PublicClient,
} from 'viem'
import { getChain } from '@nubl/relayer-client'
import { getUsdcAddressByChainId, type CliNetworkConfig } from './network-config'
import { WETH_BY_CHAIN } from './quote-spend'
import { relayAllowanceSpenders } from './relay-allowlist'

/**
 * Standing rights that let an allowlisted Relay target pull more than the
 * quoted input. Checked when a swap session is created and again immediately
 * before the quote is signed.
 *
 * Residuals, not closed here:
 * - TOCTOU. The root key can approve a target after this read and before the
 *   swap is included. The check is not an on-chain guard.
 * - ERC-20s, NFTs, and vaults this wallet cannot name. The production
 *   registries for ERC-721, ERC-1155, and ERC-4626 are empty. A bespoke vault
 *   or an unknown token is not read.
 * - A lying RPC that returns zero for every allowance.
 */

/** Canonical Permit2. Same address on Base and Polygon. */
export const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3')

const permit2Abi = [
    {
        name: 'allowance',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'user', type: 'address' },
            { name: 'token', type: 'address' },
            { name: 'spender', type: 'address' },
        ],
        outputs: [
            { name: 'amount', type: 'uint160' },
            { name: 'expiration', type: 'uint48' },
            { name: 'nonce', type: 'uint48' },
        ],
    },
] as const

const erc721Abi = [
    {
        name: 'isApprovedForAll',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'owner', type: 'address' },
            { name: 'operator', type: 'address' },
        ],
        outputs: [{ name: '', type: 'bool' }],
    },
    {
        name: 'getApproved',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        outputs: [{ name: '', type: 'address' }],
    },
] as const

const erc1155Abi = [
    {
        name: 'isApprovedForAll',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'operator', type: 'address' },
        ],
        outputs: [{ name: '', type: 'bool' }],
    },
] as const

export class StandingRightsRejected extends Error {
    override cause?: unknown

    constructor(message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'StandingRightsRejected'
        this.cause = options?.cause
    }
}

export type Permit2Allowance = {
    amount: bigint
    expiration: bigint
    nonce: bigint
}

export type StandingRightsRegistry = {
    erc721?: readonly { token: Address; tokenIds?: readonly bigint[] }[]
    erc1155?: readonly { token: Address }[]
    erc4626?: readonly { vault: Address }[]
}

export type StandingRightsReaders = {
    readErc20Allowance: (token: Address, spender: Address) => Promise<bigint>
    readPermit2Allowance: (token: Address, spender: Address) => Promise<Permit2Allowance>
    readErc721ApprovedForAll: (token: Address, operator: Address) => Promise<boolean>
    readErc721GetApproved: (token: Address, tokenId: bigint) => Promise<Address>
    readErc1155ApprovedForAll: (token: Address, operator: Address) => Promise<boolean>
    readErc4626ShareBalance: (vault: Address) => Promise<bigint>
    readErc4626ShareAllowance: (vault: Address, spender: Address) => Promise<bigint>
    now?: () => bigint
}

/** ERC-20s this wallet can name, including the quoted input when it is one. */
export function knownErc20Tokens(chainId: number, extra?: Address): Address[] {
    const candidates = [
        getUsdcAddressByChainId(chainId),
        getUsdcAddressByChainId(chainId, true),
        WETH_BY_CHAIN[chainId],
        extra,
    ]
    const tokens: Address[] = []
    for (const candidate of candidates) {
        if (!candidate) continue
        const address = getAddress(candidate)
        if (address === zeroAddress) continue
        if (tokens.some((token) => token.toLowerCase() === address.toLowerCase())) continue
        tokens.push(address)
    }
    return tokens
}

function revoke(detail: string): never {
    throw new StandingRightsRejected(
        `${detail} Revoke it with the root key before creating or using a swap session.`,
    )
}

async function readOrRefuse<T>(read: () => Promise<T>): Promise<T> {
    try {
        return await read()
    } catch (error) {
        if (error instanceof StandingRightsRejected) throw error
        throw new StandingRightsRejected('Could not read standing rights. Refusing to sign.', {
            cause: error,
        })
    }
}

export async function assertNoStandingRights(input: {
    chainId: number
    owner: Address
    /** Allowlisted Relay targets. */
    targets: readonly Address[]
    /** Known ERC-20s, including the quoted input. */
    tokens: readonly Address[]
    registry?: StandingRightsRegistry
    readers: StandingRightsReaders
}): Promise<void> {
    const targets = input.targets.map((target) => getAddress(target))
    const tokens = input.tokens.map((token) => getAddress(token))
    const now = () =>
        input.readers.now ? input.readers.now() : BigInt(Math.floor(Date.now() / 1000))

    for (const token of tokens) {
        for (const target of targets) {
            const allowance = await readOrRefuse(() =>
                input.readers.readErc20Allowance(token, target),
            )
            if (allowance > 0n) {
                revoke(
                    `The account has a standing allowance of ${token} to ${target}.`,
                )
            }
        }
        const permit2Allowance = await readOrRefuse(() =>
            input.readers.readErc20Allowance(token, PERMIT2),
        )
        if (permit2Allowance > 0n) {
            revoke(
                `The account has a standing allowance of ${token} to Permit2 ${PERMIT2}.`,
            )
        }
        for (const target of targets) {
            const permit = await readOrRefuse(() =>
                input.readers.readPermit2Allowance(token, target),
            )
            if (permit.amount > 0n && permit.expiration > now()) {
                revoke(
                    `The account has a standing Permit2 allowance of ${token} to ${target} for amount ${permit.amount}, expiring at ${permit.expiration}.`,
                )
            }
        }
    }

    for (const nft of input.registry?.erc721 ?? []) {
        const token = getAddress(nft.token)
        for (const target of targets) {
            const approved = await readOrRefuse(() =>
                input.readers.readErc721ApprovedForAll(token, target),
            )
            if (approved) {
                revoke(
                    `The account has a standing ERC-721 approval of ${token} for ${target}.`,
                )
            }
        }
        for (const tokenId of nft.tokenIds ?? []) {
            const approved = await readOrRefuse(() =>
                input.readers.readErc721GetApproved(token, tokenId),
            )
            if (targets.some((target) => target.toLowerCase() === approved.toLowerCase())) {
                revoke(
                    `The account has a standing ERC-721 approval of ${token} id ${tokenId} for ${approved}.`,
                )
            }
        }
    }

    for (const nft of input.registry?.erc1155 ?? []) {
        const token = getAddress(nft.token)
        for (const target of targets) {
            const approved = await readOrRefuse(() =>
                input.readers.readErc1155ApprovedForAll(token, target),
            )
            if (approved) {
                revoke(
                    `The account has a standing ERC-1155 approval of ${token} for ${target}.`,
                )
            }
        }
    }

    for (const vault of input.registry?.erc4626 ?? []) {
        const token = getAddress(vault.vault)
        const balance = await readOrRefuse(() => input.readers.readErc4626ShareBalance(token))
        if (balance > 0n) {
            revoke(
                `The account holds ${balance} shares of vault ${token}. A swap session cannot hold shares of a known vault.`,
            )
        }
        for (const target of targets) {
            const allowance = await readOrRefuse(() =>
                input.readers.readErc4626ShareAllowance(token, target),
            )
            if (allowance > 0n) {
                revoke(
                    `The account has a standing share allowance of vault ${token} to ${target}.`,
                )
            }
        }
    }
}

function clientFor(network: CliNetworkConfig): PublicClient {
    return createPublicClient({
        chain: getChain(network.chainId, network.rpcUrl),
        transport: http(network.rpcUrl),
    })
}

export function chainStandingRightsReaders(input: {
    network: CliNetworkConfig
    owner: Address
}): StandingRightsReaders {
    const owner = getAddress(input.owner)
    const client = clientFor(input.network)
    return {
        readErc20Allowance: (token, spender) =>
            client.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [owner, spender],
            }),
        readPermit2Allowance: async (token, spender) => {
            const result = await client.readContract({
                address: PERMIT2,
                abi: permit2Abi,
                functionName: 'allowance',
                args: [owner, token, spender],
            })
            return {
                amount: result[0],
                expiration: BigInt(result[1]),
                nonce: BigInt(result[2]),
            }
        },
        readErc721ApprovedForAll: (token, operator) =>
            client.readContract({
                address: token,
                abi: erc721Abi,
                functionName: 'isApprovedForAll',
                args: [owner, operator],
            }),
        readErc721GetApproved: (token, tokenId) =>
            client.readContract({
                address: token,
                abi: erc721Abi,
                functionName: 'getApproved',
                args: [tokenId],
            }),
        readErc1155ApprovedForAll: (token, operator) =>
            client.readContract({
                address: token,
                abi: erc1155Abi,
                functionName: 'isApprovedForAll',
                args: [owner, operator],
            }),
        readErc4626ShareBalance: (vault) =>
            client.readContract({
                address: vault,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [owner],
            }),
        readErc4626ShareAllowance: (vault, spender) =>
            client.readContract({
                address: vault,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [owner, spender],
            }),
    }
}

export function relayStandingTargets(chainId: number): Address[] {
    return relayAllowanceSpenders(chainId).map((target) => getAddress(target))
}

/** Readers that report no standing rights. Unit tests use this so they do not hit a chain. */
export function noStandingRightsReads(): {
    readPermit2Allowance: StandingRightsReaders['readPermit2Allowance']
    readErc721ApprovedForAll: StandingRightsReaders['readErc721ApprovedForAll']
    readErc721GetApproved: StandingRightsReaders['readErc721GetApproved']
    readErc1155ApprovedForAll: StandingRightsReaders['readErc1155ApprovedForAll']
    readErc4626ShareBalance: StandingRightsReaders['readErc4626ShareBalance']
    readErc4626ShareAllowance: StandingRightsReaders['readErc4626ShareAllowance']
} {
    return {
        readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
        readErc721ApprovedForAll: async () => false,
        readErc721GetApproved: async () => zeroAddress,
        readErc1155ApprovedForAll: async () => false,
        readErc4626ShareBalance: async () => 0n,
        readErc4626ShareAllowance: async () => 0n,
    }
}
