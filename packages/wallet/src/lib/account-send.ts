import { dirname, join } from 'node:path'
import {
    createPublicClient,
    encodeFunctionData,
    erc20Abi,
    getAddress,
    http,
    parseUnits,
    type Address,
    type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
    computeKeyHash,
    decodeIntentError,
    encodeSecp256k1Key,
    getChain,
    waitForBundle as waitForBundleAction,
    type BundleStatusResponse,
    type Call,
    type PrepareCallsResponse,
} from '@nubl/relayer-client'
import { AccountCreateError, resolveKeystorePath } from './account-create'
import {
    decryptSessionKeystore,
    isAgentKeystore,
    LoginProfileError,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    SessionOnlyProfileError,
    type LoginSessionKeystoreV2,
    type RelayerSessionKeystoreV2,
} from './keystore'
import {
    getUsdcTokenConfig,
    resolveNetworkConfig,
    selectDefaultChain,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
    type UsdcSymbol,
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
import { isMissingFileError } from './fs-utils'
import { hasLegacyRecipientAlias } from './legacy-recipient-aliases'
import { RecipientResolutionError, resolveAddressOrEnsInput } from './recipient-resolver'
import { parseSessionName } from './session-common'
import { resolveSessionSigner, SessionSignerDaemonError, SessionSignerExpiredError } from './signer'
import type { ResolvedSessionSigner } from './signer'

type AccountSendErrorCode =
    | 'PASSWORD_REQUIRED'
    | 'INVALID_NAME'
    | 'INVALID_ARGUMENT'
    | 'KEYSTORE_NOT_FOUND'
    | 'UNSUPPORTED_CHAIN'
    | 'INVALID_AMOUNT'
    | 'INVALID_RECIPIENT'
    | 'RECIPIENT_UNRESOLVED'
    | 'MISSING_ARGUMENT'
    | 'SEND_FAILED'
    | 'INTENT_REVERTED'
    | 'SIMULATION_FAILED'
    | 'BUNDLE_TIMEOUT'
    | 'SESSION_EXPIRED'
    | 'UNKNOWN'

type NetworkConfig = CliNetworkConfig

export class AccountSendError extends Error {
    code: AccountSendErrorCode
    cause?: unknown
    details?: unknown

    constructor(
        code: AccountSendErrorCode,
        message: string,
        options?: { cause?: unknown; details?: unknown },
    ) {
        super(message)
        this.name = 'AccountSendError'
        this.code = code
        this.cause = options?.cause
        this.details = options?.details
    }
}

export type AccountSendArgs = {
    env: EnvName
    amount?: string
    recipient?: string
    chain: ChainName
    legacy: boolean
    keystorePath?: string
    name?: string
    passwordStdin: boolean
    json: boolean
    help: boolean
}

export type AccountSendOptions = {
    env: EnvName
    amount: string
    recipient: string
    chain?: ChainName
    legacy?: boolean
    keystorePath?: string
    sessionFile?: string
    sessionName?: string
    name?: string
    password?: string
    resolvePassword?: () => Promise<string>
}

export type AccountSendResult = {
    type: 'account_send'
    status: 'complete'
    keystorePath: string
    network: NetworkConfig
    chain: ChainName
    sender: Address
    recipient: {
        input: string
        resolved: Address
    }
    token: {
        symbol: UsdcSymbol
        address: Address
        amount: string
        amountBaseUnits: string
    }
    bundle: {
        id: string
        status: string
        statusCode: number
    }
    signerMode: 'daemon' | 'direct' | 'fallback_direct'
    txHash?: Hex
    feeCap: ExecuteSignedCallsResult['feeCap']
}

export type AccountSendDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    decryptSessionKeystore: typeof decryptSessionKeystore
    readNonce: (input: { network: NetworkConfig; account: Address }) => Promise<bigint>
    resolveAddressOrEnsInput: typeof resolveAddressOrEnsInput
    hasLegacyRecipientAlias: typeof hasLegacyRecipientAlias
    prepareCalls: (input: {
        network: NetworkConfig
        from: Address
        calls: Call[]
        sessionKey?: Hex
        nonce: bigint
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
        network: NetworkConfig
        context: PrepareCallsResponse['context']
        signature: Hex
    }) => Promise<{ id: string }>
    waitForBundle: (input: { network: NetworkConfig; id: string }) => Promise<BundleStatusResponse>
    executeSignedCalls: (
        deps: ExecuteSignedCallsDeps,
        params: ExecuteSignedCallsParams,
    ) => Promise<ExecuteSignedCallsResult>
}

