import { mock, type Mock } from 'bun:test'
import { withKeystoreLock } from '../../src/lib/keystore'

/**
 * bun:test `mock(impl)` is a callable with impl's runtime signature.
 * Production deps only invoke the function; tests read `.mock` on the same value.
 * `impl` must be assignable to F. The return keeps F's call signature so generics
 * and overloads are not collapsed by `Mock`'s `Parameters`/`ReturnType`.
 */
export function typedMock<F extends (...args: never[]) => void>(impl: F): F & Mock<F> {
    // SAFETY: bun's mock(impl) is the same callable as impl; the intersection keeps F so Mock does not collapse generics or overloads.
    return mock(impl) as F & Mock<F>
}

/** First argument of the first recorded mock call after the test already asserted a call. */
export function firstMockArg<F extends (...args: never[]) => void>(fn: Mock<F>): Parameters<F>[0] {
    const args = fn.mock.calls[0]

    if (args === undefined) throw new Error('expected a mock call')

    // SAFETY: the suite already asserted this mock ran; args[0] is Parameters<F>[0] of the same F.
    return args[0] as Parameters<F>[0]
}

/** Generic keystore lock that runs `action` and preserves T. */
export async function passthroughKeystoreLock<T>(
    _rootKeystorePath: string,
    action: () => Promise<T>,
    _lock?: Parameters<typeof withKeystoreLock>[2],
    _options?: Parameters<typeof withKeystoreLock>[3],
): Promise<T> {
    return action()
}
