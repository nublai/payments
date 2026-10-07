import { decodeAbiParameters, isAddress, type Address, type Hex } from 'viem'

/**
 * `session_key` on prepareCalls is `encodeAbiParameters([{ type: 'address' }], [sessionAddress])`.
 * Returns undefined when the value is missing or not that encoding.
 */
export function sessionAddressFromEncodedKey(sessionKey: string | undefined): Address | undefined {
    if (!sessionKey || sessionKey === '0x') return undefined
    try {
        const [decoded] = decodeAbiParameters([{ type: 'address' }], sessionKey as Hex)
        if (typeof decoded === 'string' && isAddress(decoded)) {
            return decoded
        }
    } catch {
        return undefined
    }
    return undefined
}