function normalizeChain(value?: string): ChainName {
    try {
        return selectDefaultChain('prod', value)
    } catch (error) {
        const message = error instanceof Error ? error.message : `Unsupported chain: ${value}`
        throw new AccountSendError('UNSUPPORTED_CHAIN', message, { cause: error })
    }
}

function assertSessionNetworkMatches(input: {
    sessionEnv: string
    sessionChainId: number
    expectedEnv: EnvName
    expectedChainId: number
}): void {
    if (input.sessionEnv !== input.expectedEnv) {
        throw new AccountSendError(
            'UNSUPPORTED_CHAIN',
            `Session file env mismatch: expected ${input.expectedEnv}, got ${input.sessionEnv}.`,
        )
    }

    if (input.sessionChainId !== input.expectedChainId) {
        throw new AccountSendError(
            'UNSUPPORTED_CHAIN',
            `Session file chain mismatch: expected ${input.expectedChainId}, got ${input.sessionChainId}.`,
        )
    }
}

type ParsedUsdcAmount = { normalized: string; baseUnits: bigint }

function parseUsdcAmount(value: string): ParsedUsdcAmount {
    const amount = value.trim()

    if (!/^\d+(\.\d+)?$/.test(amount)) {
        throw new AccountSendError('INVALID_AMOUNT', 'Amount must be a positive decimal number.')
    }

    const fractional = amount.split('.')[1] ?? ''

    if (fractional.length > 6) {
        throw new AccountSendError(
            'INVALID_AMOUNT',
            'Amount supports at most 6 decimal places for USDC.',
        )
    }

    let parsed: bigint

    try {
        parsed = parseUnits(amount, 6)
    } catch (error) {
        throw new AccountSendError('INVALID_AMOUNT', 'Amount is invalid or too large.', {
            cause: error,
        })
    }

    if (parsed <= 0n) {
        throw new AccountSendError('INVALID_AMOUNT', 'Amount must be greater than zero.')
    }

    return {
        normalized: amount,
        baseUnits: parsed,
    }
}

async function resolveRecipient(
    recipient: string,
    chain: ChainName,
    deps: Pick<AccountSendDeps, 'resolveAddressOrEnsInput' | 'hasLegacyRecipientAlias'>,
): Promise<Address> {
    try {
        const resolution = await deps.resolveAddressOrEnsInput(recipient, chain)

        return resolution.address
    } catch (error) {
        if (
            error instanceof RecipientResolutionError &&
            error.code === 'INVALID_RECIPIENT' &&
            (await deps.hasLegacyRecipientAlias(recipient))
        ) {
            throw new AccountSendError(
                'INVALID_RECIPIENT',
                `Contact aliases are no longer supported. Use the address or .eth ENS name for "${recipient.trim()}".`,
                {
                    cause: error,
                    details: { legacyAlias: recipient.trim().toLowerCase() },
                },
            )
        }

        throw error
    }
}

function getDefaultDeps(): AccountSendDeps {
    return {
        readKeystoreBundle,
        readSessionKeystoreFile,
        decryptSessionKeystore,
        resolveAddressOrEnsInput,
        hasLegacyRecipientAlias,
        readNonce: async ({ network, account }) => {
            const client = createPublicClient({
                chain: getChain(network.chainId, network.rpcUrl),
                transport: http(network.rpcUrl),
            })

            return readAccountNonce(client, account)
        },
        prepareCalls: async (input) => {
            const client = createCliRelayerClient(input.network)

            return client.prepareCalls({
                from: input.from,
                chainId: input.network.chainId,
                calls: input.calls,
                sessionKey: input.sessionKey,
                nonce: input.nonce,
                expiry: input.expiry,
                payer: input.payer,
                paymentToken: input.paymentToken,
                paymentMaxAmount: input.paymentMaxAmount,
            })
        },
        signTypedData: async (input) => {
            const signer = privateKeyToAccount(input.privateKey)

            return signer.signTypedData(input.typedData)
        },
        sendPreparedCalls: async (input) => {
            const client = createCliRelayerClient(input.network)

            return client.sendPreparedCalls({
                context: input.context,
                signature: input.signature,
            })
        },
        waitForBundle: async (input) => {
            const client = createCliRelayerClient(input.network)

            return waitForBundleAction(client, { id: input.id, chainId: input.network.chainId })
        },
        executeSignedCalls,
    }
}

