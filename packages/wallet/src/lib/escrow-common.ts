import type { Address, Hex } from 'viem'
import { isHex } from 'viem'
import { getAddressesWithFallback } from '@agentic-payments/contracts/deployments'
import type { EnvName, ChainName } from './network-config'
import { resolveNetworkConfig, selectDefaultChain, getUsdcTokenConfig } from './network-config'
import type { LoginSessionKeystoreV2, RelayerSessionKeystoreV2 } from './keystore'

export type EscrowErrorCode =
    | 'PASSWORD_REQUIRED'
    | 'KEYSTORE_NOT_FOUND'
    | 'UNSUPPORTED_CHAIN'
    | 'INVALID_AMOUNT'
    | 'INVALID_ARGUMENT'
    | 'MISSING_ARGUMENT'
    | 'ESCROW_NOT_FOUND'
    | 'ESCROW_FAILED'
    | 'INTENT_REVERTED'
    | 'BUNDLE_TIMEOUT'
    | 'SESSION_EXPIRED'
    | 'CONTRACTS_NOT_DEPLOYED'
    | 'UNKNOWN'

export class EscrowError extends Error {
    code: EscrowErrorCode
    cause?: unknown
    details?: unknown

    constructor(
        code: EscrowErrorCode,
        message: string,
        options?: { cause?: unknown; details?: unknown },
    ) {
        super(message)
        this.name = 'EscrowError'
        this.code = code
        this.cause = options?.cause
        this.details = options?.details
    }
}

/** Map CLI env name to deployment context used by @agentic-payments/contracts */
function envToDeploymentContext(env: EnvName): string {
    switch (env) {
        case 'prod':
            return 'prod'
        case 'stage':
            return 'stage'
        case 'dev':
            return 'dev'
    }
}

/** Escrow contract addresses for a given env/chain. */
export interface EscrowContracts {
    escrowAddress: Address
    simpleSettlerAddress: Address
    usdcAddress: Address
}

/**
 * Resolve escrow, simpleSettler, and USDC addresses for the given env and chain.
 * JSON deployments are checked first. Chain 31337/41337 then falls back to
 * process.env (ESCROW_31337 and the other suffixed keys), because make-config
 * strips local addresses out of addresses.json.
 * @throws EscrowError('CONTRACTS_NOT_DEPLOYED') when no deployment exists for the chain.
 */
export function resolveEscrowContracts(
    env: EnvName,
    chainId: number,
    chain: ChainName,
): EscrowContracts {
    const context = envToDeploymentContext(env)
    const addresses = getAddressesWithFallback(context, chainId)
    if (!addresses) {
        throw new EscrowError(
            'CONTRACTS_NOT_DEPLOYED',
            `No escrow deployment found for ${env}/${chainId}. Escrow may not be deployed on this chain.`,
        )
    }

    const usdcToken = getUsdcTokenConfig(chain)

    return {
        escrowAddress: addresses.escrow,
        simpleSettlerAddress: addresses.simpleSettler,
        usdcAddress: usdcToken.address,
    }
}

const BYTES32_HEX_LENGTH = 66 // 0x + 32 bytes

/**
 * Parse and validate a 32-byte hex string (0x-prefixed, 66 chars).
 * @param label Used in error message (e.g. "escrow ID", "settlement ID").
 * @throws EscrowError('INVALID_ARGUMENT') when format is invalid.
 */
function parseBytes32Hex(value: string, label: string): Hex {
    if (!isHex(value) || value.length !== BYTES32_HEX_LENGTH) {
        throw new EscrowError(
            'INVALID_ARGUMENT',
            `Invalid ${label}: must be a 32-byte hex string (0x + 64 hex chars).`,
        )
    }
    return value as Hex
}

/**
 * Parse and validate a 32-byte escrow ID (0x-prefixed hex, 66 chars).
 * @throws EscrowError('INVALID_ARGUMENT') when format is invalid.
 */
export function parseEscrowId(value: string): Hex {
    return parseBytes32Hex(value, 'escrow ID')
}

/**
 * Parse and validate a 32-byte settlement ID (bytes32 hex).
 * @throws EscrowError('INVALID_ARGUMENT') when format is invalid.
 */
