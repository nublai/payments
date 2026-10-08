import { type Hex } from 'viem'
import { AccountCreateError, resolveKeystorePath } from './account-create'
import {
    decryptRootKeystore,
    decryptSessionKeystore,
    readKeystoreBundle,
    type RelayerRootKeystoreV2,
} from './keystore'

type EnvName = 'prod' | 'stage' | 'dev'

type AccountExportErrorCode =
    | 'PASSWORD_REQUIRED'
    | 'INVALID_NAME'
    | 'KEYSTORE_NOT_FOUND'
    | 'PRIVATE_EXPORT_CONFIRMATION_REQUIRED'
    | 'PRIVATE_EXPORT_CONFIRMATION_FAILED'
    | 'UNKNOWN'

export class AccountExportError extends Error {
    code: AccountExportErrorCode
    cause?: unknown

    constructor(code: AccountExportErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AccountExportError'
        this.code = code
        this.cause = options?.cause
    }
}

export const PRIVATE_EXPORT_CONFIRMATION_PHRASE = 'EXPORT PRIVATE KEYS'

export type AccountExportArgs = {
    env: EnvName
    keystorePath?: string
    name?: string
    json: boolean
    passwordStdin: boolean
    showPrivate: boolean
    help: boolean
}

export type AccountExportOptions = {
    env: EnvName
    keystorePath?: string
    name?: string
    showPrivate: boolean
    password?: string
}

export type AccountExportResult = {
    type: 'account_export'
    status: 'complete'
    keystorePath: string
    network: RelayerRootKeystoreV2['network']
    addresses: {
        root: string
        session: string
        delegated?: string
    }
    checkpoint: RelayerRootKeystoreV2['checkpoint']
    createdAt: string
    secrets?: {
        rootPrivateKey: Hex
        sessionPrivateKey: Hex
    }
}

export type AccountExportDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    decryptRootKeystore: typeof decryptRootKeystore
    decryptSessionKeystore: typeof decryptSessionKeystore
}

function getDefaultDeps(): AccountExportDeps {
    return {
        readKeystoreBundle,
        decryptRootKeystore,
        decryptSessionKeystore,
    }
}

export async function assertCanExportPrivateKeys(input: {
    showPrivate: boolean
    isInteractive: boolean
    mcp?: boolean
    promptForTypedConfirmation: (expected: string) => Promise<boolean>
}): Promise<void> {
    if (!input.showPrivate) {
        return
    }

    // A password source is not confirmation. MCP stdio and any non-TTY caller
    // cannot type the phrase, including when TW_PASSWORD or --password-stdin is set.
    if (input.mcp || !input.isInteractive) {
        throw new AccountExportError(
            'PRIVATE_EXPORT_CONFIRMATION_REQUIRED',
            `PRIVATE_EXPORT_CONFIRMATION_REQUIRED: Private key export requires an interactive terminal. Type "${PRIVATE_EXPORT_CONFIRMATION_PHRASE}" when prompted. TW_PASSWORD and --password-stdin do not skip this confirmation, and MCP callers cannot confirm it.`,
        )
    }

    const confirmed = await input.promptForTypedConfirmation(PRIVATE_EXPORT_CONFIRMATION_PHRASE)

    if (!confirmed) {
        throw new AccountExportError(
            'PRIVATE_EXPORT_CONFIRMATION_FAILED',
            'Private key export confirmation did not match.',
        )
    }
}

export async function resolveAccountExportPassword(
    args: AccountExportArgs,
    deps: {
        envPassword?: string
        readPasswordFromStdin: () => string
        promptForExistingPassword: () => Promise<string>
        isInteractive: boolean
    },
): Promise<string | undefined> {
    if (!args.showPrivate) {
        return undefined
    }

    if (deps.envPassword) {
        return deps.envPassword
    }

    if (args.passwordStdin) {
        return deps.readPasswordFromStdin()
    }

    if (deps.isInteractive) {
        return deps.promptForExistingPassword()
    }

    throw new AccountExportError(
        'PASSWORD_REQUIRED',
        'Password required to export private keys. Use --password-stdin, TW_PASSWORD, RELAYER_CLI_PASSWORD, or run in interactive TTY.',
    )
}

export async function executeAccountExport(
    options: AccountExportOptions,
    depsArg?: Partial<AccountExportDeps>,
): Promise<AccountExportResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    let keystorePath = options.keystorePath ?? '<default>'

    try {
        keystorePath = resolveKeystorePath({
            env: options.env,
            keystorePath: options.keystorePath,
            name: options.name,
        })
        const bundle = await deps.readKeystoreBundle(keystorePath)

        const result: AccountExportResult = {
            type: 'account_export',
            status: 'complete',
            keystorePath,
            network: bundle.root.network,
            addresses: {
                root: bundle.root.addresses.root,
                session: bundle.session.addresses.session,
                delegated: bundle.root.addresses.delegated,
            },
            checkpoint: bundle.root.checkpoint,
            createdAt: bundle.root.createdAt,
        }

        if (!options.showPrivate) {
            return result
        }

        if (!options.password) {
            throw new AccountExportError(
                'PASSWORD_REQUIRED',
                'Password required to export private keys.',
            )
        }

        const root = await deps.decryptRootKeystore(bundle.root, options.password)
        const session = await deps.decryptSessionKeystore(bundle.session, options.password)
        result.secrets = {
            rootPrivateKey: root.rootPrivateKey,
            sessionPrivateKey: session.sessionPrivateKey,
        }

        return result
    } catch (error) {
        throw toAccountExportError(error, { keystorePath })
    }
}

function toAccountExportError(
    error: unknown,
    context: { keystorePath: string },
): AccountExportError {
    if (error instanceof AccountExportError) {
        return error
    }

    if (error instanceof AccountCreateError && error.code === 'INVALID_NAME') {
        return new AccountExportError('INVALID_NAME', error.message, { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)

    if (message.includes('ENOENT') || message.toLowerCase().includes('no such file')) {
        return new AccountExportError(
            'KEYSTORE_NOT_FOUND',
            `Keystore not found at ${context.keystorePath}`,
            { cause: error },
        )
    }

    if (
        message.includes('No password provided on stdin') ||
        message.includes('Password required') ||
        message.includes('Password cannot be empty') ||
        message.includes('Password confirmation does not match') ||
        message.includes('Password input cancelled')
    ) {
        return new AccountExportError('PASSWORD_REQUIRED', message, { cause: error })
    }

    if (
        message.includes('Confirmation input cancelled') ||
        message.includes('confirmation did not match')
    ) {
        return new AccountExportError('PRIVATE_EXPORT_CONFIRMATION_FAILED', message, {
            cause: error,
        })
    }

    return new AccountExportError('UNKNOWN', message, { cause: error })
}