export async function resolveAccountSendPassword(
    args: AccountSendArgs,
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

    throw new AccountSendError(
        'PASSWORD_REQUIRED',
        'Password required. Use --password-stdin, TW_PASSWORD, RELAYER_CLI_PASSWORD, or run in interactive TTY.',
    )
}

export async function executeAccountSend(
    options: AccountSendOptions,
    depsArg?: Partial<AccountSendDeps>,
): Promise<AccountSendResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const chain = options.chain ? normalizeChain(options.chain) : selectDefaultChain(options.env)
    const network = resolveNetworkConfig(options.env, chain)
    const token = getUsdcTokenConfig(chain, { legacy: options.legacy })

    const keystorePath =
        options.sessionFile ??
        resolveKeystorePath({
            env: options.env,
            keystorePath: options.keystorePath,
            name: options.name,
        })

    let cachedPassword = options.password

    const resolvePassword = async (): Promise<string> => {
        if (cachedPassword) {
            return cachedPassword
        }

        if (options.resolvePassword) {
            cachedPassword = await options.resolvePassword()

            return cachedPassword
        }

        throw new AccountSendError(
            'PASSWORD_REQUIRED',
            'Password required. Use --password-stdin, TW_PASSWORD, RELAYER_CLI_PASSWORD, or run in interactive TTY.',
        )
    }

    try {
        if (!options.amount || !options.recipient) {
            throw new AccountSendError(
                'MISSING_ARGUMENT',
                'Usage requires <amount> and <recipient>. Run tw send --help.',
            )
        }

        if (options.sessionFile && options.sessionName) {
            throw new AccountSendError(
                'INVALID_ARGUMENT',
                '--session and --session-file are mutually exclusive.',
            )
        }

        const selectedSessionName = options.sessionName
            ? parseSessionName(options.sessionName)
            : undefined

        const parsedAmount = parseUsdcAmount(options.amount)
        let sessionKeystore: RelayerSessionKeystoreV2 | LoginSessionKeystoreV2
        let sender: Address
        let effectiveNetwork = network

        if (options.sessionFile) {
            const loadedSessionKeystore = await deps.readSessionKeystoreFile(options.sessionFile)

            if (isAgentKeystore(loadedSessionKeystore)) {
                throw new AccountSendError(
                    'INVALID_ARGUMENT',
                    'Agent session keystores are not supported for send. Use a relayer or login session.',
                )
            }

            sessionKeystore = loadedSessionKeystore
            assertSessionNetworkMatches({
                sessionEnv: sessionKeystore.network.env,
                sessionChainId: sessionKeystore.network.chainId,
                expectedEnv: options.env,
                expectedChainId: network.chainId,
            })
            effectiveNetwork = sessionKeystore.network as CliNetworkConfig
            sender = getAddress(sessionKeystore.addresses.delegated)
        } else if (selectedSessionName) {
            let bundle: Awaited<ReturnType<typeof deps.readKeystoreBundle>>

            try {
                bundle = await deps.readKeystoreBundle(keystorePath)
            } catch (error) {
                throw new AccountSendError(
                    'INVALID_ARGUMENT',
                    '--session requires a root profile keystore with local sessions. Use --session-file for portable session profiles.',
                    { cause: error },
                )
            }

            const selectedSessionPath = resolveSessionKeystorePath(
                keystorePath,
                selectedSessionName,
                bundle.root.sessionRef.dir,
            )

            try {
                const loadedSessionKeystore =
                    await deps.readSessionKeystoreFile(selectedSessionPath)

                if (isAgentKeystore(loadedSessionKeystore)) {
                    throw new AccountSendError(
                        'INVALID_ARGUMENT',
                        'Agent session keystores are not supported for send. Use a relayer or login session.',
                    )
                }

                sessionKeystore = loadedSessionKeystore
            } catch (error) {
                if (error instanceof AccountSendError) throw error
                const detail = error instanceof Error ? error.message : String(error)
                throw new AccountSendError(
                    'INVALID_ARGUMENT',
                    `Could not load session "${selectedSessionName}" at ${selectedSessionPath}: ${detail}`,
                    { cause: error },
                )
            }

            sender = getAddress(bundle.root.addresses.delegated ?? bundle.root.addresses.root)
        } else {
            try {
                const bundle = await deps.readKeystoreBundle(keystorePath)

                if (isAgentKeystore(bundle.session)) {
                    throw new AccountSendError(
                        'INVALID_ARGUMENT',
                        'Agent session keystores are not supported for send. Use a relayer or login session.',
                    )
                }

                sessionKeystore = bundle.session
                sender = getAddress(bundle.root.addresses.delegated ?? bundle.root.addresses.root)
            } catch (error) {
                if (
                    !isMissingFileError(error) &&
                    !(error instanceof SessionOnlyProfileError) &&
                    !(error instanceof LoginProfileError)
                ) {
                    throw error
                }

                const sessionProfilePath = join(dirname(keystorePath), 'session.json')

                try {
                    const loadedSessionKeystore =
                        await deps.readSessionKeystoreFile(sessionProfilePath)

                    if (isAgentKeystore(loadedSessionKeystore)) {
                        throw new AccountSendError(
                            'INVALID_ARGUMENT',
                            'Agent session keystores are not supported for send. Use a relayer or login session.',
                        )
                    }

                    sessionKeystore = loadedSessionKeystore
                    assertSessionNetworkMatches({
                        sessionEnv: sessionKeystore.network.env,
                        sessionChainId: sessionKeystore.network.chainId,
                        expectedEnv: options.env,
                        expectedChainId: network.chainId,
                    })
                    sender = getAddress(sessionKeystore.addresses.delegated)
                    effectiveNetwork = sessionKeystore.network as CliNetworkConfig
                } catch (fallbackError) {
                    if (isMissingFileError(fallbackError)) {
                        throw error
                    }

                    throw fallbackError
                }
            }
        }

        const recipient = await resolveRecipient(options.recipient, chain, deps)

        const resolvedSigner = await resolveSessionSigner({
            sessionName: sessionKeystore.name ?? selectedSessionName ?? 'default',
            sessionKeystore,
            chainId: effectiveNetwork.chainId,
            decryptSessionKeystore: deps.decryptSessionKeystore,
            resolvePassword,
            directSignTypedData: deps.signTypedData,
        })

        const signedNetwork = {
            ...effectiveNetwork,
            authSigner: resolvedSigner.authSigner,
        }

        const calls: Call[] = [
            {
                target: token.address,
                value: 0n,
                data: encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'transfer',
                    args: [recipient, parsedAmount.baseUnits],
                }),
            },
        ]

        const nonce = await deps.readNonce({
            network: signedNetwork,
            account: sender,
        })

        const sessionPublicKey = encodeSecp256k1Key(sessionKeystore.addresses.session as Address)
        const sessionKeyHash = computeKeyHash('secp256k1', sessionPublicKey)

        function runWithSigner(
            network: typeof signedNetwork,
            signer: Pick<ResolvedSessionSigner, 'signTypedData' | 'signerPrivateKey'>,
        ) {
            return deps.executeSignedCalls(
                {
                    prepareCalls: async (input) =>
                        deps.prepareCalls({
                            network,
                            from: input.from,
                            calls: input.calls,
                            sessionKey: input.sessionKey,
                            nonce: input.nonce,
                            expiry: input.expiry,
                            payer: input.payer,
                            paymentToken: input.paymentToken,
                            paymentMaxAmount: input.paymentMaxAmount,
                        }),
                    signTypedData: signer.signTypedData,
                    sendPreparedCalls: async (input) =>
                        deps.sendPreparedCalls({
                            network,
                            context: input.context,
                            signature: input.signature,
                        }),
                    waitForBundle: async (input) => deps.waitForBundle({ network, id: input.id }),
                },
                {
                    from: sender,
                    calls,
                    nonce,
                    sessionKey: sessionPublicKey,
                    signerPrivateKey: signer.signerPrivateKey,
                    signerKeyHash: sessionKeyHash,
                    chainId: network.chainId,
                    env: network.env,
                    rpcUrl: network.rpcUrl,
                },
            )
        }

        let submission: Awaited<ReturnType<typeof deps.executeSignedCalls>>

        let signerMode: AccountSendResult['signerMode'] =
            resolvedSigner.mode === 'daemon' ? 'daemon' : 'direct'

        try {
            submission = await runWithSigner(signedNetwork, resolvedSigner)
        } catch (error) {
            if (error instanceof SessionSignerExpiredError) {
                throw new AccountSendError('SESSION_EXPIRED', error.message, { cause: error })
            }

            if (!(error instanceof SessionSignerDaemonError) || resolvedSigner.mode !== 'daemon') {
                throw error
            }

            const fallback = await deps.decryptSessionKeystore(
                sessionKeystore,
                await resolvePassword(),
            )

            const fallbackNetwork = {
                ...signedNetwork,
                authSigner: createEthHttpSigner(
                    fallback.sessionPrivateKey,
                    effectiveNetwork.chainId,
                ),
            }

            signerMode = 'fallback_direct'
            debugSignerFallback('account_send', {
                reason: error.message,
                sessionName: sessionKeystore.name ?? selectedSessionName ?? 'default',
            })
            submission = await runWithSigner(fallbackNetwork, {
                signTypedData: deps.signTypedData,
                signerPrivateKey: fallback.sessionPrivateKey,
            })
        }

        const finalStatus = submission.finalStatus

        if (!finalStatus.success) {
            throw new AccountSendError(
                'SEND_FAILED',
                finalStatus.error ?? 'Relayer send did not complete successfully.',
                {
                    details: {
                        statusCode: finalStatus.statusCode,
                        txHash: finalStatus.receipt?.transactionHash,
                    },
                },
            )
        }

        const statusCode = finalStatus.statusCode ?? 0
        const intentError = finalStatus.receipt?.intentError as Hex | undefined
        const intentErrorName = intentError ? decodeIntentError(intentError) : undefined

        if (![200, 201].includes(statusCode)) {
            const code: AccountSendErrorCode =
                statusCode === 400 || statusCode === 500 ? 'INTENT_REVERTED' : 'SEND_FAILED'

            throw new AccountSendError(
                code,
                `Bundle ended in status ${statusCode} (${finalStatus.status ?? 'unknown'}).`,
                {
                    details: {
                        statusCode,
                        txHash: finalStatus.receipt?.transactionHash,
                        intentError,
                        intentErrorName,
                    },
                },
            )
        }

        return {
            type: 'account_send',
            status: 'complete',
            keystorePath,
            network: effectiveNetwork,
            chain,
            sender,
            recipient: {
                input: options.recipient,
                resolved: recipient,
            },
            token: {
                symbol: token.symbol,
                address: token.address,
                amount: parsedAmount.normalized,
                amountBaseUnits: parsedAmount.baseUnits.toString(),
            },
            bundle: {
                id: submission.id,
                status: finalStatus.status ?? 'unknown',
                statusCode,
            },
            signerMode,
            txHash: finalStatus.receipt?.transactionHash,
            feeCap: submission.feeCap,
        }
    } catch (error) {
        throw toAccountSendError(error, { keystorePath })
    }
}

