/**
 * Unit tests for config validation functions
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@agentic-payments/contracts/deployments', () => ({
    hasDeployment: (context: string, chainId: number) => context === 'stage' && chainId === 84532,
}))

vi.mock('../src/config/addresses', () => ({
    getContractAddresses: vi.fn((env: Record<string, string | undefined>, chainId: number) => {
        const orchestratorKey = `ORCHESTRATOR_${chainId}`
        if (!env[orchestratorKey] && !(chainId === 84532 && env.CONTEXT === 'stage')) {
            throw new Error('missing deployment')
        }
        return {
            orchestrator: env[orchestratorKey] ?? '0x0000000000000000000000000000000000000001',
            simpleFunder: '0x0000000000000000000000000000000000000002',
            simulator: '0x0000000000000000000000000000000000000003',
            account: '0x0000000000000000000000000000000000000004',
            accountProxy: '0x0000000000000000000000000000000000000005',
            simpleSettler: '0x0000000000000000000000000000000000000006',
            escrow: '0x0000000000000000000000000000000000000007',
            multiSigSigner: '0x0000000000000000000000000000000000000008',
        }
    }),
}))
import { validateEnv, validatePoolConfig } from '../src/config'
import { getGasConfig, type Env } from '../src/types/env'

/**
 * Create a minimal mock Env for testing
 * Only includes string properties we need for validation
 */
function createMockEnv(overrides: Partial<Record<string, string>> = {}): Env {
    return {
        // Required - use Base Sepolia (84532) with 'stage' context which has bundled deployment
        RPC_URL: 'http://localhost:8545',
        CHAIN_IDS: '84532',
        RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
        CONTEXT: 'stage',
        ORCHESTRATOR_84532: '0x3456789012345678901234567890123456789012',
        SIMPLE_FUNDER_84532: '0x4567890123456789012345678901234567890123',
        SIMULATOR_84532: '0x5678901234567890123456789012345678901234',
        ACCOUNT_84532: '0x1234567890123456789012345678901234567890',
        ACCOUNT_PROXY_84532: '0x2345678901234567890123456789012345678901',
        SIMPLE_SETTLER_84532: '0x6789012345678901234567890123456789012345',
        ESCROW_84532: '0x7890123456789012345678901234567890123456',
        MULTI_SIG_SIGNER_84532: '0x8901234567890123456789012345678901234567',
        // Durable Objects (mocked - cast to unknown since tests don't use them)
        SIGNER: {},
        SIGNER_POOL: {},
        INTENT_NONCE_MANAGER: {},
        MONITOR_QUEUE: {},
        ...overrides,
    } as unknown as Env
}

