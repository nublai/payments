import { AccountCreateError, resolveKeystorePath } from './account-create'
import {
    createRootKeystore,
    createSessionKeystore,
    decryptHexSecret,
    decryptRootKeystore,
    decryptSessionKeystore,
    deriveKeystoreKey,
    isAgentKeystore,
    isLoginKeystore,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    withKeystoreLock,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
    type AnySessionKeystore,
} from './keystore'
import { decryptAgentDevice, finalizeAgentSessionKeystore } from './agent-sessions'
import { listSessionNames } from './session-common'
import type { Hex } from 'viem'

type EnvName = 'prod' | 'stage' | 'dev'

type AccountUpdatePasswordErrorCode =
    | 'PASSWORD_REQUIRED'
    | 'PASSWORD_INCORRECT'
    | 'INVALID_NAME'
    | 'KEYSTORE_NOT_FOUND'
    | 'KEYSTORE_LOCKED'
    | 'UPDATE_FAILED'
    | 'UNKNOWN'

export class AccountUpdatePasswordError extends Error {
    code: AccountUpdatePasswordErrorCode
    cause?: unknown

    constructor(
        code: AccountUpdatePasswordErrorCode,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message)
        this.name = 'AccountUpdatePasswordError'
        this.code = code
        this.cause = options?.cause
    }
}

export type AccountUpdatePasswordArgs = {
    env: EnvName
    keystorePath?: string
    name?: string
    currentPasswordStdin: boolean
    newPasswordStdin: boolean
    json: boolean
    help: boolean
}

export type AccountUpdatePasswordOptions = {
    env: EnvName
    keystorePath?: string
    name?: string
    currentPassword: string
    newPassword: string
}

export type AccountUpdatePasswordResult = {
    type: 'account_update_password'
    status: 'complete'
    keystorePath: string
    activeSession: string
    updatedSessions: string[]
    network: {
        env: string
        relayerUrl: string
        rpcUrl: string
        chainId: number
    }
}

type AccountUpdatePasswordDeps = {
    withKeystoreLock: typeof withKeystoreLock
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    listSessionNames: typeof listSessionNames
    decryptRootKeystore: typeof decryptRootKeystore
    decryptSessionKeystore: typeof decryptSessionKeystore
    createRootKeystore: typeof createRootKeystore
    createSessionKeystore: typeof createSessionKeystore
    deriveKeystoreKey: typeof deriveKeystoreKey
    decryptHexSecret: typeof decryptHexSecret
    decryptAgentDevice: typeof decryptAgentDevice
    finalizeAgentSessionKeystore: typeof finalizeAgentSessionKeystore
    writeRootKeystoreFile: typeof writeRootKeystoreFile
    writeSessionKeystoreFile: typeof writeSessionKeystoreFile
}

function getDefaultDeps(): AccountUpdatePasswordDeps {
    return {
        withKeystoreLock,
        readKeystoreBundle,
        readSessionKeystoreFile,
        listSessionNames,
        decryptRootKeystore,
        decryptSessionKeystore,
        createRootKeystore,
        createSessionKeystore,
        deriveKeystoreKey,
        decryptHexSecret,
        decryptAgentDevice,
        finalizeAgentSessionKeystore,
        writeRootKeystoreFile,
        writeSessionKeystoreFile,
    }
}

export async function resolveAccountUpdatePasswords(
    args: AccountUpdatePasswordArgs,
    deps: {
        envPassword?: string
        readPasswordLinesFromStdin: () => string[]
        promptForExistingPassword: () => Promise<string>
        promptForPassword: () => Promise<string>
        isInteractive: boolean
        validateCurrentPassword?: (currentPassword: string) => Promise<void>
    },
): Promise<{ currentPassword: string; newPassword: string }> {
    const stdinLines =
        args.currentPasswordStdin || args.newPasswordStdin ? deps.readPasswordLinesFromStdin() : []

    let currentPassword = deps.envPassword

    if (!currentPassword && args.currentPasswordStdin) {
        currentPassword = stdinLines[0]
    }

    if (!currentPassword && deps.isInteractive) {
        currentPassword = await deps.promptForExistingPassword()
    }

    currentPassword = currentPassword?.trim()

    if (!currentPassword) {
        throw new AccountUpdatePasswordError(
            'PASSWORD_REQUIRED',
            'Current and new passwords are required. Use stdin flags, TW_PASSWORD for current password, or run in interactive TTY.',
        )
    }

    if (deps.validateCurrentPassword) {
        try {
            await deps.validateCurrentPassword(currentPassword)
        } catch (error) {
            if (error instanceof AccountUpdatePasswordError) {
                throw error
            }

            throw new AccountUpdatePasswordError(
                'PASSWORD_INCORRECT',
                'Current password is incorrect.',
                { cause: error },
            )
        }
    }

    let newPassword: string | undefined

    if (args.newPasswordStdin) {
        newPassword = args.currentPasswordStdin ? stdinLines[1] : stdinLines[0]
    }

    if (!newPassword && deps.isInteractive) {
        newPassword = await deps.promptForPassword()
    }

    newPassword = newPassword?.trim()

    if (!newPassword) {
        throw new AccountUpdatePasswordError(
            'PASSWORD_REQUIRED',
            'Current and new passwords are required. Use stdin flags, TW_PASSWORD for current password, or run in interactive TTY.',
        )
    }

    return { currentPassword, newPassword }
}