function debugSignerFallback(
    command: 'account_send',
    details: { reason: string; sessionName: string },
): void {
    if (process.env.TW_DAEMON_DEBUG !== '1') {
        return
    }

    console.error(`[tw ${command}] daemon signer fallback ${JSON.stringify(details)}`)
}

function toAccountSendError(error: unknown, context: { keystorePath: string }): AccountSendError {
    if (error instanceof AccountSendError) {
        return error
    }

    if (error instanceof AccountCreateError && error.code === 'INVALID_NAME') {
        return new AccountSendError('INVALID_NAME', error.message, { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)

    if (message.includes('Unsupported chain')) {
        return new AccountSendError('UNSUPPORTED_CHAIN', message, { cause: error })
    }

    if (message.includes('Usage requires <amount> and <recipient>')) {
        return new AccountSendError('MISSING_ARGUMENT', message, { cause: error })
    }

    if (message.toLowerCase().includes('simulation failed')) {
        return new AccountSendError('SIMULATION_FAILED', message, { cause: error })
    }

    if (message.toLowerCase().includes('timeout waiting for bundle')) {
        return new AccountSendError('BUNDLE_TIMEOUT', message, { cause: error })
    }

    if (message.includes('ENOENT') || message.toLowerCase().includes('no such file')) {
        return new AccountSendError(
            'KEYSTORE_NOT_FOUND',
            `Keystore not found at ${context.keystorePath}`,
            {
                cause: error,
            },
        )
    }

    if (
        message.includes('No password provided on stdin') ||
        message.includes('Password required') ||
        message.includes('Password cannot be empty') ||
        message.includes('Password input cancelled')
    ) {
        return new AccountSendError('PASSWORD_REQUIRED', message, { cause: error })
    }

    if (message.includes('Could not resolve ENS')) {
        return new AccountSendError('RECIPIENT_UNRESOLVED', message, { cause: error })
    }

    if (
        message.includes('Recipient must be a valid address') ||
        message.includes('Recipient cannot be empty.')
    ) {
        return new AccountSendError('INVALID_RECIPIENT', message, { cause: error })
    }

    if (message.includes('Amount')) {
        return new AccountSendError('INVALID_AMOUNT', message, { cause: error })
    }

    return new AccountSendError('UNKNOWN', message, { cause: error })
}
