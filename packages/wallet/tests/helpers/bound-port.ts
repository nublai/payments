import type { AddressInfo } from 'node:net'

/** Port of a server that called `listen(0)` without a path. */
export function boundPort(server: { address(): AddressInfo | string | null }): number {
    const address = server.address()

    if (address === null || !('port' in address)) {
        throw new Error('expected a bound TCP address')
    }

    return address.port
}
