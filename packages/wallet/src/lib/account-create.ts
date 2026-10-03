import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ANY_FUNCTION_SELECTOR, ANY_TARGET, encodeSecp256k1Key } from '@agentic-payments/relayer-client'
import {
    createRootKeystore,
    createSessionKeystore,
    decryptRootKeystore,
    decryptSessionKeystore,
    readKeystoreBundle,
    resolveSessionKeystorePath,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
    type AnySessionKeystore,
    type RelayerRootKeystoreV2,
} from './keystore'
import {
    getUsdcAddressByChainId,
    resolveNetworkConfig,
    selectDefaultChain,
    type CliNetworkConfig,
    type EnvName,
} from './network-config'
import { delegateAccountWithAuthorizeKeys } from './delegation-utils'
type AccountCreateErrorCode =
    | 'PASSWORD_REQUIRED'
    | 'INVALID_NAME'
    | 'KEYSTORE_EXISTS'
    | 'RELAYER_CAPABILITIES_MISSING'
    | 'DELEGATION_FAILED'
    | 'UNKNOWN'

type NetworkDefaults = CliNetworkConfig

const MAX_UINT256_DECIMAL = (2n ** 256n - 1n).toString()

export function getDefaultSessionPermissions(chainId?: number, options?: { legacy?: boolean }) {
    const callPermission = {
        type: 'call' as const,
        to: ANY_TARGET,
        selector: ANY_FUNCTION_SELECTOR,
    }
    const token = chainId ? getUsdcAddressByChainId(chainId, options?.legacy ?? false) : undefined
    if (!token) {
        return [callPermission]
    }
    return [
        callPermission,
        {
            type: 'spend' as const,
            token,
            limit: MAX_UINT256_DECIMAL,
            period: 'forever' as const,
        },
    ]
}

export type AccountCreateOptions = {
    env: EnvName
    relayerUrl?: string
    rpcUrl?: string
    chainId?: number
    keystorePath?: string
    password: string
    resume?: boolean
}

export type AccountCreateResult = {
    type: 'account_create'
    status: 'complete'
    keystorePath: string
    network: NetworkDefaults
    addresses: {
        root: string
        session: string
        delegated: string
    }
    txHash?: string
}

type DelegateInput = {
    rootPrivateKey: Hex
    sessionAddress: string
    network: NetworkDefaults
}

type DelegateResult = {
    accountAddress: string
    txHash?: string
}

type AccountCreateDeps = {
    generatePrivateKey: typeof generatePrivateKey
    createRootKeystore: typeof createRootKeystore
    createSessionKeystore: typeof createSessionKeystore
    decryptRootKeystore: typeof decryptRootKeystore
    decryptSessionKeystore: typeof decryptSessionKeystore
    readKeystoreBundle: typeof readKeystoreBundle
    writeRootKeystoreFile: typeof writeRootKeystoreFile
    writeSessionKeystoreFile: typeof writeSessionKeystoreFile
    delegateAccount: (input: DelegateInput) => Promise<DelegateResult>
}

export class AccountCreateError extends Error {
    code: AccountCreateErrorCode
    recoveryCommand?: string
    cause?: unknown

    constructor(
        code: AccountCreateErrorCode,
        message: string,
        options?: { recoveryCommand?: string; cause?: unknown },
    ) {
        super(message)
        this.name = 'AccountCreateError'
        this.code = code
        this.recoveryCommand = options?.recoveryCommand
        this.cause = options?.cause
    }
}

export type AccountCreateArgs = {
    env: EnvName
    relayerUrl?: string
    rpcUrl?: string
    chainId?: number
    keystorePath?: string
    name?: string
    json: boolean
    resume: boolean
    passwordStdin: boolean
    help: boolean
}

function assertValidProfileName(name: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new AccountCreateError(
            'INVALID_NAME',
            'Invalid profile name. Use letters, numbers, hyphen, or underscore.',
        )
    }
}

