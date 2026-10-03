/**
 * Unit tests for batch execute optimization
 *
 * Tests the batch intent grouping and encoding for the execute(bytes[]) function.
 */

import { describe, it, expect } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, type Address, type Hex, zeroAddress } from 'viem'
import { orchestratorAbi } from '@towns-labs/contracts/abis'
import type { IntentStruct } from '../src/types/pool'

/**
 * Encode a single intent to bytes (for the execute(bytes) or execute(bytes[]) calls)
 * This mirrors the encoding in SignerDO.signAndBroadcast
 */
function encodeIntent(intent: IntentStruct): Hex {
    // Convert calls to executionData
    const calls = intent.calls.map((call) => ({
        to: call.to as Address,
        value: call.value ? BigInt(call.value) : 0n,
        data: (call.data ?? '0x') as Hex,
    }))

    const executionData = encodeAbiParameters(
        [
            {
                type: 'tuple[]',
                components: [
                    { name: 'to', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'data', type: 'bytes' },
                ],
            },
        ],
        [calls],
    )

    // Build full intent struct
    const intentForContract = {
        eoa: intent.eoa as Address,
        executionData,
        nonce: BigInt(intent.nonce),
        payer: (intent.payer ?? zeroAddress) as Address,
        paymentToken: (intent.paymentToken ?? zeroAddress) as Address,
        paymentMaxAmount: BigInt(intent.paymentMaxAmount ?? '0'),
        combinedGas: BigInt(intent.combinedGas),
        encodedPreCalls: (intent.encodedPreCalls ?? []) as Hex[],
        encodedFundTransfers: (intent.encodedFundTransfers ?? []) as Hex[],
        settler: (intent.settler ?? zeroAddress) as Address,
        expiry: BigInt(intent.expiry ?? '0'),
        isMultichain: intent.isMultichain ?? false,
        funder: (intent.funder ?? zeroAddress) as Address,
        funderSignature: (intent.funderSignature ?? '0x') as Hex,
        settlerContext: (intent.settlerContext ?? '0x') as Hex,
        paymentAmount: BigInt(intent.paymentAmount ?? '0'),
        paymentRecipient: (intent.paymentRecipient ?? zeroAddress) as Address,
        signature: intent.signature as Hex,
        paymentSignature: (intent.paymentSignature ?? '0x') as Hex,
        supportedAccountImplementation: (intent.supportedAccountImplementation ??
            zeroAddress) as Address,
    }

    return encodeAbiParameters(
        [
            {
                type: 'tuple',
                components: [
                    { name: 'eoa', type: 'address' },
                    { name: 'executionData', type: 'bytes' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'payer', type: 'address' },
                    { name: 'paymentToken', type: 'address' },
                    { name: 'paymentMaxAmount', type: 'uint256' },
                    { name: 'combinedGas', type: 'uint256' },
                    { name: 'encodedPreCalls', type: 'bytes[]' },
                    { name: 'encodedFundTransfers', type: 'bytes[]' },
                    { name: 'settler', type: 'address' },
                    { name: 'expiry', type: 'uint256' },
                    { name: 'isMultichain', type: 'bool' },
                    { name: 'funder', type: 'address' },
                    { name: 'funderSignature', type: 'bytes' },
                    { name: 'settlerContext', type: 'bytes' },
                    { name: 'paymentAmount', type: 'uint256' },
                    { name: 'paymentRecipient', type: 'address' },
                    { name: 'signature', type: 'bytes' },
                    { name: 'paymentSignature', type: 'bytes' },
                    { name: 'supportedAccountImplementation', type: 'address' },
                ],
            },
        ],
        [intentForContract],
    )
}

/**
 * Encode batch execute calldata for Orchestrator.execute(bytes[])
 */
function encodeBatchExecute(encodedIntents: Hex[]): Hex {
    return encodeFunctionData({
        abi: orchestratorAbi,
        functionName: 'execute',
        args: [encodedIntents],
    })
}

/**
 * Create a test intent
 */
function createTestIntent(overrides: Partial<IntentStruct> = {}): IntentStruct {
    return {
        eoa: '0x1111111111111111111111111111111111111111' as Address,
        calls: [
            {
                to: '0x2222222222222222222222222222222222222222' as Address,
                value: '0',
                data: '0x' as Hex,
            },
        ],
        nonce: '1',
        combinedGas: '500000',
        expiry: '1700000000',
        signature: ('0x' + 'ab'.repeat(65)) as Hex,
        ...overrides,
    }
}

