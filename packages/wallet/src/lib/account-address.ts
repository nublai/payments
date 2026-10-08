import { AccountCreateError, resolveKeystorePath } from './account-create'
import { dirname, join } from 'node:path'
import {
    LoginProfileError,
    SessionOnlyProfileError,
    readKeystoreBundle,
    readSessionKeystoreFile,
} from './keystore'
import { isMissingFileError } from './fs-utils'

type EnvName = 'prod' | 'stage' | 'dev'

type AccountAddressErrorCode = 'INVALID_NAME' | 'KEYSTORE_NOT_FOUND' | 'UNKNOWN'

export class AccountAddressError extends Error {
    code: AccountAddressErrorCode
    cause?: unknown

    constructor(code: AccountAddressErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AccountAddressError'
        this.code = code
        this.cause = options?.cause
    }
}

export type AccountAddressOptions = {
    env: EnvName
    keystorePath?: string
    name?: string
}

export type AccountAddressResult = {
    type: 'account_address'
    status: 'complete'
    keystorePath: string
    address: string
}

export type AccountAddressDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: typeof readSessionKeystoreFile
}

function getDefaultDeps(): AccountAddressDeps {
    return {
        readKeystoreBundle,
        readSessionKeystoreFile,
    }
}

export async function executeAccountAddress(
    options: AccountAddressOptions,
    depsArg?: Partial<AccountAddressDeps>,
): Promise<AccountAddressResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    let keystorePath = options.keystorePath ?? '<default>'

    try {
        keystorePath = resolveKeystorePath({
            env: options.env,
            keystorePath: options.keystorePath,
            name: options.name,
        })

        try {
            const bundle = await deps.readKeystoreBundle(keystorePath)

            return {
                type: 'account_address',
                status: 'complete',
                keystorePath,
                address: bundle.root.addresses.root,
            }
        } catch (error) {
            if (
                !isMissingFileError(error) &&
                !(error instanceof SessionOnlyProfileError) &&
                !(error instanceof LoginProfileError)
            ) {
                throw error
            }

            const sessionProfilePath = join(dirname(keystorePath), 'session.json')

            const session =
                error instanceof SessionOnlyProfileError || error instanceof LoginProfileError
                    ? (error.sessionKeystore ??
                      (await deps.readSessionKeystoreFile(error.sessionPath ?? sessionProfilePath)))
                    : await deps.readSessionKeystoreFile(sessionProfilePath)

            return {
                type: 'account_address',
                status: 'complete',
                keystorePath:
                    (error instanceof SessionOnlyProfileError ||
                        error instanceof LoginProfileError) &&
                    error.sessionPath
                        ? error.sessionPath
                        : sessionProfilePath,
                address: session.addresses.delegated,
            }
        }
    } catch (error: unknown) {
        throw toAccountAddressError(error, { keystorePath })
    }
}

function toAccountAddressError(
    error: unknown,
    context: { keystorePath: string },
): AccountAddressError {
    if (error instanceof AccountAddressError) {
        return error
    }

    if (error instanceof AccountCreateError && error.code === 'INVALID_NAME') {
        return new AccountAddressError('INVALID_NAME', error.message, { cause: error })
    }

    if (isMissingFileError(error)) {
        return new AccountAddressError(
            'KEYSTORE_NOT_FOUND',
            `Keystore not found at ${context.keystorePath}`,
            { cause: error },
        )
    }

    const message = error instanceof Error ? error.message : String(error)

    return new AccountAddressError('UNKNOWN', message, { cause: error })
}
