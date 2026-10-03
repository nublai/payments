import { getAddress, type Address, type Hex } from 'viem'
import { encodeSecp256k1Key, type AuthorizeKey, type Permission } from '@agentic-payments/relayer-client'
import {
    AccountCreateError,
    getDefaultSessionPermissions,
    resolveKeystorePath,
} from './account-create'
import {
    decryptRootKeystore,
    decryptSessionKeystore,
    readKeystoreBundle,
    writeRootKeystoreFile,
} from './keystore'
import {
    resolveNetworkConfig,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
} from './network-config'
import {
    delegateAccountWithAuthorizeKeys,
    hasDelegationCode,
    readAccountCode,
} from './delegation-utils'

type AccountDelegateErrorCode =
    | 'MISSING_ARGUMENT'
    | 'PASSWORD_REQUIRED'
    | 'INVALID_NAME'
    | 'KEYSTORE_NOT_FOUND'
    | 'UNSUPPORTED_CHAIN'
    | 'RELAYER_CAPABILITIES_MISSING'
    | 'DELEGATION_FAILED'
    | 'PARTIAL_FAILURE'
    | 'UNKNOWN'

export class AccountDelegateError extends Error {
    code: AccountDelegateErrorCode
    cause?: unknown
    details?: unknown

    constructor(
        code: AccountDelegateErrorCode,
        message: string,
        options?: { cause?: unknown; details?: unknown },
    ) {
        super(message)
        this.name = 'AccountDelegateError'
        this.code = code
        this.cause = options?.cause
        this.details = options?.details
    }
}

export type AccountDelegateArgs = {
    env: EnvName
    chains: ChainName[]
    keystorePath?: string
    name?: string
    passwordStdin: boolean
    json: boolean
    help: boolean
}

export type AccountDelegateOptions = {
    env: EnvName
    chains: ChainName[]
    keystorePath?: string
    name?: string
    password: string
}

export type AccountDelegateChainResult = {
    chain: ChainName
    chainId: number
    status: 'delegated' | 'already_delegated' | 'failed'
    txHash?: Hex
    errorCode?: string
    errorMessage?: string
}

export type AccountDelegateResult = {
    type: 'account_delegate'
    status: 'complete'
    keystorePath: string
    rootAddress: Address
    sessionAddress: Address
    results: AccountDelegateChainResult[]
    hasFailures: boolean
}

type AccountDelegateDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    decryptRootKeystore: typeof decryptRootKeystore
    decryptSessionKeystore: typeof decryptSessionKeystore
    writeRootKeystoreFile: typeof writeRootKeystoreFile
    getDelegatedCode: (input: {
        network: CliNetworkConfig
        address: Address
    }) => Promise<Hex | undefined>
    delegateAccount: (input: {
        rootPrivateKey: Hex
        sessionAddress: Address
        network: CliNetworkConfig
        permissions: Permission[]
    }) => Promise<{ accountAddress: Address; txHash?: Hex }>
}

function getDefaultDeps(): AccountDelegateDeps {
    return {
        readKeystoreBundle,
        decryptRootKeystore,
        decryptSessionKeystore,
        writeRootKeystoreFile,
        getDelegatedCode: ({ network, address }) => readAccountCode({ network, address }),
        delegateAccount: async ({ rootPrivateKey, sessionAddress, network, permissions }) =>
            delegateAccountWithAuthorizeKeys({
                rootPrivateKey,
                sessionAddress,
                network,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'normal',
                        publicKey: encodeSecp256k1Key(sessionAddress),
                        permissions,
                    } satisfies AuthorizeKey,
                ],
            }),
    }
}

