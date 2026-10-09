import { readFile } from 'node:fs/promises'
import { resolveKeystorePath } from './account-create'
import {
    createSessionKeystore,
    decryptSessionKeystore,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    writeSessionKeystoreFile,
} from './keystore'
import { parseSessionName } from './session-common'
import { type EnvName } from './network-config'

type SessionExportErrorCode =
    | 'PASSWORD_REQUIRED'
    | 'KEYSTORE_NOT_FOUND'
    | 'SESSION_NOT_FOUND'
    | 'SESSION_EXPORT_FAILED'
    | 'UNKNOWN'

export class SessionExportError extends Error {
    code: SessionExportErrorCode
    cause?: unknown

    constructor(code: SessionExportErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'SessionExportError'
        this.code = code
        this.cause = options?.cause
    }
}

export type SessionExportOptions = {
    env: EnvName
    sessionName: string
    output: string
    name?: string
    keystorePath?: string
    password: string
    exportPassword: string
}

export type SessionExportResult = {
    type: 'session_export'
    status: 'complete'
    keystorePath: string
    sessionPath: string
    output: string
    sessionName: string
}

export type SessionExportDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    resolveSessionKeystorePath: typeof resolveSessionKeystorePath
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    decryptSessionKeystore: typeof decryptSessionKeystore
    createSessionKeystore: typeof createSessionKeystore
    writeSessionKeystoreFile: typeof writeSessionKeystoreFile
}

function getDefaultDeps(): SessionExportDeps {
    return {
        readKeystoreBundle,
        resolveSessionKeystorePath,
        readSessionKeystoreFile,
        decryptSessionKeystore,
        createSessionKeystore,
        writeSessionKeystoreFile,
    }
}

export async function executeSessionExport(
    options: SessionExportOptions,
    depsArg?: Partial<SessionExportDeps>,
): Promise<SessionExportResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const sessionName = parseSessionName(options.sessionName)

    const keystorePath = resolveKeystorePath({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
    })

    try {
        const bundle = await deps.readKeystoreBundle(keystorePath)

        const sessionPath = deps.resolveSessionKeystorePath(
            keystorePath,
            sessionName,
            bundle.root.sessionRef.dir,
        )

        const source = await deps.readSessionKeystoreFile(sessionPath)
        const decrypted = await deps.decryptSessionKeystore(source, options.password)
        const delegated = bundle.root.addresses.delegated

        if (!delegated) {
            throw new SessionExportError(
                'SESSION_EXPORT_FAILED',
                'Account has no delegated address. Run account delegation first.',
            )
        }

        const exported = await deps.createSessionKeystore({
            password: options.exportPassword,
            sessionPrivateKey: decrypted.sessionPrivateKey,
            network: source.network ?? bundle.root.network,
            delegated: source.addresses.delegated ?? delegated,
            name: source.name,
            checkpoint: source.checkpoint,
        })

        exported.createdAt = source.createdAt

        await deps.writeSessionKeystoreFile(options.output, exported, { overwrite: true })

        return {
            type: 'session_export',
            status: 'complete',
            keystorePath,
            sessionPath,
            output: options.output,
            sessionName,
        }
    } catch (error) {
        throw toSessionExportError(error, { keystorePath, sessionName })
    }
}

function toSessionExportError(
    error: unknown,
    context: { keystorePath: string; sessionName: string },
): SessionExportError {
    if (error instanceof SessionExportError) return error
    const message = error instanceof Error ? error.message : String(error)

    if (message.includes('ENOENT') || message.toLowerCase().includes('no such file')) {
        return new SessionExportError(
            'KEYSTORE_NOT_FOUND',
            `Session or keystore not found for ${context.sessionName} in ${context.keystorePath}`,
            { cause: error },
        )
    }

    if (
        message.includes('No password provided on stdin') ||
        message.includes('Password required')
    ) {
        return new SessionExportError('PASSWORD_REQUIRED', message, { cause: error })
    }

    return new SessionExportError('UNKNOWN', message, { cause: error })
}

export async function resolveSessionExportPasswords(
    args: { passwordStdin?: boolean; exportPasswordStdin?: boolean },
    deps: {
        envPassword?: string
        envExportPassword?: string
        readPasswordFromStdin: () => string
        promptForExistingPassword: () => Promise<string>
        promptForExportPassword: () => Promise<string>
        isInteractive: boolean
    },
): Promise<{ password: string; exportPassword: string }> {
    let sharedStdinPassword: string | undefined

    if (args.passwordStdin && args.exportPasswordStdin) {
        sharedStdinPassword = deps.readPasswordFromStdin()
    }

    const password =
        deps.envPassword ??
        (args.passwordStdin ? (sharedStdinPassword ?? deps.readPasswordFromStdin()) : undefined) ??
        (deps.isInteractive ? await deps.promptForExistingPassword() : undefined)

    if (!password) {
        throw new SessionExportError(
            'PASSWORD_REQUIRED',
            'Current keystore password required. Use --password-stdin, TW_PASSWORD, or interactive TTY.',
        )
    }

    const exportPassword =
        deps.envExportPassword ??
        (args.exportPasswordStdin
            ? (sharedStdinPassword ?? deps.readPasswordFromStdin())
            : undefined) ??
        (deps.isInteractive ? await deps.promptForExportPassword() : undefined)

    if (!exportPassword) {
        throw new SessionExportError(
            'PASSWORD_REQUIRED',
            'Export password required. Use --export-password-stdin, TW_EXPORT_PASSWORD, or interactive TTY.',
        )
    }

    return { password, exportPassword }
}

export async function assertSessionExportInputs(input: {
    output: string
    overwrite?: boolean
}): Promise<void> {
    if (input.overwrite) return

    try {
        await readFile(input.output, 'utf8')
    } catch {
        return
    }

    throw new SessionExportError(
        'SESSION_EXPORT_FAILED',
        `Output file already exists at ${input.output}. Use --overwrite to replace it.`,
    )
}