describe('validateEnv', () => {
    it('validates complete environment', () => {
        const env = createMockEnv()
        const result = validateEnv(env)
        expect(result.valid).toBe(true)
        expect(result.missing).toHaveLength(0)
    })

    it('reports missing RPC_URL', () => {
        const env = createMockEnv({ RPC_URL: '' })
        const result = validateEnv(env)
        expect(result.valid).toBe(false)
        expect(result.missing).toContain('RPC_84532 or RPC_URL')
    })

    it('reports missing CHAIN_IDS', () => {
        const env = createMockEnv({ CHAIN_IDS: '' })
        const result = validateEnv(env)
        expect(result.valid).toBe(false)
        expect(result.missing).toContain('CHAIN_IDS')
    })

    it('reports missing RELAYER_MNEMONIC', () => {
        const env = createMockEnv({ RELAYER_MNEMONIC: '' })
        const result = validateEnv(env)
        expect(result.valid).toBe(false)
        expect(result.missing).toContain('RELAYER_MNEMONIC')
    })

    it('reports multiple missing variables', () => {
        const env = createMockEnv({
            RPC_URL: '',
            CHAIN_IDS: '',
            RELAYER_MNEMONIC: '',
        })
        const result = validateEnv(env)
        expect(result.valid).toBe(false)
        expect(result.missing).toContain('CHAIN_IDS')
        expect(result.missing).toContain('RELAYER_MNEMONIC')
    })

    it('requires ORCHESTRATOR for unknown chains', () => {
        // Chain 999999 has no bundled deployment
        const env = createMockEnv({ CHAIN_IDS: '999999' })
        const result = validateEnv(env)
        expect(result.valid).toBe(false)
        expect(result.missing.some((m) => m.includes('ORCHESTRATOR_999999'))).toBe(true)
    })

    it('does not require ORCHESTRATOR for known chains', () => {
        // Chain 84532 (Base Sepolia) has bundled deployment in 'stage' context
        const env = createMockEnv({ CHAIN_IDS: '84532', CONTEXT: 'stage' })
        const result = validateEnv(env)
        expect(result.valid).toBe(true)
    })

    it('accepts ORCHESTRATOR override for unknown chains', () => {
        const env = createMockEnv({
            CHAIN_IDS: '999999',
            ORCHESTRATOR_999999: '0x1234567890123456789012345678901234567890',
            SIMPLE_FUNDER_999999: '0x4567890123456789012345678901234567890123',
            SIMULATOR_999999: '0x5678901234567890123456789012345678901234',
            ACCOUNT_999999: '0x1234567890123456789012345678901234567890',
            ACCOUNT_PROXY_999999: '0x2345678901234567890123456789012345678901',
            SIMPLE_SETTLER_999999: '0x6789012345678901234567890123456789012345',
            ESCROW_999999: '0x7890123456789012345678901234567890123456',
            MULTI_SIG_SIGNER_999999: '0x8901234567890123456789012345678901234567',
        })
        const result = validateEnv(env)
        expect(result.valid).toBe(true)
    })

    it('requires PRIVY_APP_ID when PRIVY_ENABLED=true', () => {
        const env = createMockEnv({
            PRIVY_ENABLED: 'true',
            PRIVY_APP_ID: '',
            PRIVY_APP_SECRET: 'secret_123',
        })
        const result = validateEnv(env)
        expect(result.valid).toBe(false)
        expect(result.missing).toContain('PRIVY_APP_ID')
    })

    it('requires PRIVY_APP_SECRET when PRIVY_ENABLED=true', () => {
        const env = createMockEnv({
            PRIVY_ENABLED: 'true',
            PRIVY_APP_ID: 'app_123',
            PRIVY_APP_SECRET: '',
        })
        const result = validateEnv(env)
        expect(result.valid).toBe(false)
        expect(result.missing).toContain('PRIVY_APP_SECRET')
    })

    it('accepts Privy config when PRIVY_ENABLED=true and all fields are set', () => {
        const env = createMockEnv({
            PRIVY_ENABLED: 'true',
            PRIVY_APP_ID: 'app_123',
            PRIVY_APP_SECRET: 'secret_123',
        })
        const result = validateEnv(env)
        expect(result.valid).toBe(true)
    })

    it('does not require Privy credentials when PRIVY_ENABLED=false', () => {
        const env = createMockEnv({
            PRIVY_ENABLED: 'false',
            PRIVY_APP_ID: '',
            PRIVY_APP_SECRET: '',
        })
        const result = validateEnv(env)
        expect(result.valid).toBe(true)
    })
})

