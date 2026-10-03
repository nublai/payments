import { access, constants } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getDefaultKeystorePath } from './account-create'
import { readSessionKeystoreFile, writeSessionKeystoreFile } from './keystore'
import type { EnvName } from './network-config'

type SessionImportErrorCode =
    | 'SESSION_IMPORT_FAILED'
    | 'SESSION_CONFLICT'
    | 'PASSWORD_REQUIRED'
    | 'KEYSTORE_NOT_FOUND'
    | 'UNKNOWN'

export class SessionImportError extends Error {
    code: SessionImportErrorCode
    cause?: unknown

    constructor(code: SessionImportErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'SessionImportError'
        this.code = code
        this.cause = options?.cause
    }
}

export type SessionImportOptions = {
    input: string
    profile: string
    env?: EnvName
    overwrite?: boolean
}

export type SessionImportResult = {
    type: 'session_import'
    status: 'complete'
    input: string
    profile: string
    sessionPath: string
}

type SessionImportDeps = {
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    writeSessionKeystoreFile: typeof writeSessionKeystoreFile
    access: (path: string, mode?: number) => Promise<void>
    mkdir: (path: string, options?: { recursive?: boolean }) => Promise<string | undefined>
}

function getDefaultDeps(): SessionImportDeps {
    return {
        readSessionKeystoreFile,
        writeSessionKeystoreFile,
        access: async (path, mode = constants.F_OK) =>
            new Promise((resolve, reject) => {
                access(path, mode, (error) => {
                    if (error) reject(error)
                    else resolve()
                })
            }),
        mkdir: async (path, options) => mkdir(path, options),
    }
}

function resolveProfileDir(profile: string, env: EnvName): string {
    try {
        return dirname(getDefaultKeystorePath(env, profile))
    } catch (error) {
        if (error instanceof Error) {
            throw new SessionImportError('SESSION_IMPORT_FAILED', error.message, { cause: error })
        }
        throw new SessionImportError(
            'SESSION_IMPORT_FAILED',
            'Failed to resolve profile directory',
            {
                cause: error,
            },
        )
    }
}

export async function executeSessionImport(
    options: SessionImportOptions,
    depsArg?: Partial<SessionImportDeps>,
): Promise<SessionImportResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const profileDir = resolveProfileDir(options.profile, options.env ?? 'prod')
    const rootKeystorePath = join(profileDir, 'default.keystore.json')
    const targetPath = join(profileDir, 'session.json')

    try {
        const session = await deps.readSessionKeystoreFile(options.input)
        await deps.mkdir(profileDir, { recursive: true })

        try {
            await deps.access(rootKeystorePath, constants.F_OK)
            throw new SessionImportError(
                'SESSION_CONFLICT',
                `Profile ${options.profile} already has a root keystore at ${rootKeystorePath}.`,
            )
        } catch (error) {
            if (error instanceof SessionImportError) throw error
        }

        if (!options.overwrite) {
            try {
                await deps.access(targetPath, constants.F_OK)
                throw new SessionImportError(
                    'SESSION_CONFLICT',
                    `Session profile already exists at ${targetPath}. Use --overwrite to replace it.`,
                )
            } catch (error) {
                if (error instanceof SessionImportError) throw error
            }
        }

        await deps.writeSessionKeystoreFile(targetPath, session, { overwrite: true })
        return {
            type: 'session_import',
            status: 'complete',
            input: options.input,
            profile: options.profile,
            sessionPath: targetPath,
        }
    } catch (error) {
        throw toSessionImportError(error, { input: options.input })
    }
}

function toSessionImportError(error: unknown, context: { input: string }): SessionImportError {
    if (error instanceof SessionImportError) return error
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('ENOENT') || message.toLowerCase().includes('no such file')) {
        return new SessionImportError(
            'KEYSTORE_NOT_FOUND',
            `Session file not found at ${context.input}`,
            { cause: error },
        )
    }
    return new SessionImportError('UNKNOWN', message, { cause: error })
}