export function getDefaultKeystorePath(env: EnvName, name = 'default'): string {
    assertValidProfileName(name)
    const base = [homedir(), '.config', 'agentic-payments', 'tw', 'profiles']
    if (name === 'default') {
        if (env === 'prod') {
            return join(...base, 'default', 'default.keystore.json')
        }
        return join(...base, env, 'default', 'default.keystore.json')
    }
    if (env === 'prod') {
        return join(...base, name, 'default.keystore.json')
    }
    return join(...base, env, name, 'default.keystore.json')
}

export function resolveKeystorePath(input: {
    env: EnvName
    keystorePath?: string
    name?: string
}): string {
    if (input.keystorePath) {
        return input.keystorePath
    }
    return getDefaultKeystorePath(input.env, input.name ?? 'default')
}

function resolveNetwork(options: AccountCreateOptions): NetworkDefaults {
    const defaults = resolveNetworkConfig(options.env, selectDefaultChain(options.env))
    return {
        env: options.env,
        relayerUrl: options.relayerUrl ?? defaults.relayerUrl,
        rpcUrl: options.rpcUrl ?? defaults.rpcUrl,
        chainId: options.chainId ?? defaults.chainId,
    }
}

async function defaultDelegateAccount(input: DelegateInput): Promise<DelegateResult> {
    const account = privateKeyToAccount(input.rootPrivateKey)
    const result = await delegateAccountWithAuthorizeKeys({
        rootPrivateKey: input.rootPrivateKey,
        sessionAddress: input.sessionAddress as `0x${string}`,
        network: input.network,
        authorizeKeys: [
            {
                expiry: '0',
                type: 'secp256k1',
                role: 'normal',
                publicKey: encodeSecp256k1Key(input.sessionAddress as `0x${string}`),
                permissions: getDefaultSessionPermissions(input.network.chainId),
            },
        ],
    })

    return {
        accountAddress: result.accountAddress ?? account.address,
        txHash: result.txHash,
    }
}

function getDefaultDeps(): AccountCreateDeps {
    return {
        generatePrivateKey,
        createRootKeystore,
        createSessionKeystore,
        decryptRootKeystore,
        decryptSessionKeystore,
        readKeystoreBundle,
        writeRootKeystoreFile,
        writeSessionKeystoreFile,
        delegateAccount: defaultDelegateAccount,
    }
}

function buildResumeCommand(keystorePath: string): string {
    return `tw account create --resume --keystore-path ${JSON.stringify(keystorePath)}`
}

async function defaultPathExists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK)
        return true
    } catch {
        return false
    }
}

export async function assertAccountCreateCanInitialize(
    input: { keystorePath: string; resume: boolean },
    deps?: { pathExists?: (path: string) => Promise<boolean> },
): Promise<void> {
    if (input.resume) {
        return
    }

    const pathExists = deps?.pathExists ?? defaultPathExists
    if (await pathExists(input.keystorePath)) {
        throw new AccountCreateError(
            'KEYSTORE_EXISTS',
            `Keystore already exists at ${input.keystorePath}`,
            {
                recoveryCommand: buildResumeCommand(input.keystorePath),
            },
        )
    }
}

function toAccountCreateError(
    error: unknown,
    context: { keystorePath: string },
): AccountCreateError {
    if (error instanceof AccountCreateError) {
        return error
    }

    const message = error instanceof Error ? error.message : String(error)

    if (message.includes('Keystore already exists at')) {
        return new AccountCreateError('KEYSTORE_EXISTS', message, {
            recoveryCommand: buildResumeCommand(context.keystorePath),
            cause: error,
        })
    }

    if (
        message.includes('No password provided on stdin') ||
        message.includes('Password cannot be empty') ||
        message.includes('Password confirmation does not match') ||
        message.includes('Password input cancelled')
    ) {
        return new AccountCreateError('PASSWORD_REQUIRED', message, { cause: error })
    }

    if (message.includes('Relayer capabilities missing accountProxy')) {
        return new AccountCreateError(
            'RELAYER_CAPABILITIES_MISSING',
            'Relayer did not return accountProxy capability for this chain.',
            {
                cause: error,
            },
        )
    }

    if (message.includes('Delegation failed')) {
        return new AccountCreateError('DELEGATION_FAILED', message, {
            cause: error,
        })
    }

    return new AccountCreateError('UNKNOWN', message, { cause: error })
}