export async function assertAccountUpdateCurrentPassword(
    options: {
        env: EnvName
        keystorePath?: string
        name?: string
        currentPassword: string
    },
    depsArg?: Partial<
        Pick<AccountUpdatePasswordDeps, 'readKeystoreBundle' | 'decryptRootKeystore'>
    >,
): Promise<void> {
    const deps = { ...getDefaultDeps(), ...depsArg }

    const keystorePath = resolveKeystorePath({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
    })

    try {
        const bundle = await deps.readKeystoreBundle(keystorePath)
        await deps.decryptRootKeystore(bundle.root, options.currentPassword)
    } catch (error) {
        throw toAccountUpdatePasswordError(error, { keystorePath })
    }
}

export async function executeAccountUpdatePassword(
    options: AccountUpdatePasswordOptions,
    depsArg?: Partial<AccountUpdatePasswordDeps>,
): Promise<AccountUpdatePasswordResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }

    const keystorePath = resolveKeystorePath({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
    })

    try {
        return await deps.withKeystoreLock(keystorePath, async () => {
            const bundle = await deps.readKeystoreBundle(keystorePath)
            const sessionsDir = bundle.root.sessionRef.dir
            const sessionNames = await deps.listSessionNames(keystorePath, sessionsDir)
            const sessionKeystores = new Map<string, AnySessionKeystore>()

            for (const sessionName of sessionNames) {
                const sessionPath = resolveSessionKeystorePath(
                    keystorePath,
                    sessionName,
                    sessionsDir,
                )

                const sessionKeystore = await deps.readSessionKeystoreFile(sessionPath)
                sessionKeystores.set(sessionName, sessionKeystore)
            }

            const decryptedRoot = await deps.decryptRootKeystore(
                bundle.root,
                options.currentPassword,
            )

            const decryptedSessions = new Map<string, string>()

            for (const [name, keystore] of sessionKeystores.entries()) {
                const decrypted = await deps.decryptSessionKeystore(
                    keystore,
                    options.currentPassword,
                )

                decryptedSessions.set(name, decrypted.sessionPrivateKey)
            }

            const rewrittenRoot = await deps.createRootKeystore({
                password: options.newPassword,
                rootPrivateKey: decryptedRoot.rootPrivateKey,
                env: bundle.root.network.env,
                relayerUrl: bundle.root.network.relayerUrl,
                rpcUrl: bundle.root.network.rpcUrl,
                chainId: bundle.root.network.chainId,
                activeSession: bundle.root.sessionRef.active,
                sessionsDir: bundle.root.sessionRef.dir,
            })

            rewrittenRoot.createdAt = bundle.root.createdAt
            rewrittenRoot.checkpoint = bundle.root.checkpoint
            rewrittenRoot.addresses = { ...bundle.root.addresses }

            const rewrittenSessions = new Map<string, AnySessionKeystore>()

            for (const [name, existing] of sessionKeystores.entries()) {
                const sessionPrivateKey = decryptedSessions.get(name)! as Hex

                const baseInput = {
                    password: options.newPassword,
                    sessionPrivateKey,
                    network: existing.network,
                    delegated: existing.addresses.delegated,
                    name: existing.name,
                    checkpoint: existing.checkpoint,
                } as const

                let rewritten: AnySessionKeystore

                if (isLoginKeystore(existing)) {
                    let bearerToken: Hex | undefined

                    if (existing.secrets.bearerToken) {
                        const oldKey = await deps.deriveKeystoreKey(
                            options.currentPassword,
                            existing.kdf.params,
                        )

                        try {
                            bearerToken = deps.decryptHexSecret(
                                existing.secrets.bearerToken,
                                oldKey,
                            )
                        } finally {
                            oldKey.fill(0)
                        }
                    }

                    rewritten = await deps.createSessionKeystore({
                        ...baseInput,
                        kind: 'login',
                        delegateAuth: existing.delegateAuth,
                        bearerToken,
                    })
                } else if (isAgentKeystore(existing)) {
                    const exportedDevice = await deps.decryptAgentDevice(
                        existing,
                        options.currentPassword,
                    )

                    const baseSession = await deps.createSessionKeystore(baseInput)
                    rewritten = await deps.finalizeAgentSessionKeystore({
                        baseKeystore: baseSession,
                        password: options.newPassword,
                        exportedDevice,
                        namedChannels: existing.namedChannels,
                    })
                } else {
                    rewritten = await deps.createSessionKeystore(baseInput)
                }

                rewritten.createdAt = existing.createdAt
                rewritten.addresses = { ...existing.addresses }
                rewrittenSessions.set(name, rewritten)
            }

            try {
                for (const [name, sessionKeystore] of rewrittenSessions.entries()) {
                    const sessionPath = resolveSessionKeystorePath(keystorePath, name, sessionsDir)
                    await deps.writeSessionKeystoreFile(sessionPath, sessionKeystore, {
                        overwrite: true,
                    })
                }

                await deps.writeRootKeystoreFile(keystorePath, rewrittenRoot, { overwrite: true })
            } catch (writeError) {
                let rollbackError: unknown

                try {
                    for (const [name, original] of sessionKeystores.entries()) {
                        const sessionPath = resolveSessionKeystorePath(
                            keystorePath,
                            name,
                            sessionsDir,
                        )

                        await deps.writeSessionKeystoreFile(sessionPath, original, {
                            overwrite: true,
                        })
                    }

                    await deps.writeRootKeystoreFile(keystorePath, bundle.root, { overwrite: true })
                } catch (error) {
                    rollbackError = error
                }

                const rollbackMessage =
                    rollbackError instanceof Error
                        ? ` Rollback failed: ${rollbackError.message}`
                        : ''

                throw new AccountUpdatePasswordError(
                    'UPDATE_FAILED',
                    `Failed to update password: ${writeError instanceof Error ? writeError.message : String(writeError)}.${rollbackMessage}`,
                    {
                        cause:
                            rollbackError === undefined
                                ? writeError
                                : new AggregateError(
                                      [writeError, rollbackError],
                                      'Password update and rollback both failed.',
                                  ),
                    },
                )
            }

            return {
                type: 'account_update_password',
                status: 'complete',
                keystorePath,
                activeSession: bundle.root.sessionRef.active,
                updatedSessions: [...rewrittenSessions.keys()].sort(),
                network: bundle.root.network,
            }
        })
    } catch (error) {
        throw toAccountUpdatePasswordError(error, { keystorePath })
    }
}

