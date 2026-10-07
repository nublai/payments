import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ERC20_SELECTORS } from '@nubl/relayer-client'
import { getAddressesWithFallback } from '@nubl/contracts/deployments'
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
import { DEFAULT_SESSION_SPEND_LIMIT } from './session-common'
import { FirstUpgradeError, runFirstUpgrade } from './first-upgrade'
type AccountCreateErrorCode =
    | 'PASSWORD_REQUIRED'
    | 'INVALID_NAME'
    | 'KEYSTORE_EXISTS'
    | 'RELAYER_CAPABILITIES_MISSING'
    | 'DELEGATION_FAILED'
    | 'PERMISSIONS_PENDING'
    | 'SESSION_KEY_ADMIN'
    | 'UNKNOWN'

type NetworkDefaults = CliNetworkConfig

const ESCROW_ESCROW_SELECTOR = '0x657061bf' as Hex
const ESCROW_REFUND_SELECTOR = '0x6023fda5' as Hex
const ESCROW_SETTLE_SELECTOR = '0xe7f921a2' as Hex
const SIMPLE_SETTLER_WRITE_SELECTOR = '0x84523a30' as Hex

/**
 * Narrow default session. `write` and `settle` are included because
 * `tw escrow settle` submits SimpleSettler.write and Escrow.settle from this key.
 * A chain with no known USDC or Escrow address throws. There is no wildcard fallback.
 */
export function getDefaultSessionPermissions(
    chainId?: number,
    options?: { legacy?: boolean; env?: EnvName },
) {
    if (!chainId || !options?.env) {
        throw new AccountCreateError(
            'UNKNOWN',
            'Cannot build the default session without a chain and env. Refusing a wildcard fallback.',
        )
    }
    const token = getUsdcAddressByChainId(chainId, options.legacy ?? false)
    const addresses = getAddressesWithFallback(options.env, chainId)
    if (!token || !addresses?.escrow || !addresses.simpleSettler) {
        throw new AccountCreateError(
            'UNKNOWN',
            `No USDC or Escrow address for chain ${chainId}. Refusing a wildcard session.`,
        )
    }
    const call = (to: Address, selector: Hex) => ({
        type: 'call' as const,
        to,
        selector,
    })
    return [
        call(token, ERC20_SELECTORS.TRANSFER),
        call(token, ERC20_SELECTORS.APPROVE),
        call(addresses.escrow, ESCROW_ESCROW_SELECTOR),
        call(addresses.escrow, ESCROW_REFUND_SELECTOR),
        call(addresses.simpleSettler, SIMPLE_SETTLER_WRITE_SELECTOR),
        call(addresses.escrow, ESCROW_SETTLE_SELECTOR),
        {
            type: 'spend' as const,
            token,
            limit: DEFAULT_SESSION_SPEND_LIMIT.toString(),
            period: 'day' as const,
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
    permissionsTxHash?: string
    upgradePath?: 'paid' | 'sponsored'
}

type DelegateInput = {
    rootPrivateKey: Hex
    sessionAddress: string
    network: NetworkDefaults
    keystorePath?: string
    sessionsDir?: string
    onKeyAuthorized?: (accountAddress: Address) => Promise<void>
}

type DelegateResult = {
    accountAddress: string
    txHash?: string
    permissionsTxHash?: string
    path?: 'paid' | 'sponsored'
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
    const result = await runFirstUpgrade({
        rootPrivateKey: input.rootPrivateKey,
        sessionAddress: input.sessionAddress as Address,
        network: input.network,
        permissions: getDefaultSessionPermissions(input.network.chainId, {
            env: input.network.env,
        }),
        keystorePath: input.keystorePath,
        sessionsDir: input.sessionsDir,
        onKeyAuthorized: input.onKeyAuthorized,
    })

    return {
        accountAddress: result.accountAddress,
        txHash: result.txHash,
        permissionsTxHash: result.permissionsTxHash,
        path: result.path,
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

    if (error instanceof FirstUpgradeError) {
        if (error.code === 'PERMISSIONS_PENDING') {
            return new AccountCreateError('PERMISSIONS_PENDING', error.message, {
                recoveryCommand: error.recoveryCommand ?? buildResumeCommand(context.keystorePath),
                cause: error,
            })
        }
        if (error.code === 'SESSION_KEY_ADMIN') {
            return new AccountCreateError('SESSION_KEY_ADMIN', error.message, { cause: error })
        }
        return new AccountCreateError('DELEGATION_FAILED', error.message, { cause: error })
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
            keystorePath,
            sessionsDir: rootKeystore.sessionRef.dir,
            onKeyAuthorized: async (accountAddress) => {
                rootKeystore.network = network
                rootKeystore.addresses.delegated = accountAddress
                rootKeystore.checkpoint = 'delegated'
                await deps.writeRootKeystoreFile(keystorePath, rootKeystore, { overwrite: true })
                if (sessionKeystore) {
                    sessionKeystore.addresses.delegated = accountAddress
                    await deps.writeSessionKeystoreFile(sessionKeystorePath, sessionKeystore, {
                        overwrite: true,
                    })
                }
            },
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
            permissionsTxHash: delegated.permissionsTxHash,
            upgradePath: delegated.path,
        }
    } catch (error) {
        throw toAccountCreateError(error, { keystorePath })
    }
}
