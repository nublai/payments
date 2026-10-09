/**
 * Test setup for integration tests
 *
 * Environment variables:
 * - TEST_CHAIN_ID: Chain ID to use (default: 31337 for local)
 * - ANVIL_PORT: Port for Anvil (default: 8545)
 * - RELAYER_PORT: Port for relayer (default: 8787)
 * - RELAYER_URL: Full URL to relayer (overrides RELAYER_PORT)
 * - RPC_URL: Full URL to RPC (overrides ANVIL_PORT)
 * - REMOTE_PRIVATE_KEY: Prefunded key used for remote top-ups in test helpers
 *
 * Running modes:
 * - Local mode (default): ./scripts/local-dev.sh
 *   - Uses chain ID 31337
 *   - Deploys contracts locally
 *   - ERC20 tests are skipped (no USDC)
 *
 * - Fork mode: FORK_RPC_URL=https://mainnet.base.org ./scripts/local-dev.sh
 *   - Uses chain ID 8453
 *   - Uses contracts from forked chain
 *   - All tests run including ERC20
 *
 * - Remote mode: Run against a deployed relayer
 *   - RELAYER_URL is that worker's origin (same value as RELAYER_URL_STAGE or RELAYER_URL_PROD)
 *     RELAYER_URL set to the deployed worker origin \
 *     RPC_URL=https://sepolia.base.org \
 *     TEST_CHAIN_ID=84532 \
 *     bun test test/scenarios/01-account-delegation.test.ts
 */

// Load local contract addresses before other imports that depend on env vars
// This reads from packages/contracts/deployments/envs/local/.env
import { config } from 'dotenv'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const localEnvPath = resolve(__dirname, '../../contracts/deployments/envs/local/.env')

config({ path: localEnvPath })

import { beforeAll, afterAll } from 'vitest'
import { createPublicClient, http, type Chain } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { getTestContracts } from './helpers/deployments'
import { parseHex } from './helpers/hex'

// Default ports
export const ANVIL_PORT = process.env.ANVIL_PORT ? parseInt(process.env.ANVIL_PORT) : 8545

export const ANVIL_PORT_ARB = process.env.ANVIL_PORT_ARB
    ? parseInt(process.env.ANVIL_PORT_ARB)
    : 8546

export const RELAYER_PORT = process.env.RELAYER_PORT ? parseInt(process.env.RELAYER_PORT) : 8787

// Chain configuration for tests
// Default to 31337 (local Anvil) if not specified
export const TEST_CHAIN_ID = process.env.TEST_CHAIN_ID ? parseInt(process.env.TEST_CHAIN_ID) : 31337

export const OUTPUT_CHAIN_ID = 41337 // Second Anvil for crosschain tests

// RPC URLs - use env var if provided, otherwise default to local Anvil
export const ANVIL_RPC_URL = process.env.RPC_URL || `http://127.0.0.1:${ANVIL_PORT}`

export const ANVIL_RPC_URL_ARB = `http://127.0.0.1:${ANVIL_PORT_ARB}`

export const RELAYER_URL = process.env.RELAYER_URL || `http://127.0.0.1:${RELAYER_PORT}`

export const REMOTE_PRIVATE_KEY = process.env.REMOTE_PRIVATE_KEY
    ? parseHex(process.env.REMOTE_PRIVATE_KEY)
    : undefined

// Check if we're running against Anvil (local or fork mode)
// If RPC_URL is explicitly set to an external URL, we're in remote mode
const isRemoteRpc = !!process.env.RPC_URL && !process.env.RPC_URL.includes('127.0.0.1')

export const IS_LOCAL_MODE = TEST_CHAIN_ID === 31337 && !isRemoteRpc

export const IS_FORK_MODE = TEST_CHAIN_ID === 8453 && !isRemoteRpc

// Whether Anvil cheatcodes are available (local Anvil or Anvil forking a chain)
export const HAS_ANVIL_CHEATCODES = !isRemoteRpc && (IS_LOCAL_MODE || IS_FORK_MODE)

// Constants
export const MOCK_RECIPIENT = '0x000000000000000000000000000000000000dEaD'

// Deployment context based on chain
function getDeploymentContext(chainId: number): string {
    if (chainId === 31337) return 'local'

    if (chainId === 84532) return 'stage' // Base Sepolia

    if (chainId === 8453) return 'prod' // Base mainnet

    return 'local'
}