describe('validatePoolConfig', () => {
    it('validates complete pool config', () => {
        const env = createMockEnv()
        const result = validatePoolConfig(env)
        expect(result.valid).toBe(true)
        expect(result.errors).toHaveLength(0)
    })

    describe('RELAYER_COUNT validation', () => {
        it('accepts default value (1)', () => {
            const env = createMockEnv()
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('accepts valid count within range', () => {
            const env = createMockEnv({ RELAYER_COUNT: '10' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('accepts count at lower bound (1)', () => {
            const env = createMockEnv({ RELAYER_COUNT: '1' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('accepts count at upper bound (100)', () => {
            const env = createMockEnv({ RELAYER_COUNT: '100' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('rejects count below lower bound (0)', () => {
            const env = createMockEnv({ RELAYER_COUNT: '0' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors).toContain('RELAYER_COUNT must be a number between 1 and 100')
        })

        it('rejects count above upper bound (101)', () => {
            const env = createMockEnv({ RELAYER_COUNT: '101' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors).toContain('RELAYER_COUNT must be a number between 1 and 100')
        })

        it('rejects non-numeric count', () => {
            const env = createMockEnv({ RELAYER_COUNT: 'abc' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors).toContain('RELAYER_COUNT must be a number between 1 and 100')
        })

        it('rejects negative count', () => {
            const env = createMockEnv({ RELAYER_COUNT: '-5' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
        })
    })

    describe('MAX_PENDING_PER_SIGNER validation', () => {
        it('accepts default value (16)', () => {
            const env = createMockEnv()
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('accepts valid positive value', () => {
            const env = createMockEnv({ MAX_PENDING_PER_SIGNER: '32' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('accepts minimum value (1)', () => {
            const env = createMockEnv({ MAX_PENDING_PER_SIGNER: '1' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('rejects zero', () => {
            const env = createMockEnv({ MAX_PENDING_PER_SIGNER: '0' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors).toContain('MAX_PENDING_PER_SIGNER must be a positive number')
        })

        it('rejects non-numeric value', () => {
            const env = createMockEnv({ MAX_PENDING_PER_SIGNER: 'many' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors).toContain('MAX_PENDING_PER_SIGNER must be a positive number')
        })
    })

    describe('MAX_PENDING_TOTAL validation', () => {
        it('accepts default value (1000)', () => {
            const env = createMockEnv()
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('accepts value equal to RELAYER_COUNT', () => {
            const env = createMockEnv({
                RELAYER_COUNT: '5',
                MAX_PENDING_TOTAL: '5',
            })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('accepts value greater than RELAYER_COUNT', () => {
            const env = createMockEnv({
                RELAYER_COUNT: '5',
                MAX_PENDING_TOTAL: '100',
            })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('rejects value less than RELAYER_COUNT', () => {
            const env = createMockEnv({
                RELAYER_COUNT: '10',
                MAX_PENDING_TOTAL: '5',
            })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors).toContain('MAX_PENDING_TOTAL must be >= RELAYER_COUNT')
        })
    })

    describe('MIN_SIGNER_BALANCE validation', () => {
        it('accepts default (not set)', () => {
            const env = createMockEnv()
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('accepts valid wei value', () => {
            const env = createMockEnv({ MIN_SIGNER_BALANCE: '10000000000000000' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('accepts zero', () => {
            const env = createMockEnv({ MIN_SIGNER_BALANCE: '0' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('accepts large value', () => {
            const env = createMockEnv({ MIN_SIGNER_BALANCE: '1000000000000000000' }) // 1 ETH
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('rejects non-numeric value', () => {
            const env = createMockEnv({ MIN_SIGNER_BALANCE: 'abc' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors).toContain('MIN_SIGNER_BALANCE must be a valid integer (in wei)')
        })

        it('rejects decimal value', () => {
            const env = createMockEnv({ MIN_SIGNER_BALANCE: '0.01' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors).toContain('MIN_SIGNER_BALANCE must be a valid integer (in wei)')
        })

        it('rejects negative value', () => {
            const env = createMockEnv({ MIN_SIGNER_BALANCE: '-1000000000000000' })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors).toContain('MIN_SIGNER_BALANCE must be non-negative')
        })
    })

    describe('TARGET_SIGNER_BALANCE validation', () => {
        it('accepts valid TARGET_SIGNER_BALANCE greater than MIN_SIGNER_BALANCE', () => {
            const env = createMockEnv({
                MIN_SIGNER_BALANCE: '10000000000000000', // 0.01 ETH in wei
                TARGET_SIGNER_BALANCE: '0.1', // 0.1 ETH
            })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('rejects TARGET_SIGNER_BALANCE equal to MIN_SIGNER_BALANCE', () => {
            const env = createMockEnv({
                MIN_SIGNER_BALANCE: '100000000000000000', // 0.1 ETH in wei
                TARGET_SIGNER_BALANCE: '0.1', // 0.1 ETH (same as min)
            })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors.some((e) => e.includes('TARGET_SIGNER_BALANCE'))).toBe(true)
        })

        it('rejects TARGET_SIGNER_BALANCE less than MIN_SIGNER_BALANCE', () => {
            const env = createMockEnv({
                MIN_SIGNER_BALANCE: '200000000000000000', // 0.2 ETH in wei
                TARGET_SIGNER_BALANCE: '0.1', // 0.1 ETH (less than min)
            })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors.some((e) => e.includes('TARGET_SIGNER_BALANCE'))).toBe(true)
        })

        it('accepts TARGET_SIGNER_BALANCE when MIN_SIGNER_BALANCE is not set', () => {
            const env = createMockEnv({
                TARGET_SIGNER_BALANCE: '0.1',
            })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(true)
        })

        it('rejects invalid TARGET_SIGNER_BALANCE format', () => {
            const env = createMockEnv({
                MIN_SIGNER_BALANCE: '10000000000000000',
                TARGET_SIGNER_BALANCE: 'not-a-number',
            })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors.some((e) => e.includes('TARGET_SIGNER_BALANCE'))).toBe(true)
        })
    })

    describe('multiple errors', () => {
        it('reports all validation errors', () => {
            const env = createMockEnv({
                RELAYER_COUNT: '0',
                MAX_PENDING_PER_SIGNER: '0',
            })
            const result = validatePoolConfig(env)
            expect(result.valid).toBe(false)
            expect(result.errors.length).toBeGreaterThanOrEqual(2)
        })
    })
})

describe('getGasConfig', () => {
    it('uses robust defaults', () => {
        const env = createMockEnv()
        const gasConfig = getGasConfig(env)
        expect(gasConfig.intentGasBuffer).toBe(50_000n)
        expect(gasConfig.paymentGasBuffer).toBe(70_000n)
        expect(gasConfig.orchestratorOverhead).toBe(110_000n)
        expect(gasConfig.txGasBuffer).toBe(0n)
        expect(gasConfig.allowSimulationFallback).toBe(false)
    })

    it('respects PAYMENT_GAS_BUFFER override', () => {
        const env = createMockEnv({ PAYMENT_GAS_BUFFER: '12345' })
        const gasConfig = getGasConfig(env)
        expect(gasConfig.paymentGasBuffer).toBe(12_345n)
    })
})
