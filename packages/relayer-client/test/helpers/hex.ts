import type { Address, Hex } from 'viem'

export function emptyHex(): Hex[] {
    return []
}

export function hex(value: `0x${string}`): Hex {
    return value
}

export function addr(value: `0x${string}`): Address {
    return value
}

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

export function parseHex(value: string): Hex {
    const normalized = value.startsWith('0x') || value.startsWith('0X') ? value : `0x${value}`

    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(normalized)) {
        throw new Error(`expected even-length hex, got ${JSON.stringify(value)}`)
    }

    // SAFETY: `normalized` matched 0x plus whole hex bytes, which is Hex.
    return normalized as Hex
}

export function parseAddr(value: string): Address {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error(`expected a 20-byte address, got ${JSON.stringify(value)}`)
    }

    // SAFETY: the regex accepts only 0x plus 40 hex digits, which is Address.
    return value as Address
}

export function optionalAddr(value: string | undefined): Address | undefined {
    if (value === undefined || value === '') return undefined

    return parseAddr(value)
}
