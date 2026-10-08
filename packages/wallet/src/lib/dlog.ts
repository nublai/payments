type DlogLogger = ((...args: unknown[]) => void) | undefined

let customErrorLogger: DlogLogger

let customWarnLogger: DlogLogger

let customInfoLogger: DlogLogger

export const setDlogErrorLogger = (logger: DlogLogger): void => {
    customErrorLogger = logger
}

export const setDlogWarnLogger = (logger: DlogLogger): void => {
    customWarnLogger = logger
}

export const setDlogInfoLogger = (logger: DlogLogger): void => {
    customInfoLogger = logger
}

export function getDlogLoggers(): {
    error: DlogLogger
    warn: DlogLogger
    info: DlogLogger
} {
    return {
        error: customErrorLogger,
        warn: customWarnLogger,
        info: customInfoLogger,
    }
}