describe('encodeIntent', () => {
    it('encodes a simple intent to bytes', () => {
        const intent = createTestIntent()
        const encoded = encodeIntent(intent)

        expect(encoded).toMatch(/^0x/)
        expect(encoded.length).toBeGreaterThan(66) // More than just a hash
    })

    it('encodes intent with multiple calls', () => {
        const intent = createTestIntent({
            calls: [
                {
                    to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address,
                    value: '100',
                    data: '0x1234' as Hex,
                },
                {
                    to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address,
                    value: '200',
                    data: '0x5678' as Hex,
                },
                {
                    to: '0xcccccccccccccccccccccccccccccccccccccccc' as Address,
                    value: '0',
                    data: '0xabcd' as Hex,
                },
            ],
        })
        const encoded = encodeIntent(intent)

        expect(encoded).toMatch(/^0x/)
        // Multiple calls should result in longer encoding
        const singleCallIntent = createTestIntent()
        const singleEncoded = encodeIntent(singleCallIntent)
        expect(encoded.length).toBeGreaterThan(singleEncoded.length)
    })

    it('produces deterministic encoding', () => {
        const intent = createTestIntent()
        const encoded1 = encodeIntent(intent)
        const encoded2 = encodeIntent(intent)

        expect(encoded1).toBe(encoded2)
    })

    it('different intents produce different encodings', () => {
        const intent1 = createTestIntent({ nonce: '1' })
        const intent2 = createTestIntent({ nonce: '2' })

        const encoded1 = encodeIntent(intent1)
        const encoded2 = encodeIntent(intent2)

        expect(encoded1).not.toBe(encoded2)
    })
})

describe('encodeBatchExecute', () => {
    it('encodes single intent for batch call', () => {
        const intent = createTestIntent()
        const encoded = encodeIntent(intent)
        const batchCalldata = encodeBatchExecute([encoded])

        expect(batchCalldata).toMatch(/^0x/)
        // Should start with the execute(bytes[]) selector
        // The selector for execute(bytes[]) is different from execute(bytes)
    })

    it('encodes multiple intents for batch call', () => {
        const intents = [
            createTestIntent({ eoa: '0x1111111111111111111111111111111111111111' as Address }),
            createTestIntent({ eoa: '0x2222222222222222222222222222222222222222' as Address }),
            createTestIntent({ eoa: '0x3333333333333333333333333333333333333333' as Address }),
        ]

        const encodedIntents = intents.map(encodeIntent)
        const batchCalldata = encodeBatchExecute(encodedIntents)

        expect(batchCalldata).toMatch(/^0x/)
    })

    it('batch encoding is larger than single intent encoding', () => {
        const intent = createTestIntent()
        const encoded = encodeIntent(intent)

        // Single execute(bytes)
        const singleCalldata = encodeFunctionData({
            abi: orchestratorAbi,
            functionName: 'execute',
            args: [encoded],
        })

        // Batch execute(bytes[]) with same intent
        const batchCalldata = encodeBatchExecute([encoded])

        // Batch has array overhead
        expect(batchCalldata.length).toBeGreaterThan(singleCalldata.length)
    })

    it('handles empty array', () => {
        const batchCalldata = encodeBatchExecute([])
        expect(batchCalldata).toMatch(/^0x/)
    })
})

describe('batch intent grouping', () => {
    /**
     * Group intents by EOA for per-EOA ordering
     */
    function groupIntentsByEoa(intents: IntentStruct[]): Map<Address, IntentStruct[]> {
        const groups = new Map<Address, IntentStruct[]>()
        for (const intent of intents) {
            const eoa = intent.eoa as Address
            const existing = groups.get(eoa) ?? []
            existing.push(intent)
            groups.set(eoa, existing)
        }
        return groups
    }

    it('groups intents by EOA', () => {
        const intents = [
            createTestIntent({ eoa: '0x1111111111111111111111111111111111111111' as Address }),
            createTestIntent({ eoa: '0x2222222222222222222222222222222222222222' as Address }),
            createTestIntent({ eoa: '0x1111111111111111111111111111111111111111' as Address }),
        ]

        const groups = groupIntentsByEoa(intents)

        expect(groups.size).toBe(2)
        expect(groups.get('0x1111111111111111111111111111111111111111' as Address)).toHaveLength(2)
        expect(groups.get('0x2222222222222222222222222222222222222222' as Address)).toHaveLength(1)
    })

    it('handles all unique EOAs', () => {
        const intents = [
            createTestIntent({ eoa: '0x1111111111111111111111111111111111111111' as Address }),
            createTestIntent({ eoa: '0x2222222222222222222222222222222222222222' as Address }),
            createTestIntent({ eoa: '0x3333333333333333333333333333333333333333' as Address }),
        ]

        const groups = groupIntentsByEoa(intents)

        expect(groups.size).toBe(3)
    })

    it('handles all same EOA', () => {
        const intents = [
            createTestIntent({ eoa: '0x1111111111111111111111111111111111111111' as Address }),
            createTestIntent({ eoa: '0x1111111111111111111111111111111111111111' as Address }),
            createTestIntent({ eoa: '0x1111111111111111111111111111111111111111' as Address }),
        ]

        const groups = groupIntentsByEoa(intents)

        expect(groups.size).toBe(1)
        expect(groups.get('0x1111111111111111111111111111111111111111' as Address)).toHaveLength(3)
    })

    it('handles empty input', () => {
        const groups = groupIntentsByEoa([])
        expect(groups.size).toBe(0)
    })
})

