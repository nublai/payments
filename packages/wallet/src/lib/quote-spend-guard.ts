import { AsyncLocalStorage } from 'node:async_hooks'

const suspended = new AsyncLocalStorage<boolean>()

/** Skip crash recovery while this process is itself installing a quote limit. */
export function withoutQuoteSpendRecovery<T>(action: () => Promise<T>): Promise<T> {
    return suspended.run(true, action)
}

export function quoteSpendRecoverySuspended(): boolean {
    return suspended.getStore() === true
}
