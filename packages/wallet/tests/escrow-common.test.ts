import { expect, mock, test } from 'bun:test'
import {
    EscrowError,
    parseEscrowId,
    parseSettlementId,
    resolveEscrowContracts,
    toEscrowError,
} from '../src/lib/escrow-common'
import { executeEscrowCreate } from '../src/lib/escrow-create'
import { executeEscrowSettle } from '../src/lib/escrow-settle'

const VALID_BYTES32 = ('0x' + '00'.repeat(32)) as const

test('parseEscrowId accepts valid 32-byte hex', () => {
    expect(parseEscrowId(VALID_BYTES32)).toBe(VALID_BYTES32)
})

test('parseEscrowId throws with escrow ID in message', () => {
    expect(() => parseEscrowId('0xab')).toThrow(EscrowError)
    expect(() => parseEscrowId('0xab')).toThrow(/Invalid escrow ID/)
})

test('parseSettlementId accepts valid 32-byte hex', () => {
    expect(parseSettlementId(VALID_BYTES32)).toBe(VALID_BYTES32)
})

test('parseSettlementId throws with settlement ID in message', () => {
    expect(() => parseSettlementId('0xab')).toThrow(EscrowError)
    expect(() => parseSettlementId('0xab')).toThrow(/Invalid settlement ID/)
})

test('toEscrowError passes through existing EscrowError', () => {
    const err = new EscrowError('INVALID_AMOUNT', 'Amount must be positive')
    const result = toEscrowError(err)
    expect(result).toBe(err)
    expect(result.code).toBe('INVALID_AMOUNT')
})

test('toEscrowError maps password messages to PASSWORD_REQUIRED', () => {
    expect(toEscrowError(new Error('No password provided on stdin')).code).toBe('PASSWORD_REQUIRED')
    expect(toEscrowError(new Error('Password required')).code).toBe('PASSWORD_REQUIRED')
    expect(toEscrowError(new Error('Password cannot be empty')).code).toBe('PASSWORD_REQUIRED')
    expect(toEscrowError(new Error('Password input cancelled')).code).toBe('PASSWORD_REQUIRED')
})

test('toEscrowError maps ENOENT / no such file to KEYSTORE_NOT_FOUND', () => {
    expect(toEscrowError(new Error('ENOENT: no such file')).code).toBe('KEYSTORE_NOT_FOUND')
    expect(toEscrowError(new Error('no such file or directory')).code).toBe('KEYSTORE_NOT_FOUND')
})

test('toEscrowError maps Unsupported chain to UNSUPPORTED_CHAIN', () => {
    expect(toEscrowError(new Error('Unsupported chain')).code).toBe('UNSUPPORTED_CHAIN')
})

test('toEscrowError maps amount-validation phrases to INVALID_AMOUNT', () => {
    expect(toEscrowError(new Error('Invalid amount')).code).toBe('INVALID_AMOUNT')
    expect(toEscrowError(new Error('Amount must be greater than zero')).code).toBe('INVALID_AMOUNT')
    expect(toEscrowError(new Error('Amount is invalid')).code).toBe('INVALID_AMOUNT')
    expect(toEscrowError(new Error('Amount supports at most 6 decimal places')).code).toBe(
        'INVALID_AMOUNT',
    )
})

test('toEscrowError does not map unrelated "Amount" messages to INVALID_AMOUNT', () => {
    const result = toEscrowError(new Error('Amount field missing in response'))
    expect(result.code).toBe('UNKNOWN')
})

test('toEscrowError maps simulation failed to INTENT_REVERTED', () => {
    expect(toEscrowError(new Error('simulation failed')).code).toBe('INTENT_REVERTED')
    expect(toEscrowError(new Error('Simulation failed')).code).toBe('INTENT_REVERTED')
})

test('toEscrowError maps timeout waiting for bundle to BUNDLE_TIMEOUT', () => {
    expect(toEscrowError(new Error('timeout waiting for bundle')).code).toBe('BUNDLE_TIMEOUT')
    expect(toEscrowError(new Error('Timeout waiting for bundle')).code).toBe('BUNDLE_TIMEOUT')
})

test('toEscrowError maps escrow-specific not-found messages to ESCROW_NOT_FOUND', () => {
    expect(toEscrowError(new Error('escrow not found')).code).toBe('ESCROW_NOT_FOUND')
    expect(toEscrowError(new Error('Escrow not found')).code).toBe('ESCROW_NOT_FOUND')
})

test('toEscrowError does not map generic "not found" to ESCROW_NOT_FOUND', () => {
    expect(toEscrowError(new Error('not found')).code).toBe('UNKNOWN')
    expect(toEscrowError(new Error('Contract not found')).code).toBe('UNKNOWN')
    expect(toEscrowError(new Error('Method not found')).code).toBe('UNKNOWN')
    expect(toEscrowError(new Error('Token not found')).code).toBe('UNKNOWN')
})

test('toEscrowError maps unknown message to UNKNOWN', () => {
    const result = toEscrowError(new Error('Something else'))
    expect(result.code).toBe('UNKNOWN')
    expect(result.message).toBe('Something else')
})

