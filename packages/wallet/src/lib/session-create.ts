import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import {
    decodeIntentError,
    type Call,
    type PrepareCallsResponse,
    type BundleStatusResponse,
    type GetKeysResponse,
    type SpendPeriod,
} from '@nubl/relayer-client'
import { accountAbi } from '@nubl/contracts/abis'
import { resolveKeystorePath } from './account-create'
import {
    createSessionKeystore,
    decryptRootKeystore,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    withKeystoreLock,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
    type AnySessionKeystore,
} from './keystore'
import {
    resolveNetworkConfig,
    selectDefaultChain,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
} from './network-config'
import {
    createCliRelayerClient,
    createEthHttpSigner,
    readAccountNonce,
} from './relayer-client-utils'
import {
    executeSignedCalls,
    type ExecuteSignedCallsDeps,
    type ExecuteSignedCallsParams,
} from './execute-calls'
import {
    buildPermissionDefaults,
    computeSessionKeyHash,
    parseSessionName,
    getChainKeys,
    toSpendPeriodEnum,
    parseExpiry,
} from './session-common'

type SessionCreateErrorCode =
    | 'INVALID_NAME'
    | 'MISSING_ARGUMENT'
    | 'KEYSTORE_NOT_FOUND'
    | 'PASSWORD_REQUIRED'
    | 'SESSION_NAME_CONFLICT'
    | 'SESSION_NOT_DELEGATED'
    | 'SESSION_CREATE_FAILED'
    | 'SESSION_AUTHORIZATION_FAILED'
    | 'KEYSTORE_LOCKED'
    | 'UNKNOWN'

export class SessionCreateError extends Error {
    code: SessionCreateErrorCode
    cause?: unknown
    recoveryCommand?: string
    details?: unknown

    constructor(
        code: SessionCreateErrorCode,
        message: string,
        options?: { cause?: unknown; recoveryCommand?: string; details?: unknown },
    ) {
        super(message)
        this.name = 'SessionCreateError'
        this.code = code
        this.cause = options?.cause
        this.recoveryCommand = options?.recoveryCommand
        this.details = options?.details
    }
}

export type SessionCreateArgs = {
    env: EnvName
    name?: string
    sessionName?: string
    keystorePath?: string
    chain: ChainName
    activate: boolean
    resume: boolean
    fullAccess: boolean
    target?: Address
    selectors: Hex[]
    spendLimit?: bigint
    spendPeriod?: SpendPeriod
    expiry?: string
    passwordStdin: boolean
    json: boolean
    help: boolean
}

export type SessionCreateOptions = {
    env: EnvName
    chain?: ChainName
    name?: string
    keystorePath?: string
    sessionName: string
    activate?: boolean
    resume?: boolean
    fullAccess?: boolean
    noPermissions?: boolean
    target?: Address
    selectors?: Hex[]
    spendLimit?: bigint
    spendPeriod?: SpendPeriod
    expiry?: string
    password: string
}

export type SessionCreateResult = {
    type: 'session_create'
    status: 'complete'
    resumed: boolean
    keystorePath: string
    sessionPath: string
    activeSession: string
    network: CliNetworkConfig
    accountAddress: Address
    session: {
        name: string
        address: Address
        checkpoint: AnySessionKeystore['checkpoint']
        keyHash: Hex
        expiry: number
    }
    permissions?: {
        target: Address
        selectors: Hex[]
        spendToken: Address
        spendLimit: string
        spendPeriod: SpendPeriod
    }
    bundle: {
        id: string
        status: string
        statusCode: number
    }
    txHash?: Hex
}

type SessionCreateDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    createSessionKeystore: typeof createSessionKeystore
    writeSessionKeystoreFile: typeof writeSessionKeystoreFile
    writeRootKeystoreFile: typeof writeRootKeystoreFile
    decryptRootKeystore: typeof decryptRootKeystore
    generatePrivateKey: typeof generatePrivateKey
    fileExists: (path: string) => Promise<boolean>
    readNonce: (input: { network: CliNetworkConfig; account: Address }) => Promise<bigint>
    getKeys: (input: {
        network: CliNetworkConfig
        account: Address
        chainId: number
    }) => Promise<GetKeysResponse>
    sleep: (ms: number) => Promise<void>
    executeSignedCalls: (
        deps: ExecuteSignedCallsDeps,
        params: ExecuteSignedCallsParams,
    ) => Promise<{ id: string; finalStatus: BundleStatusResponse }>
    prepareCalls: (input: {
        network: CliNetworkConfig
        from: Address
        calls: Call[]
        nonce: bigint
        sessionKey?: Hex
    }) => Promise<PrepareCallsResponse>
    signTypedData: (input: {
        privateKey: Hex
        typedData: PrepareCallsResponse['typedData']
    }) => Promise<Hex>
    sendPreparedCalls: (input: {
        network: CliNetworkConfig
        context: PrepareCallsResponse['context']
        signature: Hex
    }) => Promise<{ id: string }>
    waitForBundle: (input: {
        network: CliNetworkConfig
        id: string
    }) => Promise<BundleStatusResponse>
    withKeystoreLock: typeof withKeystoreLock
}

