import { mock } from 'bun:test'

/**
 * bun:test `mock(impl)` is a callable with impl's runtime signature.
 * Production deps only invoke the function; tests read `.mock` on the same value.
 */
export function typedMock<F>(impl: Parameters<typeof mock>[0]): F {
    // SAFETY: mock(impl) forwards every call to impl; F is the production dep type injected into execute*.
    return mock(impl) as F
}
