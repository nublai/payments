export function isMissingFileError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)

    return message.includes('ENOENT') || message.toLowerCase().includes('no such file')
}
