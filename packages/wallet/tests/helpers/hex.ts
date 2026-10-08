import type { Address, Hex } from 'viem'

/** Fresh empty hex list for typed-data fields that expect `Hex[]`. */
export function emptyHex(): Hex[] {
    return []
}

/** A 0x-prefixed even-length hex string already in `Hex` form. */
export function hex(value: `0x${string}`): Hex {
    return value
}

/** A 20-byte 0x address literal already in `Address` form. */
export function addr(value: `0x${string}`): Address {
    return value
}

/** Build `0x` plus `count` copies of a single hex byte. */
export function repeatedHex(byte: string, count: number): Hex {
    if (!/^[0-9a-fA-F]{2}$/.test(byte)) {
        throw new Error(`expected one hex byte, got ${JSON.stringify(byte)}`)
    }

    if (!Number.isInteger(count) || count < 0) {
        throw new Error(`expected a non-negative byte count, got ${count}`)
    }

    const value = `0x${byte.repeat(count)}`

    // SAFETY: `value` is 0x plus `count` copies of a verified hex byte, which is Hex.
    return value as Hex
}

/** Parse an even-length hex string (with or without 0x) into Hex. */
export function parseHex(value: string): Hex {
    const normalized = value.startsWith('0x') || value.startsWith('0X') ? value : `0x${value}`

    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(normalized)) {
        throw new Error(`expected even-length hex, got ${JSON.stringify(value)}`)
    }

    // SAFETY: `normalized` matched 0x plus whole hex bytes, which is Hex.
    return normalized as Hex
}

/** Parse a 20-byte 0x address string into Address. */
export function parseAddr(value: string): Address {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error(`expected a 20-byte address, got ${JSON.stringify(value)}`)
    }

    // SAFETY: the regex accepts only 0x plus 40 hex digits, which is Address.
    return value as Address
}

/** Parse an optional env/config address; empty and undefined stay undefined. */
export function optionalAddr(value: string | undefined): Address | undefined {
    if (value === undefined || value === '') return undefined

    return parseAddr(value)
}