test('toEscrowError handles non-Error throwables', () => {
    const result = toEscrowError('string error')
    expect(result.code).toBe('UNKNOWN')
    expect(result.message).toBe('string error')
})

test('executeEscrowCreate rejects relative deadline 0 (0m, 0h, 0d, 0w)', async () => {
    const zeroAddress = '0x0000000000000000000000000000000000000000'
    const mockChainNetworkContracts = {
        chain: 'base' as const,
        network: {
            env: 'dev' as const,
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'http://127.0.0.1:8545',
            chainId: 31337,
        },
        contracts: {
            escrowAddress: zeroAddress,
            simpleSettlerAddress: zeroAddress,
            usdcAddress: zeroAddress,
        },
    }
    const baseOptions = {
        env: 'dev' as const,
        amount: '1',
        seller: '0x1111111111111111111111111111111111111111',
        oracle: '0x2222222222222222222222222222222222222222',
        keystorePath: '/tmp/keystore.json',
    }
    const zeroDurations = ['0m', '0h', '0d', '0w']
    for (const deadline of zeroDurations) {
        const err = await executeEscrowCreate(
            { ...baseOptions, deadline },
            {
                resolveEscrowChainNetworkContracts: mock(() => mockChainNetworkContracts),
            },
        ).catch((e) => e)
        expect(err).toBeInstanceOf(EscrowError)
        expect((err as EscrowError).code).toBe('INVALID_ARGUMENT')
        expect((err as EscrowError).message).toMatch(/at least 1/)
    }
})

test('executeEscrowCreate rejects malformed absolute deadline timestamps', async () => {
    const zeroAddress = '0x0000000000000000000000000000000000000000'
    const mockChainNetworkContracts = {
        chain: 'base' as const,
        network: {
            env: 'dev' as const,
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'http://127.0.0.1:8545',
            chainId: 31337,
        },
        contracts: {
            escrowAddress: zeroAddress,
            simpleSettlerAddress: zeroAddress,
            usdcAddress: zeroAddress,
        },
    }

    const err = await executeEscrowCreate(
        {
            env: 'dev',
            amount: '1',
            seller: '0x1111111111111111111111111111111111111111',
            oracle: '0x2222222222222222222222222222222222222222',
            deadline: '1700000000abc',
            keystorePath: '/tmp/keystore.json',
        },
        {
            resolveEscrowChainNetworkContracts: mock(() => mockChainNetworkContracts),
        },
    ).catch((error) => error)

    expect(err).toBeInstanceOf(EscrowError)
    expect((err as EscrowError).code).toBe('INVALID_ARGUMENT')
    expect((err as EscrowError).message).toMatch(/Invalid deadline/)
})

test('executeEscrowCreate trims relative deadline input before validation', async () => {
    const zeroAddress = '0x0000000000000000000000000000000000000000'
    const mockChainNetworkContracts = {
        chain: 'base' as const,
        network: {
            env: 'dev' as const,
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'http://127.0.0.1:8545',
            chainId: 31337,
        },
        contracts: {
            escrowAddress: zeroAddress,
            simpleSettlerAddress: zeroAddress,
            usdcAddress: zeroAddress,
        },
    }

    const err = await executeEscrowCreate(
        {
            env: 'dev',
            amount: '1',
            seller: '0x1111111111111111111111111111111111111111',
            oracle: '0x2222222222222222222222222222222222222222',
            deadline: ' 1h ',
            keystorePath: '/tmp/keystore.json',
        },
        {
            resolveEscrowChainNetworkContracts: mock(() => mockChainNetworkContracts),
        },
    ).catch((error) => error)

    expect(err).toBeInstanceOf(EscrowError)
    expect((err as EscrowError).code).not.toBe('INVALID_ARGUMENT')
})

test('resolveEscrowContracts uses dev deployment context', () => {
    const contracts = resolveEscrowContracts('dev', 84532, 'base')
    expect(contracts.escrowAddress).toBe('0x05f9597eed844410b7c0746A1C584188d0644730')
    expect(contracts.simpleSettlerAddress).toBe('0x90cacD85C1dc93af2D2D3e6c380162bBe07bb329')
})

test('executeEscrowSettle rejects mismatched oracle private key', async () => {
    const zeroAddress = '0x0000000000000000000000000000000000000000'
    const mockChainNetworkContracts = {
        chain: 'base' as const,
        network: {
            env: 'dev' as const,
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'http://127.0.0.1:8545',
            chainId: 31337,
        },
        contracts: {
            escrowAddress: zeroAddress,
            simpleSettlerAddress: zeroAddress,
            usdcAddress: zeroAddress,
        },
    }

    const err = await executeEscrowSettle(
        {
            env: 'dev',
            escrowId: VALID_BYTES32,
            settlementId: VALID_BYTES32,
            oracle: '0x2222222222222222222222222222222222222222',
            oraclePrivateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
            keystorePath: '/tmp/keystore.json',
        },
        {
            resolveEscrowChainNetworkContracts: mock(() => mockChainNetworkContracts),
        },
    ).catch((error) => error)

    expect(err).toBeInstanceOf(EscrowError)
    expect((err as EscrowError).code).toBe('INVALID_ARGUMENT')
    expect((err as EscrowError).message).toMatch(/does not match --oracle/)
})
