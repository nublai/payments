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
    getChainConfig,
    getUsdcTokenConfig,
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
    type ExecuteSignedCallsResult,
} from './execute-calls'
import {
    CONFIRM_FULL_ACCESS_PHRASE,
    CONFIRM_SWAP_SESSION_PHRASE,
    HumanConfirmationError,
    humanConfirmationMessage,
} from './human-confirmation'
import { relayEntryPoints } from './relay-allowlist'
import { swapSessionInstallCalls } from './swap-session'
import {
    assertNoStandingRights,
    chainStandingRightsReaders,
    knownErc20Tokens,
    relayStandingTargets,
    StandingRightsRejected,
    type Permit2Allowance,
    type StandingRightsRegistry,
} from './standing-rights'
import { readActiveUsdcDaily } from './session-gates'
import {
    buildPermissionDefaults,
    computeSessionKeyHash,
    DEFAULT_SESSION_SPEND_LIMIT,
    parseSessionName,
    getChainKeys,
    normalizedDailyUsdcUnits,
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
    /** Set only after the caller collected CREATE FULL ACCESS SESSION. */
    fullAccessPhraseConfirmed?: boolean
    /** Set only after the caller collected CREATE SWAP SESSION at a TTY. */
    swapPhraseConfirmed?: boolean
    /**
     * Dedicated swap session: Relay entrypoints and a minute spend of 0 on
     * known tokens. Does not install 10 USDC/day and does not become the
     * active session. Requires CREATE SWAP SESSION, not the full-access phrase.
     */
    swap?: boolean
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
    swap?: {
        calls: { target: Address; selector: Hex }[]
        spend: { token: Address; limit: '0'; period: 'minute' }[]
    }
    bundle: {
        id: string
        status: string
        statusCode: number
    }
    txHash?: Hex
    feeCap?: ExecuteSignedCallsResult['feeCap']
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
    ) => Promise<ExecuteSignedCallsResult>
    prepareCalls: (input: {
        network: CliNetworkConfig
        from: Address
        calls: Call[]
        nonce: bigint
        sessionKey?: Hex
        expiry: bigint
        payer?: Address
        paymentToken?: Address
        paymentMaxAmount?: bigint
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
    readErc20Allowance: (input: {
        network: CliNetworkConfig
        owner: Address
        token: Address
        spender: Address
    }) => Promise<bigint>
    readPermit2Allowance: (input: {
        network: CliNetworkConfig
        owner: Address
        token: Address
        spender: Address
    }) => Promise<Permit2Allowance>
    standingRightsRegistry?: StandingRightsRegistry
    readErc721ApprovedForAll?: (token: Address, operator: Address) => Promise<boolean>
    readErc721GetApproved?: (token: Address, tokenId: bigint) => Promise<Address>
    readErc1155ApprovedForAll?: (token: Address, operator: Address) => Promise<boolean>
    readErc4626ShareBalance?: (vault: Address) => Promise<bigint>
    readErc4626ShareAllowance?: (vault: Address, spender: Address) => Promise<bigint>
    readApprovedSignatureCheckers?: (keyHash: Hex) => Promise<readonly Address[]>
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
                expiry: input.expiry,
                payer: input.payer,
                paymentToken: input.paymentToken,
                paymentMaxAmount: input.paymentMaxAmount,
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
        readErc20Allowance: async (input) =>
            chainStandingRightsReaders({
                network: input.network,
                owner: input.owner,
            }).readErc20Allowance(input.token, input.spender),
        readPermit2Allowance: async (input) =>
            chainStandingRightsReaders({
                network: input.network,
                owner: input.owner,
            }).readPermit2Allowance(input.token, input.spender),
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

function assertSwapCreateOptions(options: SessionCreateOptions, chainId: number): void {
    if (
        options.fullAccess ||
        options.noPermissions ||
        options.activate ||
        options.target !== undefined ||
        (options.selectors !== undefined && options.selectors.length > 0) ||
        options.spendLimit !== undefined ||
        options.spendPeriod !== undefined
    ) {
        throw new SessionCreateError(
            'SESSION_CREATE_FAILED',
            '--swap cannot be combined with --full-access, --activate, --target, --selector, --spend-limit, or --spend-period. The swap session stays inactive so the payment key remains the active session.',
        )
    }

    if (!options.swapPhraseConfirmed) {
        throw new HumanConfirmationError(
            humanConfirmationMessage('Creating a swap session', CONFIRM_SWAP_SESSION_PHRASE),
        )
    }

    if (relayEntryPoints(chainId).length === 0) {
        throw new SessionCreateError(
            'SESSION_CREATE_FAILED',
            `Chain ${chainId} has no relay.link contracts. Refusing to create a swap session.`,
        )
    }
}

export async function executeSessionCreate(
    options: SessionCreateOptions,
    depsArg?: Partial<SessionCreateDeps>,
): Promise<SessionCreateResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }

    const chain = options.chain
        ? normalizeChain(options.chain, options.env)
        : selectDefaultChain(options.env)

    if (options.swap) {
        const chainId = getChainConfig(chain).chainId
        assertSwapCreateOptions(options, chainId)
    }

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

        const swapInstall = options.swap
            ? swapSessionInstallCalls({
                  account: accountAddress,
                  keyHash: sessionKeyHash,
                  chainId: network.chainId,
              })
            : undefined

        const permissionDefaults =
            options.noPermissions || swapInstall
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

        const swapResult = swapInstall
            ? {
                  calls: swapInstall.entryPoints.map((entry) => ({
                      target: entry.target,
                      selector: entry.selector,
                  })),
                  spend: swapInstall.spendTokens.map((token) => ({
                      token,
                      limit: '0' as const,
                      period: 'minute' as const,
                  })),
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
                    swap: swapResult,
                    bundle: {
                        id: 'resume-noop',
                        status: 'confirmed',
                        statusCode: 200,
                    },
                }
            }
        }

        if (permissionDefaults && !options.fullAccessPhraseConfirmed) {
            const usdc = getUsdcTokenConfig(chain).address

            if (permissionDefaults.spendToken.toLowerCase() === usdc.toLowerCase()) {
                const proposed = normalizedDailyUsdcUnits(
                    permissionDefaults.spendLimit,
                    permissionDefaults.spendPeriod,
                )

                const existing = await readActiveUsdcDaily({
                    env: options.env,
                    chain,
                    name: options.name,
                    keystorePath,
                })

                if (
                    existing === 'unreadable' ||
                    existing + proposed > DEFAULT_SESSION_SPEND_LIMIT
                ) {
                    throw new HumanConfirmationError(
                        humanConfirmationMessage(
                            'Creating a full-access session',
                            CONFIRM_FULL_ACCESS_PHRASE,
                        ),
                    )
                }
            }
        }

        const expiryTimestamp = options.expiry ? parseExpiry(options.expiry) : 0

        if (swapInstall) {
            try {
                const readers = chainStandingRightsReaders({
                    network: signedNetwork,
                    owner: accountAddress,
                })

                await assertNoStandingRights({
                    chainId: network.chainId,
                    owner: accountAddress,
                    targets: relayStandingTargets(network.chainId),
                    tokens: knownErc20Tokens(network.chainId),
                    keyHash: sessionKeyHash,
                    registry: deps.standingRightsRegistry,
                    readers: {
                        readErc20Allowance: (token, spender) =>
                            deps.readErc20Allowance({
                                network: signedNetwork,
                                owner: accountAddress,
                                token,
                                spender,
                            }),
                        readPermit2Allowance: (token, spender) =>
                            deps.readPermit2Allowance({
                                network: signedNetwork,
                                owner: accountAddress,
                                token,
                                spender,
                            }),
                        readErc721ApprovedForAll:
                            deps.readErc721ApprovedForAll ??
                            ((token, operator) => readers.readErc721ApprovedForAll(token, operator)),
                        readErc721GetApproved:
                            deps.readErc721GetApproved ??
                            ((token, tokenId) => readers.readErc721GetApproved(token, tokenId)),
                        readErc1155ApprovedForAll:
                            deps.readErc1155ApprovedForAll ??
                            ((token, operator) =>
                                readers.readErc1155ApprovedForAll(token, operator)),
                        readErc4626ShareBalance:
                            deps.readErc4626ShareBalance ??
                            ((vault) => readers.readErc4626ShareBalance(vault)),
                        readErc4626ShareAllowance:
                            deps.readErc4626ShareAllowance ??
                            ((vault, spender) =>
                                readers.readErc4626ShareAllowance(vault, spender)),
                        readApprovedSignatureCheckers:
                            deps.readApprovedSignatureCheckers ??
                            ((keyHash) => readers.readApprovedSignatureCheckers(keyHash)),
                    },
                })
            } catch (error) {
                if (error instanceof StandingRightsRejected) {
                    throw new SessionCreateError('SESSION_CREATE_FAILED', error.message, {
                        cause: error,
                    })
                }

                throw new SessionCreateError(
                    'SESSION_CREATE_FAILED',
                    'Could not read standing rights. Refusing to sign.',
                    { cause: error },
                )
            }
        }

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

        if (swapInstall) {
            calls.push(...swapInstall.calls)
        } else if (permissionDefaults) {
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
                        expiry: input.expiry,
                        payer: input.payer,
                        paymentToken: input.paymentToken,
                        paymentMaxAmount: input.paymentMaxAmount,
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
                rpcUrl: signedNetwork.rpcUrl,
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
            swap: swapResult,
            bundle: {
                id: submission.id,
                status: finalStatus.status ?? 'unknown',
                statusCode,
            },
            txHash: finalStatus.receipt?.transactionHash,
            feeCap: submission.feeCap,
        }
    })
}