export function parseSettlementId(value: string): Hex {
    return parseBytes32Hex(value, 'settlement ID')
}

/**
 * Assert that the session file's network (env + chainId) matches the CLI options.
 * Call when using --session-file to avoid wrong-chain or relayer rejection.
 * @throws EscrowError('UNSUPPORTED_CHAIN') on mismatch.
 */
export function assertEscrowSessionNetworkMatches(
    sessionKeystore: RelayerSessionKeystoreV2 | LoginSessionKeystoreV2,
    expectedEnv: EnvName,
    expectedChainId: number,
): void {
    const sessionEnv = sessionKeystore.network?.env
    const sessionChainId = sessionKeystore.network?.chainId
    if (sessionEnv !== expectedEnv) {
        throw new EscrowError(
            'UNSUPPORTED_CHAIN',
            `Session file env mismatch: expected ${expectedEnv}, got ${sessionEnv}.`,
        )
    }
    if (sessionChainId !== expectedChainId) {
        throw new EscrowError(
            'UNSUPPORTED_CHAIN',
            `Session file chain mismatch: expected ${expectedChainId}, got ${sessionChainId}.`,
        )
    }
}

/**
 * Resolve chain, network config, and escrow contracts from env and optional chain override.
 * When chain is provided, uses options.env for consistency (not hardcoded prod).
 */
export function resolveEscrowChainNetworkContracts(env: EnvName, chainOption?: ChainName) {
    const chain = chainOption ? selectDefaultChain(env, chainOption) : selectDefaultChain(env)
    const network = resolveNetworkConfig(env, chain)
    const contracts = resolveEscrowContracts(env, network.chainId, chain)
    return { chain, network, contracts }
}

/** Return type of resolveEscrowChainNetworkContracts (for deps typing). */
export type ResolveEscrowChainNetworkContractsResult = ReturnType<
    typeof resolveEscrowChainNetworkContracts
>

/** Injectable deps for escrow commands (testing). Override any subset. */
export type EscrowChainNetworkContractsDeps = {
    resolveEscrowChainNetworkContracts: (
        env: EnvName,
        chainOption?: ChainName,
    ) => ResolveEscrowChainNetworkContractsResult
}

/**
 * Normalize unknown errors to EscrowError using message heuristics (substring-based).
 * Use for catch boundaries so CLI gets typed error codes.
 */
export function toEscrowError(error: unknown): EscrowError {
    if (error instanceof EscrowError) {
        return error
    }

    const message = error instanceof Error ? error.message : String(error)

    if (message.includes('Unsupported chain')) {
        return new EscrowError('UNSUPPORTED_CHAIN', message, { cause: error })
    }
    if (message.includes('ENOENT') || message.toLowerCase().includes('no such file')) {
        return new EscrowError('KEYSTORE_NOT_FOUND', `Keystore not found`, { cause: error })
    }
    if (
        message.includes('No password provided on stdin') ||
        message.includes('Password required') ||
        message.includes('Password cannot be empty') ||
        message.includes('Password input cancelled')
    ) {
        return new EscrowError('PASSWORD_REQUIRED', message, { cause: error })
    }
    if (message.toLowerCase().includes('simulation failed')) {
        return new EscrowError('INTENT_REVERTED', message, { cause: error })
    }
    if (
        message.toLowerCase().includes('timeout waiting for bundle') ||
        (message.toLowerCase().includes('timeout') && message.toLowerCase().includes('bundle'))
    ) {
        return new EscrowError('BUNDLE_TIMEOUT', message, { cause: error })
    }
    // Heuristic: only map known amount-validation phrases to avoid misclassifying unrelated errors
    if (/Invalid amount|Amount must be|Amount is invalid|Amount supports at most/i.test(message)) {
        return new EscrowError('INVALID_AMOUNT', message, { cause: error })
    }
    // Only map when message explicitly refers to escrow (avoids "Contract not found", "Method not found", etc.)
    if (/escrow/i.test(message) && /not found/i.test(message)) {
        return new EscrowError('ESCROW_NOT_FOUND', message, { cause: error })
    }

    return new EscrowError('UNKNOWN', message, { cause: error })
}
