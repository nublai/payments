/**
 * Structured logging for Cloudflare Workers
 *
 * Uses pino-style logging that works in both Cloudflare Workers and Node.js
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogContext {
    [key: string]: unknown
}

interface Logger {
    debug(msg: string): void
    debug(context: LogContext, msg: string): void
    info(msg: string): void
    info(context: LogContext, msg: string): void
    warn(msg: string): void
    warn(context: LogContext, msg: string): void
    error(msg: string): void
    error(context: LogContext, msg: string): void
    child(context: LogContext): Logger
}

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
}

function createLogger(name: string, baseContext: LogContext = {}): Logger {
    const minLevel = LOG_LEVELS.info // Can be configured via env

    const log = (level: LogLevel, contextOrMsg: LogContext | string, msg?: string) => {
        if (LOG_LEVELS[level] < minLevel) return

        const timestamp = new Date().toISOString()
        let context: LogContext
        let message: string

        if (typeof contextOrMsg === 'string') {
            context = {}
            message = contextOrMsg
        } else {
            context = contextOrMsg
            message = msg!
        }

        const logEntry = {
            level,
            time: timestamp,
            name,
            msg: message,
            ...baseContext,
            ...context,
        }

        // Use console methods that map to Cloudflare's logging
        const output = JSON.stringify(logEntry)

        switch (level) {
            case 'debug':
                console.debug(output)
                break
            case 'info':
                console.info(output)
                break
            case 'warn':
                console.warn(output)
                break
            case 'error':
                console.error(output)
                break
        }
    }

    return {
        debug: (contextOrMsg: LogContext | string, msg?: string) => log('debug', contextOrMsg, msg),
        info: (contextOrMsg: LogContext | string, msg?: string) => log('info', contextOrMsg, msg),
        warn: (contextOrMsg: LogContext | string, msg?: string) => log('warn', contextOrMsg, msg),
        error: (contextOrMsg: LogContext | string, msg?: string) => log('error', contextOrMsg, msg),
        child: (childContext: LogContext) =>
            createLogger(name, { ...baseContext, ...childContext }),
    }
}

/**
 * Extract error message from unknown error type
 */
export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Extract error details for logging
 */
export function errorDetails(error: unknown): LogContext {
    if (error instanceof Error) {
        return {
            errorName: error.name,
            errorMessage: error.message,
            errorStack: error.stack,
        }
    }

    return { error: String(error) }
}

/**
 * Main logger instance
 */
export const logger = createLogger('eip7702-relayer')

export type { Logger, LogContext }
