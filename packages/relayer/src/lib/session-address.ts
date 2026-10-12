import { decodeAbiParameters, isAddress, type Address, type Hex } from 'viem'

/**
 * `session_key` on prepareCalls is `encodeAbiParameters([{ type: 'address' }], [sessionAddress])`.
 * Returns undefined when the value is missing or not that encoding.
 */
export function sessionAddressFromEncodedKey(sessionKey: string | undefined): Address | undefined {
    if (!sessionKey || sessionKey === '0x') return undefined

    try {
        // SAFETY: sessionKey is an unchecked string; decodeAbiParameters throws on non-hex, and the catch below returns undefined.
        const [decoded] = decodeAbiParameters([{ type: 'address' }], sessionKey as Hex)

        if (typeof decoded === 'string' && isAddress(decoded)) {
            return decoded
        }
    } catch {
        return undefined
    }

    return undefined
}
