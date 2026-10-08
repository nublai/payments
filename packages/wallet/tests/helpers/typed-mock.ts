import { mock } from 'bun:test'

/**
 * bun:test `mock(impl)` is a callable with impl's runtime signature.
 * Production deps only invoke the function; tests read `.mock` on the same value.
 */
export function typedMock<F>(impl: Parameters<typeof mock>[0]): F {
    // SAFETY: mock(impl) forwards every call to impl; F is the production dep type injected into execute*.
    return mock(impl) as F
}

function widen<T, S>(value: S): T | S {
    return value
}

/** Present a test double bag as the production deps type. Suites only call methods they install. */
export function stubDeps<T, S>(value: S): T {
    // SAFETY: these tests only call the dep methods they install on this object.
    return widen<T, S>(value) as T
}

/** First argument of the first recorded mock call after the test already asserted a call. */
export function firstMockArg<T>(fn: ReturnType<typeof mock>): T {
    const args = fn.mock.calls[0]

    if (args === undefined) throw new Error('expected a mock call')

    // SAFETY: the suite already asserted this mock ran; args[0] is that invocation's first argument.
    return widen<T, (typeof args)[0]>(args[0]) as T
}