function normalizeChain(value?: string, env: EnvName = 'prod'): ChainName {
    try {
        return selectDefaultChain(env, value)
    } catch (error) {
        throw new SessionCreateError(
            'UNKNOWN',
            error instanceof Error ? error.message : `Unsupported chain: ${value}`,
            { cause: error },
        )
    }
}

function getDefaultDeps(): SessionCreateDeps {
    return {
        readKeystoreBundle,
        readSessionKeystoreFile,
        createSessionKeystore,
        writeSessionKeystoreFile,
        writeRootKeystoreFile,
        decryptRootKeystore,
        generatePrivateKey,
        fileExists: async (path) => {
            try {
                await access(path, constants.F_OK)
                return true
            } catch {
                return false
            }
        },
        readNonce: async ({ network, account }) => {
            const client = createCliRelayerClient(network)
            return readAccountNonce(client, account)
        },
        getKeys: async ({ network, account, chainId }) => {
            const client = createCliRelayerClient(network)
            return client.getKeys({ address: account, chainIds: [chainId] })
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        executeSignedCalls,
        prepareCalls: async (input) => {
            const client = createCliRelayerClient(input.network)
            return client.prepareCalls({
                from: input.from,
                chainId: input.network.chainId,
                calls: input.calls,
                nonce: input.nonce,
                sessionKey: input.sessionKey,
            })
        },
        signTypedData: async (input) => {
            return (await import('viem/accounts'))
                .privateKeyToAccount(input.privateKey)
                .signTypedData(input.typedData)
        },
        sendPreparedCalls: async (input) => {
            const client = createCliRelayerClient(input.network)
            return client.sendPreparedCalls({ context: input.context, signature: input.signature })
        },
        waitForBundle: async (input) => {
            const client = createCliRelayerClient(input.network)
            return (await import('@nubl/relayer-client')).waitForBundle(client, {
                id: input.id,
                chainId: input.network.chainId,
            })
        },
        withKeystoreLock,
    }
}

export async function resolveSessionCreatePassword(
    args: Pick<SessionCreateArgs, 'passwordStdin'>,
    deps: {
        envPassword?: string
        readPasswordFromStdin: () => string
        promptForExistingPassword: () => Promise<string>
        isInteractive: boolean
    },
): Promise<string> {
    if (deps.envPassword) return deps.envPassword
    if (args.passwordStdin) return deps.readPasswordFromStdin()
    if (deps.isInteractive) return deps.promptForExistingPassword()
    throw new SessionCreateError(
        'PASSWORD_REQUIRED',
        'Password required. Use --password-stdin, TW_PASSWORD, or run in interactive TTY.',
    )
}

export async function executeSessionCreate(
    options: SessionCreateOptions,
    depsArg?: Partial<SessionCreateDeps>,
): Promise<SessionCreateResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const chain = options.chain
        ? normalizeChain(options.chain, options.env)
        : selectDefaultChain(options.env)
    const network = resolveNetworkConfig(options.env, chain)
    const keystorePath = resolveKeystorePath({
        env: options.env,
        keystorePath: options.keystorePath,
        name: options.name,
    })
    const sessionName = parseSessionName(options.sessionName)

    return deps.withKeystoreLock(keystorePath, async () => {
        const bundle = await deps.readKeystoreBundle(keystorePath)

        const accountAddress = bundle.root.addresses.delegated
            ? getAddress(bundle.root.addresses.delegated)
            : undefined
        if (!accountAddress) {
            throw new SessionCreateError(
                'SESSION_NOT_DELEGATED',
                'Account is not delegated yet. Run `tw account create --resume` first.',
                { recoveryCommand: 'tw account create --resume --password-stdin --json' },
            )
        }

        const sessionPath = resolveSessionKeystorePath(
            keystorePath,
            sessionName,
            bundle.root.sessionRef.dir,
        )

        const fileExists = await deps.fileExists(sessionPath)
        if (fileExists && !options.resume) {
            throw new SessionCreateError(
                'SESSION_NAME_CONFLICT',
                `Session already exists: ${sessionName}`,
                { recoveryCommand: `tw session create ${sessionName} --resume --json` },
            )
        }

        let sessionKeystore: AnySessionKeystore
        if (fileExists) {
            sessionKeystore = await deps.readSessionKeystoreFile(sessionPath)
            if (sessionKeystore.name !== sessionName) {
                throw new SessionCreateError(
                    'SESSION_NAME_CONFLICT',
                    `Session file mismatch for ${sessionName}.`,
                )
            }
        } else {
            const sessionPrivateKey = deps.generatePrivateKey()
            sessionKeystore = await deps.createSessionKeystore({
                password: options.password,
                sessionPrivateKey,
                network,
                delegated: accountAddress,
                name: sessionName,
                checkpoint: 'initialized',
            })
            await deps.writeSessionKeystoreFile(sessionPath, sessionKeystore)
        }

        const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
        const signedNetwork = {
            ...network,
            authSigner: createEthHttpSigner(decryptedRoot.rootPrivateKey, network.chainId),
        }

        const sessionAddress = getAddress(sessionKeystore.addresses.session)
        const sessionKeyHash = computeSessionKeyHash(sessionAddress)

        const permissionDefaults = options.noPermissions
            ? undefined
            : buildPermissionDefaults({
                  fullAccess: options.fullAccess ?? false,
                  chain,
                  target: options.target,
                  selectors: options.selectors,
                  spendLimit: options.spendLimit,
                  spendPeriod: options.spendPeriod,
              })
        const permissionResult = permissionDefaults
            ? {
                  target: permissionDefaults.target,
                  selectors: permissionDefaults.selectors,
                  spendToken: permissionDefaults.spendToken,
                  spendLimit: permissionDefaults.spendLimit.toString(),
                  spendPeriod: permissionDefaults.spendPeriod,
              }
            : undefined

        if (options.resume && sessionKeystore.checkpoint === 'authorized') {
            const onChainKeys = await deps.getKeys({
                network: signedNetwork,
                account: accountAddress,
                chainId: network.chainId,
            })
            const chainKeys = getChainKeys(onChainKeys, network.chainId)
            const authorized = chainKeys.some(
                (entry: { hash?: string }) =>
                    typeof entry.hash === 'string' &&
                    entry.hash.toLowerCase() === sessionKeyHash.toLowerCase(),
            )
            if (authorized) {
                const matchedKey = chainKeys.find(
                    (entry: { hash?: string }) =>
                        typeof entry.hash === 'string' &&
                        entry.hash.toLowerCase() === sessionKeyHash.toLowerCase(),
                )
                const onChainExpiry =
                    matchedKey && typeof matchedKey.expiry === 'string'
                        ? Number(matchedKey.expiry)
                        : 0
                if (options.activate) {
                    bundle.root.sessionRef.active = sessionName
                    await deps.writeRootKeystoreFile(keystorePath, bundle.root, { overwrite: true })
                }
                return {
                    type: 'session_create',
                    status: 'complete',
                    resumed: true,
                    keystorePath,
                    sessionPath,
                    activeSession: options.activate ? sessionName : bundle.root.sessionRef.active,
                    network,
                    accountAddress,
                    session: {
                        name: sessionName,
                        address: sessionAddress,
                        checkpoint: 'authorized',
                        keyHash: sessionKeyHash,
                        expiry: onChainExpiry,
                    },
                    permissions: permissionResult,
                    bundle: {
                        id: 'resume-noop',
                        status: 'confirmed',
                        statusCode: 200,
                    },
                }
            }
        }

        const expiryTimestamp = options.expiry ? parseExpiry(options.expiry) : 0

        const authorizeCallData = encodeFunctionData({
            abi: accountAbi,
            functionName: 'authorize',
            args: [
                {
                    expiry: expiryTimestamp,
                    keyType: 0,
                    isSuperAdmin: false,
                    publicKey: (await import('@nubl/relayer-client')).encodeSecp256k1Key(
                        sessionAddress,
                    ),
                },
            ],
        })

        const calls: Call[] = [
            {
                target: accountAddress,
                value: 0n,
                data: authorizeCallData,
            },
        ]
        if (permissionDefaults) {
            calls.push({
                target: accountAddress,
                value: 0n,
                data: encodeFunctionData({
                    abi: accountAbi,
                    functionName: 'setSpendLimit',
                    args: [
                        sessionKeyHash,
                        permissionDefaults.spendToken,
                        toSpendPeriodEnum(permissionDefaults.spendPeriod),
                        permissionDefaults.spendLimit,
                    ],
                }),
            })
            calls.push(
                ...permissionDefaults.selectors.map((selector) => ({
                    target: accountAddress,
                    value: 0n,
                    data: encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'setCanExecute',
                        args: [sessionKeyHash, permissionDefaults.target, selector, true],
                    }),
                })),
            )
        }

        const nonce = await deps.readNonce({ network: signedNetwork, account: accountAddress })
        const submission = await deps.executeSignedCalls(
            {
                prepareCalls: (input) =>
                    deps.prepareCalls({
                        network: signedNetwork,
                        from: input.from,
                        calls: input.calls,
                        nonce: input.nonce,
                        sessionKey: input.sessionKey,
                    }),
                signTypedData: deps.signTypedData,
                sendPreparedCalls: (input) =>
                    deps.sendPreparedCalls({
                        network: signedNetwork,
                        context: input.context,
                        signature: input.signature,
                    }),
                waitForBundle: (input) =>
                    deps.waitForBundle({ network: signedNetwork, id: input.id }),
            },
            {
                from: accountAddress,
                calls,
                nonce,
                signerPrivateKey: decryptedRoot.rootPrivateKey,
                chainId: signedNetwork.chainId,
                env: signedNetwork.env,
            },
        )

        const finalStatus = submission.finalStatus
        const statusCode = finalStatus.statusCode ?? 0
        if (!finalStatus.success || ![200, 201].includes(statusCode)) {
            const intentError = finalStatus.receipt?.intentError as Hex | undefined
            throw new SessionCreateError(
                'SESSION_CREATE_FAILED',
                finalStatus.error ??
                    `Bundle ended in status ${statusCode} (${finalStatus.status ?? 'unknown'}).`,
                {
                    details: {
                        statusCode,
                        txHash: finalStatus.receipt?.transactionHash,
                        intentError,
                        intentErrorName: intentError ? decodeIntentError(intentError) : undefined,
                    },
                    recoveryCommand: `tw session create ${sessionName} --resume --json`,
                },
            )
        }

        const keys = await deps.getKeys({
            network: signedNetwork,
            account: accountAddress,
            chainId: network.chainId,
        })
        let authorized = getChainKeys(keys, network.chainId).some(
            (entry: { hash?: string }) =>
                typeof entry.hash === 'string' &&
                entry.hash.toLowerCase() === sessionKeyHash.toLowerCase(),
        )
        if (!authorized) {
            for (let attempt = 0; attempt < 4; attempt += 1) {
                await deps.sleep(500 * (attempt + 1))
                const retryKeys = await deps.getKeys({
                    network: signedNetwork,
                    account: accountAddress,
                    chainId: network.chainId,
                })
                authorized = getChainKeys(retryKeys, network.chainId).some(
                    (entry: { hash?: string }) =>
                        typeof entry.hash === 'string' &&
                        entry.hash.toLowerCase() === sessionKeyHash.toLowerCase(),
                )
                if (authorized) break
            }
        }
        if (!authorized) {
            throw new SessionCreateError(
                'SESSION_AUTHORIZATION_FAILED',
                `Session ${sessionName} was not found on-chain after confirmation (verification may be delayed).`,
                { recoveryCommand: 'tw session list --on-chain --json' },
            )
        }

        sessionKeystore = {
            ...sessionKeystore,
            checkpoint: 'authorized',
        }
        await deps.writeSessionKeystoreFile(sessionPath, sessionKeystore, { overwrite: true })

        if (options.activate) {
            bundle.root.sessionRef.active = sessionName
            await deps.writeRootKeystoreFile(keystorePath, bundle.root, { overwrite: true })
        }

        return {
            type: 'session_create',
            status: 'complete',
            resumed: false,
            keystorePath,
            sessionPath,
            activeSession: options.activate ? sessionName : bundle.root.sessionRef.active,
            network,
            accountAddress,
            session: {
                name: sessionName,
                address: sessionAddress,
                checkpoint: sessionKeystore.checkpoint,
                keyHash: sessionKeyHash,
                expiry: expiryTimestamp,
            },
            permissions: permissionResult,
            bundle: {
                id: submission.id,
                status: finalStatus.status ?? 'unknown',
                statusCode,
            },
            txHash: finalStatus.receipt?.transactionHash,
        }
    })
}