describe('batch result mapping', () => {
    /**
     * Map a single batch result back to individual intent results
     */
    function mapBatchResultToIntents(
        intentIds: string[],
        batchResult: { txHash: Hex; success: boolean },
    ): Array<{ id: string; txHash: Hex; success: boolean }> {
        return intentIds.map((id) => ({
            id,
            txHash: batchResult.txHash,
            success: batchResult.success,
        }))
    }

    it('maps single batch tx to multiple intent results', () => {
        const intentIds = ['intent-1', 'intent-2', 'intent-3']
        const batchResult = {
            txHash: '0xabc123' as Hex,
            success: true,
        }

        const results = mapBatchResultToIntents(intentIds, batchResult)

        expect(results).toHaveLength(3)
        expect(results[0]).toEqual({ id: 'intent-1', txHash: '0xabc123', success: true })
        expect(results[1]).toEqual({ id: 'intent-2', txHash: '0xabc123', success: true })
        expect(results[2]).toEqual({ id: 'intent-3', txHash: '0xabc123', success: true })
    })

    it('maps failed batch to all failed intents', () => {
        const intentIds = ['intent-1', 'intent-2']
        const batchResult = {
            txHash: '0x0' as Hex,
            success: false,
        }

        const results = mapBatchResultToIntents(intentIds, batchResult)

        expect(results.every((r) => r.success === false)).toBe(true)
    })

    it('handles single intent', () => {
        const results = mapBatchResultToIntents(['intent-1'], {
            txHash: '0x123' as Hex,
            success: true,
        })
        expect(results).toHaveLength(1)
    })

    it('handles empty array', () => {
        const results = mapBatchResultToIntents([], { txHash: '0x123' as Hex, success: true })
        expect(results).toHaveLength(0)
    })
})

describe('batch detection in JSON-RPC requests', () => {
    /**
     * Check if a batch of JSON-RPC requests can be optimized
     * (all are wallet_sendPreparedCalls with same chain)
     */
    function canOptimizeBatch(requests: Array<{ method: string; params?: unknown }>): boolean {
        if (requests.length <= 1) return false
        return requests.every((r) => r.method === 'wallet_sendPreparedCalls')
    }

    it('returns true for multiple sendPreparedCalls', () => {
        const requests = [
            { method: 'wallet_sendPreparedCalls', params: {} },
            { method: 'wallet_sendPreparedCalls', params: {} },
            { method: 'wallet_sendPreparedCalls', params: {} },
        ]

        expect(canOptimizeBatch(requests)).toBe(true)
    })

    it('returns false for mixed methods', () => {
        const requests = [
            { method: 'wallet_sendPreparedCalls', params: {} },
            { method: 'wallet_getCallsStatus', params: {} },
        ]

        expect(canOptimizeBatch(requests)).toBe(false)
    })

    it('returns false for single request', () => {
        const requests = [{ method: 'wallet_sendPreparedCalls', params: {} }]

        expect(canOptimizeBatch(requests)).toBe(false)
    })

    it('returns false for empty batch', () => {
        expect(canOptimizeBatch([])).toBe(false)
    })

    it('returns false for all different methods', () => {
        const requests = [
            { method: 'wallet_prepareCalls', params: {} },
            { method: 'wallet_getCallsStatus', params: {} },
        ]

        expect(canOptimizeBatch(requests)).toBe(false)
    })
})
