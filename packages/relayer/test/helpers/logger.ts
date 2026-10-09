import type { Logger } from '../../src/lib/logger'

/** Logger that records nothing. RelayerService requires child() plus the four levels. */
export function silentLogger(): Logger {
    const logger: Logger = {
        info() {},
        warn() {},
        error() {},
        debug() {},
        child() {

            return logger
        },
    }

    return logger
}