export async function resolveAccountCreatePassword(
    args: AccountCreateArgs,
    deps: {
        envPassword?: string
        readPasswordFromStdin: () => string
        promptForPassword: () => Promise<string>
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
        return deps.promptForPassword()
    }

    throw new AccountCreateError(
        'PASSWORD_REQUIRED',
        'Password required. Use --password-stdin, TW_PASSWORD, RELAYER_CLI_PASSWORD, or run in interactive TTY.',
    )
}

export async function executeAccountCreate(
    options: AccountCreateOptions,
    depsArg?: Partial<AccountCreateDeps>,
): Promise<AccountCreateResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const network = resolveNetwork(options)
    const keystorePath = resolveKeystorePath({
        env: options.env,
        keystorePath: options.keystorePath,
    })

    let rootKeystore: RelayerRootKeystoreV2
    let sessionKeystore: AnySessionKeystore | null = null
    let rootPrivateKey: Hex
    let sessionPrivateKey: Hex
    let sessionKeystorePath = resolveSessionKeystorePath(keystorePath)

    try {
        if (options.resume) {
            const bundle = await deps.readKeystoreBundle(keystorePath)
            rootKeystore = bundle.root
            sessionKeystore = bundle.session
            sessionKeystorePath = bundle.sessionPath

            const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
            const decryptedSession = await deps.decryptSessionKeystore(
                bundle.session,
                options.password,
            )
            rootPrivateKey = decryptedRoot.rootPrivateKey
            sessionPrivateKey = decryptedSession.sessionPrivateKey

            if (rootKeystore.checkpoint === 'complete' && rootKeystore.addresses.delegated) {
                return {
                    type: 'account_create',
                    status: 'complete',
                    keystorePath,
                    network,
                    addresses: {
                        root: rootKeystore.addresses.root,
                        session: sessionKeystore!.addresses.session,
                        delegated: rootKeystore.addresses.delegated,
                    },
                }
            }
        } else {
            rootPrivateKey = deps.generatePrivateKey()
            sessionPrivateKey = deps.generatePrivateKey()
            rootKeystore = await deps.createRootKeystore({
                password: options.password,
                rootPrivateKey,
                env: network.env,
                relayerUrl: network.relayerUrl,
                rpcUrl: network.rpcUrl,
                chainId: network.chainId,
            })
            sessionKeystorePath = resolveSessionKeystorePath(
                keystorePath,
                rootKeystore.sessionRef.active,
                rootKeystore.sessionRef.dir,
            )

            await deps.writeRootKeystoreFile(keystorePath, rootKeystore)
        }

        if (!options.resume) {
            sessionKeystore = await deps.createSessionKeystore({
                password: options.password,
                sessionPrivateKey,
                network,
                delegated: rootKeystore.addresses.root,
                name: rootKeystore.sessionRef.active,
            })
            await deps.writeSessionKeystoreFile(sessionKeystorePath, sessionKeystore)
        }

        const sessionAddress = privateKeyToAccount(sessionPrivateKey).address
        const delegated = await deps.delegateAccount({
            rootPrivateKey,
            sessionAddress,
            network,
        })

        rootKeystore.network = network
        rootKeystore.addresses.delegated = delegated.accountAddress
        rootKeystore.checkpoint = 'complete'
        await deps.writeRootKeystoreFile(keystorePath, rootKeystore, { overwrite: true })
        if (sessionKeystore) {
            sessionKeystore.addresses.delegated = delegated.accountAddress
            await deps.writeSessionKeystoreFile(sessionKeystorePath, sessionKeystore, {
                overwrite: true,
            })
        }

        return {
            type: 'account_create',
            status: 'complete',
            keystorePath,
            network,
            addresses: {
                root: rootKeystore.addresses.root,
                session: sessionKeystore!.addresses.session,
                delegated: delegated.accountAddress,
            },
            txHash: delegated.txHash,
        }
    } catch (error) {
        throw toAccountCreateError(error, { keystorePath })
    }
}
