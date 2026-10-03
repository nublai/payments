import { getAddress, isHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { writeSettlementCalls, signSettlement } from '@towns-labs/relayer-client'
import { resolveKeystorePath } from './account-create'
import type { ChainName, EnvName } from './network-config'
import type { ExecuteSignedCallsDeps } from './execute-calls'
import { createEscrowPasswordResolver, executeEscrowCallsWithFallback } from './escrow-execute'
import {
    EscrowError,
    type EscrowChainNetworkContractsDeps,
    parseEscrowId,
    parseSettlementId,
    resolveEscrowChainNetworkContracts,
    toEscrowError,
} from './escrow-common'

export type EscrowSettleDeps = EscrowChainNetworkContractsDeps & {
    executeSignedCallsDeps?: Partial<ExecuteSignedCallsDeps>
}

function getDefaultEscrowSettleDeps(): EscrowChainNetworkContractsDeps {
    return { resolveEscrowChainNetworkContracts }
}

export type EscrowSettleOptions = {
    env: EnvName
    escrowId: string
    settlementId: string
    oracle: string
    oraclePrivateKey?: string
    signature?: string
    chain?: ChainName
    keystorePath?: string
    sessionFile?: string
    name?: string
    password?: string
    resolvePassword?: () => Promise<string>
}

export type EscrowSettleResult = {
    type: 'escrow_settle'
    status: 'complete'
    escrowId: Hex
    chain: ChainName
    submitter: Address
    oracle: Address
    bundle: {
        id: string
        status: string
        statusCode: number
    }
    signerMode: 'daemon' | 'direct' | 'fallback_direct'
    txHash?: Hex
}

/** ECDSA signature length: 0x + 130 hex chars (65 bytes r,s,v). */
const SETTLEMENT_SIGNATURE_LENGTH = 132
/** Private key length: 0x + 64 hex chars (32 bytes). */
const PRIVATE_KEY_HEX_LENGTH = 66

/**
 * Settle an escrow by submitting an oracle settlement signature. Requires either a pre-signed
 * signature or the oracle private key. Session is used to submit the settlement transaction.
 * @param depsArg Optional overrides for testing (e.g. resolveEscrowChainNetworkContracts, executeSignedCallsDeps).
 */
export async function executeEscrowSettle(
    options: EscrowSettleOptions,
    depsArg?: Partial<EscrowSettleDeps>,
): Promise<EscrowSettleResult> {
    const deps = { ...getDefaultEscrowSettleDeps(), ...depsArg }
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
        const settlementId = parseSettlementId(options.settlementId)
        const oracle = getAddress(options.oracle)

        let settlementSignature: Hex
        if (options.signature) {
            if (
                !isHex(options.signature) ||
                options.signature.length !== SETTLEMENT_SIGNATURE_LENGTH
            ) {
                throw new EscrowError(
                    'INVALID_ARGUMENT',
                    'Signature must be a 65-byte hex string (0x + 130 hex chars).',
                )
            }
            settlementSignature = options.signature as Hex
        } else if (options.oraclePrivateKey) {
            if (
                !isHex(options.oraclePrivateKey) ||
                options.oraclePrivateKey.length !== PRIVATE_KEY_HEX_LENGTH
            ) {
                throw new EscrowError(
                    'INVALID_ARGUMENT',
                    'Oracle private key must be a 32-byte hex string (0x + 64 hex chars).',
                )
            }
            const derivedOracle = privateKeyToAccount(options.oraclePrivateKey as Hex).address
            if (derivedOracle !== oracle) {
                throw new EscrowError(
                    'INVALID_ARGUMENT',
                    `Oracle private key does not match --oracle. Expected ${oracle}, derived ${derivedOracle}.`,
                )
            }
            settlementSignature = await signSettlement({
                settlementId,
                oracleAddress: oracle,
                chainId: network.chainId,
                simpleSettlerAddress: contracts.simpleSettlerAddress,
                oraclePrivateKey: options.oraclePrivateKey as Hex,
            })
        } else {
            throw new EscrowError(
                'MISSING_ARGUMENT',
                'Either --oracle-private-key or --signature is required for settlement. Prefer TW_ORACLE_PRIVATE_KEY env var over the flag.',
            )
        }

        const calls = writeSettlementCalls({
            escrowId,
            settlementId,
            oracleAddress: oracle,
            chainId: network.chainId,
            signature: settlementSignature,
            simpleSettlerAddress: contracts.simpleSettlerAddress,
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
            failureMessage: 'Settlement',
        })

        return {
            type: 'escrow_settle',
            status: 'complete',
            escrowId,
            chain,
            submitter: result.sender,
            oracle,
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
