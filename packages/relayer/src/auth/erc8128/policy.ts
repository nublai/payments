import type { Env } from '../../types/env'
import { parseAuthProtectedMethods } from '../policy'

const DEFAULT_MAX_VALIDITY_SECONDS = 120

const DEFAULT_CLOCK_SKEW_SECONDS = 30

export interface Erc8128Policy {
    enabled: boolean
    protectedMethods: Set<string>
    maxValiditySeconds: number
    clockSkewSeconds: number
    requireRequestBound: boolean
    requireNonReplayable: boolean
}

function parseIntWithDefault(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10)

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function getErc8128Policy(env: Partial<Env>): Erc8128Policy {
    return {
        enabled: env.ERC8128_ENABLED === 'true',
        protectedMethods: parseAuthProtectedMethods(env.AUTH_PROTECTED_METHODS),
        maxValiditySeconds: parseIntWithDefault(
            env.ERC8128_MAX_VALIDITY_SECONDS,
            DEFAULT_MAX_VALIDITY_SECONDS,
        ),
        clockSkewSeconds: parseIntWithDefault(
            env.ERC8128_CLOCK_SKEW_SECONDS,
            DEFAULT_CLOCK_SKEW_SECONDS,
        ),
        requireRequestBound: true,
        requireNonReplayable: true,
    }
}
