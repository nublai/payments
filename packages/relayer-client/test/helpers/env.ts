import type { Address } from 'viem'

import { parseAddr } from './hex'

export function requiredEnv(name: string): string {
    const value = process.env[name]

    if (value === undefined || value === '') {
        throw new Error(`missing required env ${name}`)
    }

    return value
}

export function requiredAddr(name: string): Address {
    return parseAddr(requiredEnv(name))
}