function toAccountUpdatePasswordError(
    error: unknown,
    context: { keystorePath: string },
): AccountUpdatePasswordError {
    if (error instanceof AccountUpdatePasswordError) return error

    if (error instanceof AccountCreateError && error.code === 'INVALID_NAME') {
        return new AccountUpdatePasswordError('INVALID_NAME', error.message, { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)

    if (message.includes('Keystore is locked')) {
        return new AccountUpdatePasswordError('KEYSTORE_LOCKED', message, { cause: error })
    }

    if (message.includes('ENOENT') || message.toLowerCase().includes('no such file')) {
        return new AccountUpdatePasswordError(
            'KEYSTORE_NOT_FOUND',
            `Keystore not found at ${context.keystorePath}`,
            { cause: error },
        )
    }

    if (
        message.includes('No password provided on stdin') ||
        message.includes('Current and new passwords are required') ||
        message.includes('Password required') ||
        message.includes('Password cannot be empty') ||
        message.includes('Password input cancelled')
    ) {
        return new AccountUpdatePasswordError('PASSWORD_REQUIRED', message, { cause: error })
    }

    if (
        message.includes('unable to authenticate data') ||
        message.includes('bad decrypt') ||
        message.includes('Unsupported state')
    ) {
        return new AccountUpdatePasswordError(
            'PASSWORD_INCORRECT',
            'Current password is incorrect.',
            { cause: error },
        )
    }

    if (message.includes('Failed to update password')) {
        return new AccountUpdatePasswordError('UPDATE_FAILED', message, { cause: error })
    }

    return new AccountUpdatePasswordError('UNKNOWN', message, { cause: error })
}
