/**
 * Quote Signing Utilities
 *
 * HMAC-SHA256 based signing for quote integrity verification.
 * Prevents tampering with quote data between prepareCalls and sendPreparedCalls.
 */

import type { Hex } from 'viem'
import { bytesToHex, keccak256, toBytes, concat } from 'viem'
import type { SignedQuotes } from '../rpc/schema/prepareCalls'

/**
 * Create HMAC-SHA256 signature for quote data
 *
 * Uses Web Crypto API available in Cloudflare Workers.
 * Signs the keccak256 hash of the quotes array concatenated with TTL.
 *
 * @param quotes - The SignedQuotes object (without signature)
 * @param secret - The signing secret
 * @returns Hex-encoded HMAC signature
 */
export async function signQuotes(quotes: SignedQuotes, secret: string): Promise<Hex> {
    const dataToSign = buildSigningData(quotes)

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    )

    const signature = await crypto.subtle.sign('HMAC', key, dataToSign)

    return bytesToHex(new Uint8Array(signature))
}

/**
 * Verify HMAC-SHA256 signature for quote data
 *
 * @param quotes - The SignedQuotes object with signature to verify
 * @param secret - The signing secret
 * @returns True if signature is valid
 */
export async function verifyQuoteSignature(quotes: SignedQuotes, secret: string): Promise<boolean> {
    if (!quotes.signature || quotes.signature === '0x') {
        return false
    }

    const dataToSign = buildSigningData(quotes)

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
    )

    const signatureBytes = toBytes(quotes.signature as Hex)

    return crypto.subtle.verify('HMAC', key, signatureBytes, dataToSign)
}

/**
 * Build the data to sign from quotes
 *
 * Creates deterministic bytes from:
 * - keccak256 of JSON-stringified quotes array
 * - TTL as 32-byte big-endian
 */
function buildSigningData(quotes: SignedQuotes): Uint8Array {
    const quotesHash = keccak256(toBytes(JSON.stringify(quotes.quotes)))
    const ttlBytes = toBytes(quotes.ttl, { size: 32 })

    return concat([toBytes(quotesHash), ttlBytes])
}
