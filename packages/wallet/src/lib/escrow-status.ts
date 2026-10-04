import { createPublicClient, http, type Address, type Hex } from 'viem'
import { getChain, getEscrowStatus } from '@nubl/relayer-client'
import type { EscrowStatus } from '@nubl/relayer-client'
import type { ChainName, EnvName } from './network-config'
import {
    type EscrowChainNetworkContractsDeps,
    parseEscrowId,
    resolveEscrowChainNetworkContracts,
    toEscrowError,
} from './escrow-common'

export type EscrowStatusDeps = EscrowChainNetworkContractsDeps & {
    getEscrowStatus?: typeof getEscrowStatus
}

function getDefaultEscrowStatusDeps(): EscrowChainNetworkContractsDeps {
    return { resolveEscrowChainNetworkContracts }
}

export type EscrowStatusOptions = {
    env: EnvName
    escrowId: string
    chain?: ChainName
}

export type EscrowStatusResult = {
    type: 'escrow_status'
    escrowId: Hex
    chain: ChainName
    status: EscrowStatus['status']
    escrow: EscrowStatus['escrow']
    escrowAddress: Address
}

/**
 * Query on-chain escrow state by ID. Returns status and escrow data from the relayer.
 * @param depsArg Optional overrides for testing (e.g. resolveEscrowChainNetworkContracts, getEscrowStatus).
 */
export async function executeEscrowStatus(
    options: EscrowStatusOptions,
    depsArg?: Partial<EscrowStatusDeps>,
): Promise<EscrowStatusResult> {
    try {
        const deps = { ...getDefaultEscrowStatusDeps(), ...depsArg }
        const { chain, network, contracts } = deps.resolveEscrowChainNetworkContracts(
            options.env,
            options.chain,
        )
        const escrowId = parseEscrowId(options.escrowId)

        const publicClient = createPublicClient({
            chain: getChain(network.chainId, network.rpcUrl),
            transport: http(network.rpcUrl),
        })

        const getStatus = deps.getEscrowStatus ?? getEscrowStatus
        const result = await getStatus({
            escrowId,
            escrowAddress: contracts.escrowAddress,
            publicClient,
        })

        return {
            type: 'escrow_status',
            escrowId,
            chain,
            status: result.status,
            escrow: result.escrow,
            escrowAddress: contracts.escrowAddress,
        }
    } catch (error) {
        throw toEscrowError(error)
    }
}