export async function resolveAccountDelegatePassword(
    args: Pick<AccountDelegateArgs, 'env' | 'chains' | 'passwordStdin' | 'json' | 'help'>,
    deps: {
        envPassword?: string
        readPasswordFromStdin: () => string
        promptForExistingPassword: () => Promise<string>
        isInteractive: boolean
    },
): Promise<string> {
    if (deps.envPassword) {
        return deps.envPassword
    }

    if (args.passwordStdin) {
        return deps.readPasswordFromStdin()
    }

    if (deps.isInteractive) {
        return deps.promptForExistingPassword()
    }

    throw new AccountDelegateError(
        'PASSWORD_REQUIRED',
        'Password required. Use --password-stdin, TW_PASSWORD, RELAYER_CLI_PASSWORD, or run in interactive TTY.',
    )
}

export async function executeAccountDelegate(
    options: AccountDelegateOptions,
    depsArg?: Partial<AccountDelegateDeps>,
): Promise<AccountDelegateResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    let keystorePath = options.keystorePath ?? '<default>'

    try {
        keystorePath = resolveKeystorePath({
            env: options.env,
            keystorePath: options.keystorePath,
            name: options.name,
        })

        const bundle = await deps.readKeystoreBundle(keystorePath)
        const rootAddress = getAddress(bundle.root.addresses.root)
        const sessionAddress = getAddress(bundle.session.addresses.session)
        const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
        await deps.decryptSessionKeystore(bundle.session, options.password)

        const results: AccountDelegateChainResult[] = []
        let hasDelegatedAtLeastOne = false

        for (const chain of options.chains) {
            const network = resolveNetworkConfig(options.env, chain)
            try {
                const code = await deps.getDelegatedCode({ network, address: rootAddress })
                if (hasDelegationCode(code)) {
                    results.push({
                        chain,
                        chainId: network.chainId,
                        status: 'already_delegated',
                    })
                    continue
                }

                const delegation = await deps.delegateAccount({
                    rootPrivateKey: decryptedRoot.rootPrivateKey,
                    sessionAddress,
                    network,
                    permissions: getDefaultSessionPermissions(network.chainId),
                })
                hasDelegatedAtLeastOne = true
                results.push({
                    chain,
                    chainId: network.chainId,
                    status: 'delegated',
                    txHash: delegation.txHash,
                })
            } catch (error) {
                const mapped = toAccountDelegateError(error, { keystorePath })
                results.push({
                    chain,
                    chainId: network.chainId,
                    status: 'failed',
                    errorCode: mapped.code,
                    errorMessage: mapped.message,
                })
            }
        }

        if (hasDelegatedAtLeastOne) {
            bundle.root.checkpoint = 'complete'
            bundle.root.addresses.delegated = rootAddress
            await deps.writeRootKeystoreFile(keystorePath, bundle.root, { overwrite: true })
        }

        return {
            type: 'account_delegate',
            status: 'complete',
            keystorePath,
            rootAddress,
            sessionAddress,
            results,
            hasFailures: results.some((result) => result.status === 'failed'),
        }
    } catch (error) {
        throw toAccountDelegateError(error, { keystorePath })
    }
}

function toAccountDelegateError(
    error: unknown,
    context: { keystorePath: string },
): AccountDelegateError {
    if (error instanceof AccountDelegateError) {
        return error
    }

    if (error instanceof AccountCreateError && error.code === 'INVALID_NAME') {
        return new AccountDelegateError('INVALID_NAME', error.message, { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)

    if (message.includes('ENOENT') || message.toLowerCase().includes('no such file')) {
        return new AccountDelegateError(
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
        return new AccountDelegateError('PASSWORD_REQUIRED', message, { cause: error })
    }

    if (message.includes('Relayer capabilities missing accountProxy')) {
        return new AccountDelegateError('RELAYER_CAPABILITIES_MISSING', message, { cause: error })
    }

    if (message.includes('Delegation failed')) {
        return new AccountDelegateError('DELEGATION_FAILED', message, { cause: error })
    }

    if (message.includes('Unsupported chain')) {
        return new AccountDelegateError('UNSUPPORTED_CHAIN', message, { cause: error })
    }

    return new AccountDelegateError('UNKNOWN', message, { cause: error })
}
