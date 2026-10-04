import type { Address, Hex } from 'viem'
import { refundEscrowCalls } from '@nubl/relayer-client'
import { resolveKeystorePath } from './account-create'
import type { ChainName, EnvName } from './network-config'
import type { ExecuteSignedCallsDeps } from './execute-calls'
import { createEscrowPasswordResolver, executeEscrowCallsWithFallback } from './escrow-execute'
import {
    type EscrowChainNetworkContractsDeps,
    parseEscrowId,
    resolveEscrowChainNetworkContracts,
    toEscrowError,
} from './escrow-common'

export type EscrowRefundDeps = EscrowChainNetworkContractsDeps & {
    executeSignedCallsDeps?: Partial<ExecuteSignedCallsDeps>
}

function getDefaultEscrowRefundDeps(): EscrowChainNetworkContractsDeps {
    return { resolveEscrowChainNetworkContracts }
}

export type EscrowRefundOptions = {
    env: EnvName
    escrowId: string
    chain?: ChainName
    keystorePath?: string
    sessionFile?: string
    name?: string
    password?: string
    resolvePassword?: () => Promise<string>
}

export type EscrowRefundResult = {
    type: 'escrow_refund'
    status: 'complete'
    escrowId: Hex
    chain: ChainName
    submitter: Address
    bundle: {
        id: string
        status: string
        statusCode: number
    }
    signerMode: 'daemon' | 'direct' | 'fallback_direct'
    txHash?: Hex
}

/**
 * Trigger permissionless refund after the escrow deadline. Requires session to submit the transaction.
 * @param depsArg Optional overrides for testing (e.g. resolveEscrowChainNetworkContracts, executeSignedCallsDeps).
 */
export async function executeEscrowRefund(
    options: EscrowRefundOptions,
    depsArg?: Partial<EscrowRefundDeps>,
): Promise<EscrowRefundResult> {
    const deps = { ...getDefaultEscrowRefundDeps(), ...depsArg }
    const { chain, network, contracts } = deps.resolveEscrowChainNetworkContracts(
        options.env,
        options.chain,
    )
    const keystorePath =
        options.sessionFile ??
        resolveKeystorePath({
            env: options.env,
            keystorePath: options.keystorePath,
            name: options.name,
        })

    const resolvePassword = createEscrowPasswordResolver({
        password: options.password,
        resolvePassword: options.resolvePassword,
    })

    try {
        const escrowId = parseEscrowId(options.escrowId)

        const calls = refundEscrowCalls({
            escrowId,
            escrowAddress: contracts.escrowAddress,
        })

        const result = await executeEscrowCallsWithFallback({
            chain,
            network,
            env: options.env,
            sessionFile: options.sessionFile,
            keystorePath,
            name: options.name,
            resolvePassword,
            executeSignedCallsDeps: deps.executeSignedCallsDeps,
            calls,
            failureMessage: 'Refund',
        })

        return {
            type: 'escrow_refund',
            status: 'complete',
            escrowId,
            chain,
            submitter: result.sender,
            bundle: {
                id: result.submission.id,
                status: result.finalStatus.status ?? 'unknown',
                statusCode: result.finalStatus.statusCode ?? 0,
            },
            signerMode: result.signerMode,
            txHash: result.finalStatus.receipt?.transactionHash,
        }
    } catch (error) {
        throw toEscrowError(error)
    }
}
