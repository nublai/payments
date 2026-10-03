/**
 * Unit tests for hashQuotes() function
 * TDD: Tests written first before implementation
 */

import { describe, it, expect } from 'vitest'
import type { SignedQuotes, Quote, QuoteIntent } from '../../src/rpc/methods/sendPreparedCalls'
import type { RelayerConfig } from '../../src/types/env'
import { hashQuotes } from '../../src/rpc/methods/sendPreparedCalls'

describe('hashQuotes', () => {
    const mockConfig: RelayerConfig = {
        rpcUrl: 'https://example.com/rpc',
        chainId: 8453,
        contracts: {
            account: '0x1234567890123456789012345678901234567890',
            accountProxy: '0x2345678901234567890123456789012345678901',
            orchestrator: '0x3456789012345678901234567890123456789012',
            simpleFunder: '0x4567890123456789012345678901234567890123',
            simulator: '0x5678901234567890123456789012345678901234',
            simpleSettler: '0x6789012345678901234567890123456789012345',
            escrow: '0x7890123456789012345678901234567890123456',
            multiSigSigner: '0x8901234567890123456789012345678901234567',
        },
    }

    const createMockQuoteIntent = (): QuoteIntent => ({
        eoa: '0x1234567890123456789012345678901234567890',
        calls: [
            {
                to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                value: '0x0',
                data: '0xa9059cbb000000000000000000000000recipient0000000000000000000000000000000000000000000000000000000005f5e100',
            },
        ],
        nonce: '1',
        combinedGas: '100000',
        expiry: '1735689600',
    })

    const createMockQuote = (overrides?: Partial<Quote>): Quote => ({
        chainId: '0x2105',
        intent: createMockQuoteIntent(),
        extraPayment: '0x0',
        ethPrice: '0x0',
        paymentTokenDecimals: 18,
        txGas: 100000,
        nativeFeeEstimate: {
            maxFeePerGas: 1000000000,
            maxPriorityFeePerGas: 100000000,
        },
        paymentAmount: '0',
        orchestrator: '0x3456789012345678901234567890123456789012',
        feeTokenDeficit: '0x0',
        assetDeficits: [],
        ...overrides,
    })

    const createMockSignedQuotes = (overrides?: Partial<SignedQuotes>): SignedQuotes => ({
        quotes: [createMockQuote()],
        signature: '0x',
        ttl: 1735689600,
        ...overrides,
    })

    describe('deterministic hashing', () => {
        it('should produce the same hash for identical quotes', () => {
            const quotes1 = createMockSignedQuotes()
            const quotes2 = createMockSignedQuotes()

            const hash1 = hashQuotes(quotes1, mockConfig)
            const hash2 = hashQuotes(quotes2, mockConfig)

            expect(hash1).toBe(hash2)
        })

        it('should produce different hash when quote content changes', () => {
            const quotes1 = createMockSignedQuotes()
            const quotes2 = createMockSignedQuotes({
                quotes: [
                    createMockQuote({
                        extraPayment: '0x1',
                    }),
                ],
            })

            const hash1 = hashQuotes(quotes1, mockConfig)
            const hash2 = hashQuotes(quotes2, mockConfig)

            expect(hash1).not.toBe(hash2)
        })

        it('should ignore signature field in hash', () => {
            const quotes1 = createMockSignedQuotes({ signature: '0x' })
            const quotes2 = createMockSignedQuotes({ signature: '0x1234567890abcdef' })

            const hash1 = hashQuotes(quotes1, mockConfig)
            const hash2 = hashQuotes(quotes2, mockConfig)

            expect(hash1).toBe(hash2)
        })

        it('should ignore ttl field in hash', () => {
            const quotes1 = createMockSignedQuotes({ ttl: 1000 })
            const quotes2 = createMockSignedQuotes({ ttl: 2000 })

            const hash1 = hashQuotes(quotes1, mockConfig)
            const hash2 = hashQuotes(quotes2, mockConfig)

            expect(hash1).toBe(hash2)
        })
    })

    describe('field sensitivity', () => {
        it('should throw when quote chainId does not match relayer chain', () => {
            const quotes1 = createMockSignedQuotes({
                quotes: [createMockQuote({ chainId: '0x2105' })],
            })
            const quotes2 = createMockSignedQuotes({
                quotes: [createMockQuote({ chainId: '0x1' })],
            })

            expect(() => hashQuotes(quotes1, mockConfig)).not.toThrow()
            expect(() => hashQuotes(quotes2, mockConfig)).toThrow()
        })

        it('should produce different hash when intent changes', () => {
            const quotes1 = createMockSignedQuotes()
            const quotes2 = createMockSignedQuotes({
                quotes: [
                    createMockQuote({
                        intent: {
                            ...createMockQuoteIntent(),
                            nonce: '2',
                        },
                    }),
                ],
            })

            const hash1 = hashQuotes(quotes1, mockConfig)
            const hash2 = hashQuotes(quotes2, mockConfig)

            expect(hash1).not.toBe(hash2)
        })

        it('should produce different hash when extraPayment changes', () => {
            const quotes1 = createMockSignedQuotes({
                quotes: [createMockQuote({ extraPayment: '0x0' })],
            })
            const quotes2 = createMockSignedQuotes({
                quotes: [createMockQuote({ extraPayment: '0x1000' })],
            })

            const hash1 = hashQuotes(quotes1, mockConfig)
            const hash2 = hashQuotes(quotes2, mockConfig)

            expect(hash1).not.toBe(hash2)
        })

        it('should produce different hash when feeTokenDeficit changes', () => {
            const quotes1 = createMockSignedQuotes({
                quotes: [createMockQuote({ feeTokenDeficit: '0x0' })],
            })
            const quotes2 = createMockSignedQuotes({
                quotes: [createMockQuote({ feeTokenDeficit: '0x1000' })],
            })

            const hash1 = hashQuotes(quotes1, mockConfig)
            const hash2 = hashQuotes(quotes2, mockConfig)

            expect(hash1).not.toBe(hash2)
        })
    })

    describe('multiple quotes', () => {
        it('should handle multiple quotes', () => {
            const quotes = createMockSignedQuotes({
                quotes: [
                    createMockQuote({ chainId: '0x2105' }),
                    createMockQuote({
                        chainId: '0x2105',
                        intent: { ...createMockQuoteIntent(), nonce: '2' },
                    }),
                ],
            })

            const hash = hashQuotes(quotes, mockConfig)

            expect(hash).toBeTruthy()
            expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/)
        })

        it('should produce different hash when quote order changes', () => {
            const quotes1 = createMockSignedQuotes({
                quotes: [
                    createMockQuote({
                        chainId: '0x2105',
                        intent: { ...createMockQuoteIntent(), nonce: '1' },
                    }),
                    createMockQuote({
                        chainId: '0x2105',
                        intent: { ...createMockQuoteIntent(), nonce: '2' },
                    }),
                ],
            })
            const quotes2 = createMockSignedQuotes({
                quotes: [
                    createMockQuote({
                        chainId: '0x2105',
                        intent: { ...createMockQuoteIntent(), nonce: '2' },
                    }),
                    createMockQuote({
                        chainId: '0x2105',
                        intent: { ...createMockQuoteIntent(), nonce: '1' },
                    }),
                ],
            })

            const hash1 = hashQuotes(quotes1, mockConfig)
            const hash2 = hashQuotes(quotes2, mockConfig)

            // Order should matter for multiple quotes
            expect(hash1).not.toBe(hash2)
        })
    })

    describe('output format', () => {
        it('should return a 32-byte hex string', () => {
            const quotes = createMockSignedQuotes()
            const hash = hashQuotes(quotes, mockConfig)

            expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/)
            expect(hash.length).toBe(66) // 0x + 64 hex chars
        })
    })

    describe('optional fields', () => {
        it('should handle missing authorization_address', () => {
            const quotes = createMockSignedQuotes({
                quotes: [createMockQuote()],
            })

            const hash = hashQuotes(quotes, mockConfig)

            expect(hash).toBeTruthy()
            expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/)
        })

        it('should handle missing additional_authorization', () => {
            const quotes = createMockSignedQuotes({
                quotes: [createMockQuote()],
            })

            const hash = hashQuotes(quotes, mockConfig)

            expect(hash).toBeTruthy()
            expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/)
        })
    })
})