// Contract addresses for the current chain
export const TEST_CONTRACTS = getTestContracts(getDeploymentContext(TEST_CHAIN_ID), TEST_CHAIN_ID)

// Get chain config based on chain ID
function getChainConfig(): Chain {
    // For known chains, use viem's chain config with our RPC override
    if (TEST_CHAIN_ID === 8453) {
        return {
            ...base,
            rpcUrls: {
                default: { http: [ANVIL_RPC_URL] },
            },
        }
    }

    if (TEST_CHAIN_ID === 84532) {
        return {
            ...baseSepolia,
            rpcUrls: {
                default: { http: [ANVIL_RPC_URL] },
            },
        }
    }

    // Default: local Anvil or fork
    return {
        id: TEST_CHAIN_ID,
        name: IS_FORK_MODE ? 'Anvil (Base Fork)' : 'Anvil (Local)',
        nativeCurrency: {
            decimals: 18,
            name: 'Ether',
            symbol: 'ETH',
        },
        rpcUrls: {
            default: {
                http: [ANVIL_RPC_URL],
            },
        },
    }
}

export const testChain: Chain = getChainConfig()

// Output chain for crosschain tests (second Anvil instance)
export const outputChain: Chain = {
    id: OUTPUT_CHAIN_ID,
    name: 'Anvil (Arbitrum Local)',
    nativeCurrency: {
        decimals: 18,
        name: 'Ether',
        symbol: 'ETH',
    },
    rpcUrls: {
        default: {
            http: [ANVIL_RPC_URL_ARB],
        },
    },
}

// Test accounts (Anvil default accounts)
export const TEST_ACCOUNTS = {
    deployer: {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    },
    relayer: {
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    },
    user1: {
        address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    },
    user2: {
        address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
        privateKey: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    },
} as const

// Token addresses (Base mainnet - only available in fork mode)
export const TOKENS = {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    WETH: '0x4200000000000000000000000000000000000006',
} as const

// Create a test public client
export function getTestPublicClient() {
    return createPublicClient({
        chain: testChain,
        transport: http(ANVIL_RPC_URL),
    })
}

// Wait for RPC to be ready
async function waitForRpc(maxWaitMs = 30_000): Promise<boolean> {
    const client = getTestPublicClient()
    const start = Date.now()

    while (Date.now() - start < maxWaitMs) {
        try {
            await client.getChainId()

            return true
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }

    return false
}

// Wait for relayer to be ready
async function waitForRelayer(maxWaitMs = 30_000): Promise<boolean> {
    const start = Date.now()

    while (Date.now() - start < maxWaitMs) {
        try {
            const response = await fetch(`${RELAYER_URL}/health`)

            if (response.ok) {
                return true
            }
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }

    return false
}

// Get mode description for logging
function getModeDescription(): string {
    if (IS_LOCAL_MODE) return 'local'

    if (IS_FORK_MODE) return 'fork'

    if (TEST_CHAIN_ID === 84532) return 'Base Sepolia (remote)'

    if (TEST_CHAIN_ID === 8453) return 'Base mainnet (remote)'

    return `chain ${TEST_CHAIN_ID}`
}

// Global setup
beforeAll(async () => {
    // Check if RPC is accessible
    const rpcReady = await waitForRpc()

    if (!rpcReady) {
        if (IS_LOCAL_MODE) {
            console.warn('\n⚠️  Anvil not running. Start it with: ./scripts/local-dev.sh\n')
            throw new Error('Anvil not running')
        } else {
            console.warn(`\n⚠️  RPC not accessible at ${ANVIL_RPC_URL}\n`)
            throw new Error('RPC not accessible')
        }
    }

    // Check if relayer is running
    const relayerReady = await waitForRelayer()

    if (!relayerReady) {
        if (IS_LOCAL_MODE) {
            console.warn('\n⚠️  Relayer not running. Start it with: ./scripts/local-dev.sh\n')
        } else {
            console.warn(`\n⚠️  Relayer not accessible at ${RELAYER_URL}\n`)
        }

        throw new Error('Relayer not running')
    }

    console.log(
        `✓ RPC and Relayer are ready (chain ID: ${TEST_CHAIN_ID}, mode: ${getModeDescription()})`,
    )
})

afterAll(async () => {
    // Cleanup if needed
})
