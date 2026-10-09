/**
 * Environment configuration and validation
 */

import { getAddress, isAddress, zeroAddress } from 'viem'

import type { Env, RelayerConfig } from '../types/env'
import { hasDeployment } from '@nubl/contracts/deployments'
import { readOidcConfig, isOidcEnabled } from '../auth/oidc-config'
import { parseErc8128Allowlist } from '../auth/erc8128/signer-policy'
import { isLocalDevContext, quoteSigningSecret } from './runtime-context'
import { getContractAddresses } from './addresses'
import type { SignerPoolConfig } from '../types/env'
import { getChainRpcUrl } from '../lib/multi-chain-client'

/**
 * Required environment variables
 */
const REQUIRED_ENV_VARS = ['RELAYER_MNEMONIC'] as const

/**
 * Default pool configuration values
 */
const POOL_DEFAULTS = {
    signerCount: 1,
    maxPendingPerSigner: 16,
    maxPendingTotal: 1000,
    minSignerBalance: BigInt('10000000000000000'), // 0.01 ETH
} as const

/**
 * Validate that all required environment variables are set
 */
export function validateEnv(env: Env): { valid: boolean; missing: string[] } {
    const missing: string[] = []

    for (const key of REQUIRED_ENV_VARS) {
        if (!env[key as keyof Env]) {
            missing.push(key)
        }
    }

    const chainIds = getChainIds(env)

    if (chainIds.length === 0) {
        missing.push('CHAIN_IDS')

        return { valid: false, missing }
    }

    const context = env.CONTEXT ?? 'prod'

    for (const chainId of chainIds) {
        // Ensure RPC configured
        try {
            getChainRpcUrl(chainId, env)
        } catch {
            missing.push(`RPC_${chainId} or RPC_URL`)
        }

        // Ensure contract addresses are available (deployment or env overrides)
        try {
            getContractAddresses(env, chainId)
        } catch {
            if (!hasDeployment(context, chainId)) {
                missing.push(
                    `Contract addresses for chain ${chainId} are not deployed (set ORCHESTRATOR_${chainId} or provide deployment)`,
                )
            }
        }
    }

    if (env.PRIVY_ENABLED === 'true') {
        if (!env.PRIVY_APP_ID) {
            missing.push('PRIVY_APP_ID')
        }

        if (!env.PRIVY_APP_SECRET) {
            missing.push('PRIVY_APP_SECRET')
        }
    }

    if (isOidcEnabled(env)) {
        const oidc = readOidcConfig(env)

        if (!oidc.ok) {
            for (const key of oidc.missing) missing.push(key)
        }
    }

    if (!isLocalDevContext(env) && !quoteSigningSecret(env)) {
        missing.push('QUOTE_SIGNING_SECRET')
    }

    if (!isLocalDevContext(env) && !isPaidFeeRecipient(env.FEE_RECIPIENT)) {
        missing.push('FEE_RECIPIENT')
    }

    if (parseErc8128Allowlist(env.ERC8128_ALLOWED_SIGNERS).invalid.length > 0) {
        missing.push('ERC8128_ALLOWED_SIGNERS')
    }

    return { valid: missing.length === 0, missing }
}

/** Anything other than local must name a non-zero fee recipient. Local may omit it. */
function isPaidFeeRecipient(value: string | undefined): boolean {
    const text = value?.trim()

    if (!text || !isAddress(text, { strict: false })) return false

    return getAddress(text) !== zeroAddress
}

/**
 * Validate pool-specific configuration
 */
export function validatePoolConfig(env: Env): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    const signerCount = parseInt(env.RELAYER_COUNT ?? '1', 10)

    if (isNaN(signerCount) || signerCount < 1 || signerCount > 100) {
        errors.push('RELAYER_COUNT must be a number between 1 and 100')
    }

    const maxPendingPerSigner = parseInt(env.MAX_PENDING_PER_SIGNER ?? '16', 10)

    if (isNaN(maxPendingPerSigner) || maxPendingPerSigner < 1) {
        errors.push('MAX_PENDING_PER_SIGNER must be a positive number')
    }

    const maxPendingTotal = parseInt(env.MAX_PENDING_TOTAL ?? '1000', 10)

    if (isNaN(maxPendingTotal) || maxPendingTotal < signerCount) {
        errors.push('MAX_PENDING_TOTAL must be >= RELAYER_COUNT')
    }

    if (env.MIN_SIGNER_BALANCE) {
        try {
            const minBalance = BigInt(env.MIN_SIGNER_BALANCE)

            if (minBalance < 0n) {
                errors.push('MIN_SIGNER_BALANCE must be non-negative')
            }

            // Validate TARGET_SIGNER_BALANCE > MIN_SIGNER_BALANCE if both are set
            if (env.TARGET_SIGNER_BALANCE) {
                try {
                    // TARGET_SIGNER_BALANCE is in ETH, convert to wei for comparison
                    const targetBalanceWei = BigInt(
                        (parseFloat(env.TARGET_SIGNER_BALANCE) * 1e18).toString(),
                    )

                    if (targetBalanceWei <= minBalance) {
                        errors.push(
                            `TARGET_SIGNER_BALANCE (${env.TARGET_SIGNER_BALANCE} ETH) must be greater than MIN_SIGNER_BALANCE (${env.MIN_SIGNER_BALANCE} wei)`,
                        )
                    }
                } catch {
                    errors.push('TARGET_SIGNER_BALANCE must be a valid number (in ETH)')
                }
            }
        } catch {
            errors.push('MIN_SIGNER_BALANCE must be a valid integer (in wei)')
        }
    }

    return { valid: errors.length === 0, errors }
}

/**
 * Get chain IDs from env (CHAIN_IDS)
 */
export function getChainIds(env: Env): number[] {
    if (env.CHAIN_IDS) {
        return env.CHAIN_IDS.split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
            .map((id) => parseInt(id, 10))
            .filter((id) => Number.isFinite(id))
    }

    return []
}

/**
 * Extract typed configuration from environment
 */
export function getChainConfig(env: Env, chainId: number): RelayerConfig {
    const rpcUrl = getChainRpcUrl(chainId, env)

    return {
        rpcUrl,
        chainId,
        contracts: getContractAddresses(env, chainId),
    }
}

/**
 * Extract pool configuration from environment
 */
export function getPoolConfig(env: Env, chainId: number): SignerPoolConfig {
    const rpcUrl = getChainRpcUrl(chainId, env)

    return {
        rpcUrl,
        chainId,
        mnemonic: env.RELAYER_MNEMONIC,
        signerCount: parseInt(env.RELAYER_COUNT ?? String(POOL_DEFAULTS.signerCount), 10),
        maxPendingPerSigner: parseInt(
            env.MAX_PENDING_PER_SIGNER ?? String(POOL_DEFAULTS.maxPendingPerSigner),
            10,
        ),
        maxPendingTotal: parseInt(
            env.MAX_PENDING_TOTAL ?? String(POOL_DEFAULTS.maxPendingTotal),
            10,
        ),
        minSignerBalance: env.MIN_SIGNER_BALANCE
            ? BigInt(env.MIN_SIGNER_BALANCE)
            : POOL_DEFAULTS.minSignerBalance,
        contracts: getContractAddresses(env, chainId),
    }
}
