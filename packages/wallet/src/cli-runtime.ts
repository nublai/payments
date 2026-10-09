import { setDlogErrorLogger, setDlogInfoLogger, setDlogWarnLogger } from './lib/dlog'

export async function withSdkLogsSuppressedIfSilent<T>(action: () => Promise<T>): Promise<T> {
    if (process.env.DEBUG?.trim()) {
        return action()
    }

    const noop = () => undefined
    setDlogInfoLogger(noop)
    setDlogWarnLogger(noop)
    setDlogErrorLogger(noop)

    try {
        return await action()
    } finally {
        setDlogInfoLogger(undefined)
        setDlogWarnLogger(undefined)
        setDlogErrorLogger(undefined)
    }
}

export function updateCliProcessExitCode(nextCode: number): void {
    const currentCode = process.exitCode

    if (typeof currentCode === 'number' && currentCode !== 0 && nextCode === 0) {
        return
    }

    process.exitCode = nextCode
}

export function resolveCliProcessExitCode(fallbackCode: number): number {
    const code = process.exitCode

    return typeof code === 'number' ? code : fallbackCode
}

declare global {
    namespace NodeJS {
        interface Process {
            _getActiveHandles?: () => object[]
            _getActiveRequests?: () => object[]
        }
    }
}

function summarizeActiveResource(resource: unknown): Record<string, unknown> {
    const summary: Record<string, unknown> = {}

    if (typeof resource !== 'object' || resource === null) {
        return { value: String(resource) }
    }

    const ctor =
        'constructor' in resource &&
        typeof resource.constructor === 'function' &&
        'name' in resource.constructor
            ? String(resource.constructor.name)
            : 'Unknown'

    summary.type = ctor

    if ('hasRef' in resource && typeof resource.hasRef === 'function') {
        try {
            summary.hasRef = resource.hasRef()
        } catch {
            summary.hasRef = 'error'
        }
    }

    if ('fd' in resource && typeof resource.fd !== 'function') {
        summary.fd = resource.fd
    }

    if ('localAddress' in resource && typeof resource.localAddress !== 'function') {
        summary.localAddress = resource.localAddress
    }

    if ('localPort' in resource && typeof resource.localPort !== 'function') {
        summary.localPort = resource.localPort
    }

    if ('remoteAddress' in resource && typeof resource.remoteAddress !== 'function') {
        summary.remoteAddress = resource.remoteAddress
    }

    if ('remotePort' in resource && typeof resource.remotePort !== 'function') {
        summary.remotePort = resource.remotePort
    }

    if ('bytesRead' in resource && typeof resource.bytesRead !== 'function') {
        summary.bytesRead = resource.bytesRead
    }

    if ('bytesWritten' in resource && typeof resource.bytesWritten !== 'function') {
        summary.bytesWritten = resource.bytesWritten
    }

    return summary
}

export function scheduleActiveHandleDumpIfRequested(label: string): void {
    if (process.env.TW_DEBUG_HANDLES !== '1') {
        return
    }

    const timer = setTimeout(() => {
        const handles = process._getActiveHandles?.() ?? []
        const requests = process._getActiveRequests?.() ?? []
        console.error(`[tw debug] active handles after ${label}:`, handles.length)
        handles.forEach((handle, index) => {
            console.error(`[tw debug] handle[${index}]`, summarizeActiveResource(handle))
        })
        console.error(`[tw debug] active requests after ${label}:`, requests.length)
        requests.forEach((request, index) => {
            console.error(`[tw debug] request[${index}]`, summarizeActiveResource(request))
        })
    }, 1000)

    timer.unref()
}
