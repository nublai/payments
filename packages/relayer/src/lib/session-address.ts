import { decodeAbiParameters, isAddress, type Address, type Hex } from 'viem'
import { z } from 'zod'

/**
 * `session_key` on prepareCalls is `encodeAbiParameters([{ type: 'address' }], [sessionAddress])`.
 * Returns undefined when the value is missing or not that encoding.
 */
export function sessionAddressFromEncodedKey(sessionKey: string | undefined): Address | undefined {
    if (!sessionKey || sessionKey === '0x') return undefined

    try {
        const [decoded] = decodeAbiParameters([{ type: 'address' }], sessionKey as Hex)
        const decodedAddress = z.string().safeParse(decoded)

        if (!decodedAddress.success || !isAddress(decodedAddress.data)) {
            return undefined
        }

        return decodedAddress.data
    } catch {
        return undefined
    }
}
