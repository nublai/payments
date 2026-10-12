import { decodeAbiParameters, isAddress, isHex, type Address } from 'viem'

/**
 * `session_key` on prepareCalls is `encodeAbiParameters([{ type: 'address' }], [sessionAddress])`.
 * Returns undefined when the value is missing or not that encoding.
 */
export function sessionAddressFromEncodedKey(sessionKey: string | undefined): Address | undefined {
    if (!sessionKey || sessionKey === '0x') return undefined

    try {
        if (!isHex(sessionKey)) return undefined

        const [decoded] = decodeAbiParameters([{ type: 'address' }], sessionKey)

        if (typeof decoded === 'string' && isAddress(decoded)) {
            return decoded
        }
    } catch {
        return undefined
    }

    return undefined
}
