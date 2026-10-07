import { dirname, join } from 'node:path'
import {
    createPublicClient,
    erc20Abi,
    formatUnits,
    getAddress,
    http,
    isAddress,
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
    getKeys as getKeysAction,
    JsonRpcClientError,
    type GetKeysResponse,
    waitForBundle as waitForBundleAction,
    type BundleStatusResponse,
    type Call,
    type PrepareCallsResponse,
} from '@nubl/relayer-client'
import { AccountCreateError, resolveKeystorePath } from './account-create'
import { executeSignedCalls, type ExecuteSignedCallsDeps } from './execute-calls'
import {
    LoginProfileError,
    SessionOnlyProfileError,
    decryptSessionKeystore,
    isAgentKeystore,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    type LoginSessionKeystoreV2,
    type RelayerSessionKeystoreV2,
} from './keystore'
import { isMissingFileError } from './fs-utils'
import { PromptCancelledError } from './password-readline'
import {
    createCliRelayerClient,
    createEthHttpSigner,
    readAccountNonce,
} from './relayer-client-utils'
import {
    extractRequestId,
    getQuote,
    getRelayIntentStatusUrl,
    pollIntentStatus,
    RelayLinkError,
    slippagePercentToBps,
    sumQuoteFeeUsd,
    stepsToRelayerCalls,
    type RelayIntentStatus,
    type RelayQuoteResponse,
} from './relay-link'
import {
    quoteExecutionFingerprint,
    RelayQuoteRejected,
    reviewRelayQuote,
    type RelayQuoteReview,
} from './relay-allowlist'
import { RelaySimulationRejected, simulateRelayQuote, type SimulatedWatch } from './relay-simulate'
import {
    ETH_ADDRESS,
    getChainConfig,
    getChainNameByChainId,
    getTokenAddress,
    getUsdcAddressByChainId,
    getTokenDecimals,
    normalizeTokenSymbol,
    resolveNetworkConfig,
    selectDefaultChain,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
    type TokenSymbol,
} from './network-config'
import { getChainKeys, parseSessionName } from './session-common'
import { isRecord } from './type-guards'
import { resolveSessionSigner, SessionSignerDaemonError, SessionSignerExpiredError } from './signer'
import type { ResolvedSessionSigner } from './signer'

const QUOTE_STALE_MS = 30_000
const DEFAULT_SLIPPAGE_PERCENT = 0.5
const MAX_CONFIRMATION_ATTEMPTS = 3

type NetworkConfig = CliNetworkConfig

export type AccountSwapErrorCode =
    | 'PASSWORD_REQUIRED'
    | 'KEYSTORE_NOT_FOUND'
    | 'UNSUPPORTED_CHAIN'
    | 'UNSUPPORTED_TOKEN'
    | 'INVALID_AMOUNT'
    | 'INVALID_TOKEN_PAIR'
    | 'SAME_CHAIN'
    | 'MISSING_NATIVE_SPEND_PERMISSION'
    | 'QUOTE_FAILED'
    | 'SWAP_FAILED'
    | 'INTENT_REVERTED'
    | 'CONFIRMATION_REQUIRED'
    | 'SIMULATION_FAILED'
    | 'BUNDLE_TIMEOUT'
    | 'BRIDGE_QUOTE_INVALID'
    | 'BRIDGE_FILL_TIMEOUT'
    | 'BRIDGE_FILL_FAILED'
    | 'SESSION_EXPIRED'
    | 'UNKNOWN'

export class AccountSwapError extends Error {
    code: AccountSwapErrorCode
    cause?: unknown
    details?: unknown

    constructor(
        code: AccountSwapErrorCode,
        message: string,
        options?: { cause?: unknown; details?: unknown },
    ) {
        super(message)
        this.name = 'AccountSwapError'
        this.code = code
        this.cause = options?.cause
        this.details = options?.details
    }
}

export type AccountSwapArgs = {
    env: EnvName
    passwordStdin: boolean
}

export type AccountSwapOptions = {
    operation?: 'swap' | 'bridge'
    env: EnvName
    fromToken: string
    toToken: string
    amount: string
    slippage?: number
    sourceChain?: ChainName
    destinationChain?: ChainName
    recipient?: string | Address
    keystorePath?: string
    sessionFile?: string
    sessionName?: string
    name?: string
    password?: string
    resolvePassword?: () => Promise<string>
    yes?: boolean
}

export type AccountSwapResult = {
    type: 'account_swap' | 'account_bridge'
    status: 'complete'
    keystorePath: string
    network: CliNetworkConfig
    sourceChain: ChainName
    destinationChain: ChainName
    sender: Address
    recipient: Address
    fromToken: {
        symbol: TokenSymbol
        address: Address
        amount: string
        amountBaseUnits: string
    }
    toToken: {
        symbol: TokenSymbol
        address: Address
        estimatedAmount: string
    }
    rate: string
    totalFeesUsd: string
    slippage: string
    bundle: { id: string; status: string; statusCode?: number }
    signerMode: 'daemon' | 'direct' | 'fallback_direct'
    txHash?: Hex
    destinationTxHash?: Hex
    relayRequestId?: string
}

type AccountSwapDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    decryptSessionKeystore: typeof decryptSessionKeystore
    readNonce: (input: { network: NetworkConfig; account: Address }) => Promise<bigint>
    readTokenBalance: (input: {
        chain: ChainName
        token: TokenSymbol
        account: Address
    }) => Promise<bigint>
    getQuote: typeof getQuote
    pollIntentStatus: typeof pollIntentStatus
    getKeys: (input: {
        network: NetworkConfig
        account: Address
        chainId: number
    }) => Promise<GetKeysResponse>
    prepareCalls: (input: {
        network: NetworkConfig
        from: Address
        calls: Call[]
        sessionKey?: Hex
        nonce: bigint
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
        params: {
            from: Address
            calls: Call[]
            nonce: bigint
            sessionKey?: Hex
            signerPrivateKey: Hex
            signerKeyHash?: Hex
        },
    ) => Promise<{ id: string; finalStatus: BundleStatusResponse }>
    confirmQuote: (quote: RelayQuoteResponse) => Promise<boolean>
    auditQuote: (quote: RelayQuoteResponse) => void
    simulateQuoteCalls: (input: Parameters<typeof simulateRelayQuote>[0]) => Promise<void>
}

function normalizeChain(value: string | undefined, env: EnvName): ChainName {
    try {
        return selectDefaultChain(env, value)
    } catch (error) {
        const message = error instanceof Error ? error.message : `Unsupported chain: ${value}`
        throw new AccountSwapError('UNSUPPORTED_CHAIN', message, { cause: error })
    }
}

function assertSessionNetworkMatches(input: {
    sessionEnv: string
    sessionChainId: number
    expectedEnv: EnvName
    expectedChainId: number
}): void {
    if (input.sessionEnv !== input.expectedEnv) {
        throw new AccountSwapError(
            'UNSUPPORTED_CHAIN',
            `Session file env mismatch: expected ${input.expectedEnv}, got ${input.sessionEnv}.`,
        )
    }
    if (input.sessionChainId !== input.expectedChainId) {
        throw new AccountSwapError(
            'UNSUPPORTED_CHAIN',
            `Session file chain mismatch: expected ${input.expectedChainId}, got ${input.sessionChainId}.`,
        )
    }
}

function parseTokenAmount(
    token: TokenSymbol,
    value: string,
): { normalized: string; baseUnits: bigint } {
    const amount = value.trim()
    if (!/^\d+(\.\d+)?$/.test(amount)) {
        throw new AccountSwapError('INVALID_AMOUNT', 'Amount must be a positive decimal number.')
    }

    const decimals = getTokenDecimals(token)
    const fractional = amount.split('.')[1] ?? ''
    if (fractional.length > decimals) {
        throw new AccountSwapError(
            'INVALID_AMOUNT',
            `Amount supports at most ${decimals} decimal places for ${token}.`,
        )
    }

    let parsed: bigint
    try {
        parsed = parseUnits(amount, decimals)
    } catch (error) {
        throw new AccountSwapError('INVALID_AMOUNT', 'Amount is invalid or too large.', {
            cause: error,
        })
    }

    if (parsed <= 0n) {
        throw new AccountSwapError('INVALID_AMOUNT', 'Amount must be greater than zero.')
    }

    return { normalized: amount, baseUnits: parsed }
}

function parseRecipient(value: string | Address | undefined): Address | undefined {
    if (!value) {
        return undefined
    }
    if (!isAddress(value)) {
        throw new AccountSwapError('UNKNOWN', `Recipient must be a valid address, got ${value}.`)
    }
    return getAddress(value)
}

function getEstimatedOutputAmount(quote: RelayQuoteResponse): string {
    const formatted = quote.details?.currencyOut?.amountFormatted
    if (formatted) {
        return formatted
    }
    const raw = quote.details?.currencyOut?.amount
    if (raw) {
        return raw
    }
    return '0'
}

function quoteNeedsReconfirmation(previous: RelayQuoteResponse, next: RelayQuoteResponse): boolean {
    if (quoteExecutionFingerprint(previous) !== quoteExecutionFingerprint(next)) return true
    return hasMaterialQuoteDrift(previous, next)
}

function hasMaterialQuoteDrift(previous: RelayQuoteResponse, next: RelayQuoteResponse): boolean {
    const previousOut = Number(previous.details?.currencyOut?.amountUsd ?? NaN)
    const nextOut = Number(next.details?.currencyOut?.amountUsd ?? NaN)
    if (Number.isFinite(previousOut) && previousOut > 0 && Number.isFinite(nextOut)) {
        return Math.abs(nextOut - previousOut) / previousOut > 0.01
    }

    const previousRate = Number(previous.details?.rate ?? NaN)
    const nextRate = Number(next.details?.rate ?? NaN)
    if (Number.isFinite(previousRate) && previousRate > 0 && Number.isFinite(nextRate)) {
        return Math.abs(nextRate - previousRate) / previousRate > 0.01
    }

    return false
}

function getQuoteChainMismatch(
    quote: RelayQuoteResponse,
    sourceChainId: number,
): number | undefined {
    for (const step of quote.steps) {
        if (step.kind !== 'transaction') continue
        for (const item of step.items) {
            if (item.status !== 'incomplete') continue
            if (item.data.chainId !== sourceChainId) {
                return item.data.chainId
            }
        }
    }
    return undefined
}

function quoteWatches(input: {
    origin: Address
    originIsNative: boolean
    output: Address
    outputIsNative: boolean
    sameChain: boolean
    chainId: number
    extraTokens: Address[]
}): SimulatedWatch[] {
    const watches: SimulatedWatch[] = [
        {
            kind: 'native',
            role: input.originIsNative
                ? 'origin'
                : input.sameChain && input.outputIsNative
                  ? 'output'
                  : 'other',
        },
    ]
    if (!input.originIsNative) {
        watches.push({ kind: 'erc20', token: getAddress(input.origin), role: 'origin' })
    }
    if (input.sameChain && !input.outputIsNative) {
        watches.push({ kind: 'erc20', token: getAddress(input.output), role: 'output' })
    }
    const usdc = getUsdcAddressByChainId(input.chainId)
    if (usdc) watches.push({ kind: 'erc20', token: usdc, role: 'other' })
    const legacyUsdc = getUsdcAddressByChainId(input.chainId, true)
    if (legacyUsdc && legacyUsdc.toLowerCase() !== usdc?.toLowerCase()) {
        watches.push({ kind: 'erc20', token: legacyUsdc, role: 'other' })
    }
    for (const token of input.extraTokens) {
        watches.push({ kind: 'erc20', token, role: 'other' })
    }
    return watches
}

function quotedMinimumOutput(quote: RelayQuoteResponse): bigint | undefined {
    const raw = quote.details?.currencyOut?.minimumAmount ?? quote.details?.currencyOut?.amount
    if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return BigInt(raw)
    return undefined
}

function validateQuoteForExecution(
    quote: RelayQuoteResponse,
    sourceChainId: number,
    limits: {
        amount: bigint
        native: boolean
        originCurrency: Address
        user: Address
        recipient: Address
    },
): RelayQuoteReview {
    if (quote.steps.length === 0) {
        throw new AccountSwapError('QUOTE_FAILED', 'relay.link returned no executable steps.')
    }
    if (quote.steps.some((step) => step.kind === 'signature')) {
        throw new AccountSwapError(
            'QUOTE_FAILED',
            'relay.link returned signature steps, which are not supported by this command.',
        )
    }

    const mismatchedChainId = getQuoteChainMismatch(quote, sourceChainId)
    if (mismatchedChainId !== undefined) {
        const chainLabel = getChainNameByChainId(sourceChainId) ?? String(sourceChainId)
        throw new AccountSwapError(
            'QUOTE_FAILED',
            `relay.link returned a step for chain ${mismatchedChainId}, expected source chain ${chainLabel} (${sourceChainId}).`,
        )
    }

    try {
        return reviewRelayQuote(quote, {
            sourceChainId,
            inputAmount: limits.amount,
            inputIsNative: limits.native,
            originCurrency: limits.originCurrency,
            user: limits.user,
            recipient: limits.recipient,
        })
    } catch (error) {
        if (error instanceof RelayQuoteRejected) {
            throw new AccountSwapError('QUOTE_FAILED', error.message, { cause: error })
        }
        throw error
    }
}

function extractSimulationCause(value: unknown): string | undefined {
    if (!isRecord(value)) {
        return undefined
    }
    const cause = value.cause
    if (typeof cause !== 'string') {
        return undefined
    }
    const trimmed = cause.trim()
    if (trimmed.length === 0 || trimmed === 'Simulation failed') {
        return undefined
    }
    return trimmed
}

function extractAuthCode(value: unknown): string | undefined {
    if (!isRecord(value)) {
        return undefined
    }
    const authCode = value.auth_code
    return typeof authCode === 'string' && authCode.length > 0 ? authCode : undefined
}

function assertEthSpendPermission(input: {
    keys: GetKeysResponse
    chainId: number
    sessionKeyHash: Hex
    amount: bigint
    sourceChain: ChainName
}): void {
    const sessionKey = getChainKeys(input.keys, input.chainId).find(
        (key) => key.hash.toLowerCase() === input.sessionKeyHash.toLowerCase(),
    )
    const nativeSpend = sessionKey?.permissions.find(
        (permission) =>
            permission.type === 'spend' &&
            permission.token.toLowerCase() === ETH_ADDRESS.toLowerCase(),
    )

    if (!nativeSpend || nativeSpend.type !== 'spend') {
        throw new AccountSwapError(
            'MISSING_NATIVE_SPEND_PERMISSION',
            `Session key is missing native ETH spend permission on ${input.sourceChain}. Grant spend permission for ${ETH_ADDRESS} before swapping from ETH.`,
        )
    }

    const limit = BigInt(nativeSpend.limit)
    const spent = BigInt(nativeSpend.spent)
    if (limit - spent < input.amount) {
        throw new AccountSwapError(
            'MISSING_NATIVE_SPEND_PERMISSION',
            `Session key native ETH spend permission on ${input.sourceChain} has insufficient remaining limit for ${formatUnits(input.amount, 18)} ETH.`,
        )
    }
}

function getDefaultDeps(): AccountSwapDeps {
    return {
        readKeystoreBundle,
        readSessionKeystoreFile,
        decryptSessionKeystore,
        readNonce: async ({ network, account }) => {
            const client = createPublicClient({
                chain: getChain(network.chainId, network.rpcUrl),
                transport: http(network.rpcUrl),
            })
            return readAccountNonce(client, account)
        },
        readTokenBalance: async ({ chain, token, account }) => {
            const config = getChainConfig(chain)
            const client = createPublicClient({
                chain: config.viemChain,
                transport: http(config.rpcUrl),
            })
            if (token === 'ETH') {
                return client.getBalance({ address: account })
            }
            return client.readContract({
                address: getTokenAddress(token, chain),
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [account],
            })
        },
        getQuote,
        pollIntentStatus,
        getKeys: async ({ network, account, chainId }) => {
            const client = createCliRelayerClient(network)
            return getKeysAction(client, { address: account, chainIds: [chainId] })
        },
        prepareCalls: async (input) => {
            const client = createCliRelayerClient(input.network)
            return client.prepareCalls({
                from: input.from,
                chainId: input.network.chainId,
                calls: input.calls,
                sessionKey: input.sessionKey,
                nonce: input.nonce,
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
        confirmQuote: async () => true,
        auditQuote: () => {},
        simulateQuoteCalls: (input) => simulateRelayQuote(input),
    }
}

export async function resolveAccountSwapPassword(
    args: AccountSwapArgs,
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
    throw new AccountSwapError(
        'PASSWORD_REQUIRED',
        'Password required. Use --password-stdin, TW_PASSWORD, or run in interactive TTY.',
    )
}

async function resolveSessionContext(
    keystorePath: string,
    options: AccountSwapOptions,
    network: NetworkConfig,
    deps: Pick<AccountSwapDeps, 'readKeystoreBundle' | 'readSessionKeystoreFile'>,
): Promise<{
    sessionKeystore: RelayerSessionKeystoreV2 | LoginSessionKeystoreV2
    sender: Address
    effectiveNetwork: NetworkConfig
}> {
    if (options.sessionFile && options.sessionName) {
        throw new AccountSwapError(
            'UNKNOWN',
            '--session and --session-file are mutually exclusive.',
        )
    }

    const selectedSessionName = options.sessionName
        ? parseSessionName(options.sessionName)
        : undefined

    if (options.sessionFile) {
        const sessionKeystore = await deps.readSessionKeystoreFile(options.sessionFile)
        if (isAgentKeystore(sessionKeystore)) {
            throw new AccountSwapError(
                'KEYSTORE_NOT_FOUND',
                'Agent session keystores are not supported for swap. Use a relayer or login session.',
            )
        }
        assertSessionNetworkMatches({
            sessionEnv: sessionKeystore.network.env,
            sessionChainId: sessionKeystore.network.chainId,
            expectedEnv: options.env,
            expectedChainId: network.chainId,
        })
        return {
            sessionKeystore,
            sender: getAddress(sessionKeystore.addresses.delegated),
            effectiveNetwork: sessionKeystore.network as NetworkConfig,
        }
    }

    if (selectedSessionName) {
        let bundle: Awaited<ReturnType<typeof deps.readKeystoreBundle>>
        try {
            bundle = await deps.readKeystoreBundle(keystorePath)
        } catch (error) {
            throw new AccountSwapError(
                'UNKNOWN',
                '--session requires a root profile keystore with local sessions. Use --session-file for portable session profiles.',
                { cause: error },
            )
        }

        const selectedSessionPath = resolveSessionKeystorePath(
            keystorePath,
            selectedSessionName,
            bundle.root.sessionRef.dir,
        )
        const sessionKeystore = await deps.readSessionKeystoreFile(selectedSessionPath)
        if (isAgentKeystore(sessionKeystore)) {
            throw new AccountSwapError(
                'KEYSTORE_NOT_FOUND',
                'Agent session keystores are not supported for swap. Use a relayer or login session.',
            )
        }
        assertSessionNetworkMatches({
            sessionEnv: sessionKeystore.network.env,
            sessionChainId: sessionKeystore.network.chainId,
            expectedEnv: options.env,
            expectedChainId: network.chainId,
        })
        return {
            sessionKeystore,
            sender: getAddress(bundle.root.addresses.delegated ?? bundle.root.addresses.root),
            effectiveNetwork: network,
        }
    }

    try {
        const bundle = await deps.readKeystoreBundle(keystorePath)
        if (isAgentKeystore(bundle.session)) {
            throw new AccountSwapError(
                'KEYSTORE_NOT_FOUND',
                'Agent session keystores are not supported for swap. Use a relayer or login session.',
            )
        }
        return {
            sessionKeystore: bundle.session,
            sender: getAddress(bundle.root.addresses.delegated ?? bundle.root.addresses.root),
            effectiveNetwork: network,
        }
    } catch (error) {
        if (
            !isMissingFileError(error) &&
            !(error instanceof SessionOnlyProfileError) &&
            !(error instanceof LoginProfileError)
        ) {
            throw error
        }
        console.error(
            `[tw debug] Root keystore missing at ${keystorePath}; falling back to session profile.`,
        )
        const sessionProfilePath = join(dirname(keystorePath), 'session.json')
        const loadedSessionKeystore = await deps.readSessionKeystoreFile(sessionProfilePath)
        if (isAgentKeystore(loadedSessionKeystore)) {
            throw new AccountSwapError(
                'KEYSTORE_NOT_FOUND',
                `Session-only profile has unsupported kind "${loadedSessionKeystore.kind}". Only login or relayer session profiles are supported for swap.`,
            )
        }
        const sessionKeystore = loadedSessionKeystore
        assertSessionNetworkMatches({
            sessionEnv: sessionKeystore.network.env,
            sessionChainId: sessionKeystore.network.chainId,
            expectedEnv: options.env,
            expectedChainId: network.chainId,
        })
        return {
            sessionKeystore,
            sender: getAddress(sessionKeystore.addresses.delegated),
            effectiveNetwork: sessionKeystore.network as NetworkConfig,
        }
    }
}

async function maybeRefreshQuoteAfterConfirmation(input: {
    initialQuote: RelayQuoteResponse
    confirmedAt: number
    request: Parameters<typeof getQuote>[0]
    options: AccountSwapOptions
    deps: Pick<AccountSwapDeps, 'getQuote'>
    limits: {
        amount: bigint
        native: boolean
        originCurrency: Address
        user: Address
        recipient: Address
    }
}): Promise<{ quote: RelayQuoteResponse; needsReconfirmation: boolean }> {
    if (input.options.yes || Date.now() - input.confirmedAt <= QUOTE_STALE_MS) {
        return { quote: input.initialQuote, needsReconfirmation: false }
    }

    const refreshedQuote = await input.deps.getQuote(input.request, { env: input.options.env })
    validateQuoteForExecution(refreshedQuote, input.request.originChainId, input.limits)
    return {
        quote: refreshedQuote,
        needsReconfirmation: quoteNeedsReconfirmation(input.initialQuote, refreshedQuote),
    }
}

function getDestinationTxHash(status: RelayIntentStatus): Hex | undefined {
    // relay.link intent status reports destination fills in txHashes; inTxHashes are source/input txs.
    return status.txHashes?.[0]
}

function isInvalidAmountMessage(message: string): boolean {
    return (
        message === 'Amount must be a positive decimal number.' ||
        message === 'Amount must be greater than zero.' ||
        message === 'Amount is invalid or too large.' ||
        /^Amount supports at most \d+ decimal places for (ETH|USDC)\.$/.test(message)
    )
}

export async function executeAccountSwap(
    options: AccountSwapOptions,
    depsArg?: Partial<AccountSwapDeps>,
): Promise<AccountSwapResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    let keystorePath = options.sessionFile ?? options.keystorePath ?? '<default>'
    let cachedPassword = options.password
    const resolvePassword = async (): Promise<string> => {
        if (cachedPassword) {
            return cachedPassword
        }
        if (options.resolvePassword) {
            cachedPassword = await options.resolvePassword()
            return cachedPassword
        }
        throw new AccountSwapError(
            'PASSWORD_REQUIRED',
            'Password required. Use --password-stdin, TW_PASSWORD, or run in interactive TTY.',
        )
    }

    try {
        keystorePath =
            options.sessionFile ??
            resolveKeystorePath({
                env: options.env,
                keystorePath: options.keystorePath,
                name: options.name,
            })
        const sourceChain = normalizeChain(options.sourceChain, options.env)
        const destinationChain = normalizeChain(
            options.destinationChain ?? sourceChain,
            options.env,
        )
        const operation =
            options.operation ?? (sourceChain !== destinationChain ? 'bridge' : 'swap')
        const isBridge = operation === 'bridge'
        const network = resolveNetworkConfig(options.env, sourceChain)

        const fromToken = normalizeTokenSymbol(options.fromToken)
        const toToken = normalizeTokenSymbol(options.toToken)
        if (isBridge && sourceChain === destinationChain) {
            throw new AccountSwapError(
                'SAME_CHAIN',
                'Source and destination chain must be different.',
            )
        }
        if (!isBridge && fromToken === toToken) {
            throw new AccountSwapError(
                'INVALID_TOKEN_PAIR',
                `Cannot swap ${fromToken} to ${toToken}.`,
            )
        }
        if (isBridge && fromToken !== toToken) {
            throw new AccountSwapError(
                'INVALID_TOKEN_PAIR',
                'Bridge currently supports bridging the same token across chains.',
            )
        }

        const slippage = options.slippage ?? DEFAULT_SLIPPAGE_PERCENT
        const parsedAmount = parseTokenAmount(fromToken, options.amount)
        // Reject bad recipients before touching the keystore so library-boundary
        // validation does not depend on a local profile existing.
        const explicitRecipient = parseRecipient(options.recipient)

        const { sessionKeystore, sender, effectiveNetwork } = await resolveSessionContext(
            keystorePath,
            options,
            network,
            deps,
        )
        const recipient = explicitRecipient ?? sender
        const resolvedSigner = await resolveSessionSigner({
            sessionName: sessionKeystore.name ?? options.sessionName ?? 'default',
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
        const sessionPublicKey = encodeSecp256k1Key(sessionKeystore.addresses.session as Address)
        const sessionKeyHash = computeKeyHash('secp256k1', sessionPublicKey)

        const balance = await deps.readTokenBalance({
            chain: sourceChain,
            token: fromToken,
            account: sender,
        })
        if (balance < parsedAmount.baseUnits) {
            throw new AccountSwapError(
                'SWAP_FAILED',
                `Insufficient ${fromToken} balance: have ${formatUnits(balance, getTokenDecimals(fromToken))}, need ${parsedAmount.normalized}`,
            )
        }
        if (fromToken === 'ETH') {
            const keys = await deps.getKeys({
                network: signedNetwork,
                account: sender,
                chainId: effectiveNetwork.chainId,
            })
            assertEthSpendPermission({
                keys,
                chainId: effectiveNetwork.chainId,
                sessionKeyHash,
                amount: parsedAmount.baseUnits,
                sourceChain,
            })
        }

        const quoteRequest = {
            user: sender,
            recipient: isBridge ? recipient : undefined,
            originChainId: getChainConfig(sourceChain).chainId,
            destinationChainId: getChainConfig(destinationChain).chainId,
            originCurrency: getTokenAddress(fromToken, sourceChain),
            destinationCurrency: getTokenAddress(toToken, destinationChain),
            amount: parsedAmount.baseUnits.toString(),
            tradeType: 'EXACT_INPUT' as const,
            slippageTolerance: slippagePercentToBps(slippage),
        }

        let quote = await deps.getQuote(quoteRequest, { env: options.env })
        const quoteLimits = {
            amount: parsedAmount.baseUnits,
            native: fromToken === 'ETH',
            originCurrency: quoteRequest.originCurrency,
            user: sender,
            recipient,
        }
        let review = validateQuoteForExecution(quote, quoteRequest.originChainId, quoteLimits)
        const sameChain = quoteRequest.originChainId === quoteRequest.destinationChainId

        const simulateQuote = async (current: RelayQuoteResponse, currentReview: RelayQuoteReview) => {
            const watches = quoteWatches({
                origin: quoteRequest.originCurrency,
                originIsNative: fromToken === 'ETH',
                output: quoteRequest.destinationCurrency,
                outputIsNative: toToken === 'ETH',
                sameChain,
                chainId: quoteRequest.originChainId,
                extraTokens: currentReview.tokens,
            })
            try {
                await deps.simulateQuoteCalls({
                    rpcUrl: effectiveNetwork.rpcUrl,
                    chainId: quoteRequest.originChainId,
                    user: sender,
                    calls: stepsToRelayerCalls(current.steps).map((call) => ({
                        to: call.target,
                        data: call.data,
                        value: call.value,
                    })),
                    watches,
                    cap: currentReview.cap,
                    sameChain,
                    minimumOutput: sameChain ? quotedMinimumOutput(current) : undefined,
                })
            } catch (error) {
                if (error instanceof AccountSwapError) throw error
                if (error instanceof RelayQuoteRejected || error instanceof RelaySimulationRejected) {
                    throw new AccountSwapError('QUOTE_FAILED', error.message, { cause: error })
                }
                throw new AccountSwapError(
                    'QUOTE_FAILED',
                    'relay.link quote could not be simulated. Refusing to sign.',
                    { cause: error },
                )
            }
        }

        // `yes` does not skip this review. It only skips refreshing a quote that
        // went stale while the human was confirming.
        for (let attempt = 1; attempt <= MAX_CONFIRMATION_ATTEMPTS; attempt += 1) {
            await simulateQuote(quote, review)
            const confirmedAt = Date.now()
            const confirmed = await deps.confirmQuote(quote)
            if (!confirmed) {
                throw new AccountSwapError('QUOTE_FAILED', 'Swap cancelled.')
            }

            const refresh = await maybeRefreshQuoteAfterConfirmation({
                initialQuote: quote,
                confirmedAt,
                request: quoteRequest,
                options,
                deps,
                limits: quoteLimits,
            })
            quote = refresh.quote
            if (!refresh.needsReconfirmation) {
                break
            }
            review = validateQuoteForExecution(quote, quoteRequest.originChainId, quoteLimits)
            if (attempt === MAX_CONFIRMATION_ATTEMPTS) {
                throw new AccountSwapError(
                    'QUOTE_FAILED',
                    'Quote changed materially too many times during confirmation. Re-run the command and confirm promptly.',
                )
            }
        }

        deps.auditQuote(quote)
        const calls = stepsToRelayerCalls(quote.steps)
        if (calls.length === 0) {
            throw new AccountSwapError('QUOTE_FAILED', 'relay.link returned no executable calls.')
        }

        const relayRequestId = isBridge ? extractRequestId(quote) : undefined

        const nonce = await deps.readNonce({
            network: signedNetwork,
            account: sender,
        })

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
                },
            )
        }

        let submission: Awaited<ReturnType<typeof deps.executeSignedCalls>>
        let signerMode: AccountSwapResult['signerMode'] =
            resolvedSigner.mode === 'daemon' ? 'daemon' : 'direct'
        try {
            submission = await runWithSigner(signedNetwork, resolvedSigner)
        } catch (error) {
            if (error instanceof SessionSignerExpiredError) {
                throw new AccountSwapError('SESSION_EXPIRED', error.message, { cause: error })
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
            debugSignerFallback('account_swap', {
                reason: error.message,
                sessionName: sessionKeystore.name ?? options.sessionName ?? 'default',
            })
            submission = await runWithSigner(fallbackNetwork, {
                signTypedData: deps.signTypedData,
                signerPrivateKey: fallback.sessionPrivateKey,
            })
        }

        const finalStatus = submission.finalStatus
        if (!finalStatus.success) {
            throw new AccountSwapError(
                'SWAP_FAILED',
                finalStatus.error ?? 'Relayer execution did not complete successfully.',
                {
                    details: {
                        statusCode: finalStatus.statusCode,
                        txHash: finalStatus.receipt?.transactionHash,
                    },
                },
            )
        }

        const statusCode = finalStatus.statusCode
        const intentError = finalStatus.receipt?.intentError as Hex | undefined
        const intentErrorName = intentError ? decodeIntentError(intentError) : undefined
        if (statusCode !== undefined && ![200, 201].includes(statusCode)) {
            const code: AccountSwapErrorCode =
                statusCode === 400 || statusCode === 500 ? 'INTENT_REVERTED' : 'SWAP_FAILED'
            throw new AccountSwapError(
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

        let destinationTxHash: Hex | undefined
        if (isBridge) {
            if (!relayRequestId) {
                throw new AccountSwapError('SWAP_FAILED', 'Bridge quote missing request ID.')
            }
            let bridgeStatus: RelayIntentStatus
            try {
                bridgeStatus = await deps.pollIntentStatus(
                    relayRequestId,
                    {
                        timeoutMs: 5 * 60 * 1000,
                        intervals: [
                            { untilMs: 30_000, everyMs: 2_000 },
                            { untilMs: 120_000, everyMs: 5_000 },
                            { untilMs: 300_000, everyMs: 10_000 },
                        ],
                    },
                    { env: options.env },
                )
            } catch (error) {
                if (error instanceof RelayLinkError && error.code === 'TIMEOUT') {
                    throw new AccountSwapError(
                        'BRIDGE_FILL_TIMEOUT',
                        `Bridge fill did not complete within 5 minutes. Check relay.link status: ${getRelayIntentStatusUrl(relayRequestId, options.env)}`,
                        { cause: error, details: error.details },
                    )
                }
                throw error
            }
            if (bridgeStatus.status !== 'success') {
                throw new AccountSwapError(
                    'BRIDGE_FILL_FAILED',
                    `Bridge fill ended in status ${bridgeStatus.status}. Check relay.link status: ${getRelayIntentStatusUrl(relayRequestId, options.env)}`,
                    { details: bridgeStatus },
                )
            }
            destinationTxHash = getDestinationTxHash(bridgeStatus)
        }

        return {
            type: isBridge ? 'account_bridge' : 'account_swap',
            status: 'complete',
            keystorePath,
            network: effectiveNetwork,
            sourceChain,
            destinationChain,
            sender,
            recipient,
            fromToken: {
                symbol: fromToken,
                address: getTokenAddress(fromToken, sourceChain),
                amount: parsedAmount.normalized,
                amountBaseUnits: parsedAmount.baseUnits.toString(),
            },
            toToken: {
                symbol: toToken,
                address: getTokenAddress(toToken, destinationChain),
                estimatedAmount: getEstimatedOutputAmount(quote),
            },
            rate: quote.details?.rate ?? '',
            totalFeesUsd: sumQuoteFeeUsd(quote),
            slippage: String(slippage),
            bundle: {
                id: submission.id,
                status: finalStatus.status ?? 'unknown',
                statusCode,
            },
            signerMode,
            txHash: finalStatus.receipt?.transactionHash,
            destinationTxHash,
            relayRequestId,
        }
    } catch (error) {
        if (error instanceof PromptCancelledError) {
            throw error
        }
        throw toAccountSwapError(error, { keystorePath })
    }
}

function debugSignerFallback(command: 'account_swap', details: unknown): void {
    if (process.env.TW_DAEMON_DEBUG !== '1') {
        return
    }
    console.error(`[tw ${command}] daemon signer fallback ${JSON.stringify(details)}`)
}

function toAccountSwapError(error: unknown, context: { keystorePath: string }): AccountSwapError {
    if (error instanceof AccountSwapError) {
        return error
    }

    if (error instanceof AccountCreateError && error.code === 'INVALID_NAME') {
        return new AccountSwapError('UNKNOWN', error.message, { cause: error })
    }

    if (error instanceof RelayLinkError) {
        if (error.code === 'TIMEOUT') {
            return new AccountSwapError('BRIDGE_FILL_TIMEOUT', error.message, {
                cause: error,
                details: error.details,
            })
        }
        if (error.code === 'MISSING_REQUEST_ID') {
            return new AccountSwapError('BRIDGE_QUOTE_INVALID', error.message, {
                cause: error,
                details: error.details,
            })
        }
        return new AccountSwapError('QUOTE_FAILED', `Failed to get swap quote: ${error.message}`, {
            cause: error,
            details: error.details,
        })
    }

    if (error instanceof JsonRpcClientError) {
        if (error.code === -32004) {
            const cause = extractSimulationCause(error.data)
            return new AccountSwapError(
                'SIMULATION_FAILED',
                cause ? `Simulation failed: ${cause}` : error.message,
                { cause: error, details: error.data },
            )
        }
        if (error.code === -32001) {
            const authCode = extractAuthCode(error.data)
            return new AccountSwapError(
                'UNKNOWN',
                authCode ? `Unauthorized (${authCode})` : error.message,
                { cause: error, details: error.data },
            )
        }
    }

    const message = error instanceof Error ? error.message : String(error)
    const messageLower = message.toLowerCase()

    if (message.includes('Unsupported chain')) {
        return new AccountSwapError('UNSUPPORTED_CHAIN', message, { cause: error })
    }
    if (message.includes('Unsupported token')) {
        return new AccountSwapError('UNSUPPORTED_TOKEN', message, { cause: error })
    }
    if (isInvalidAmountMessage(message)) {
        return new AccountSwapError('INVALID_AMOUNT', message, { cause: error })
    }
    if (messageLower.includes('simulation failed')) {
        return new AccountSwapError('SIMULATION_FAILED', message, { cause: error })
    }
    if (messageLower.includes('timeout waiting for bundle')) {
        return new AccountSwapError('BUNDLE_TIMEOUT', message, { cause: error })
    }
    if (
        (error instanceof Error && error.name === 'AbortError') ||
        messageLower.includes('fetch failed') ||
        messageLower.includes('aborted') ||
        messageLower.includes('network')
    ) {
        return new AccountSwapError(
            'QUOTE_FAILED',
            'Request to relay.link failed or timed out. Check your network and try again.',
            { cause: error },
        )
    }
    if (message.includes('ENOENT') || message.toLowerCase().includes('no such file')) {
        return new AccountSwapError(
            'KEYSTORE_NOT_FOUND',
            `Keystore not found at ${context.keystorePath}`,
            { cause: error },
        )
    }
    if (
        message.includes('No password provided on stdin') ||
        message.includes('Password required') ||
        message.includes('Password cannot be empty')
    ) {
        return new AccountSwapError('PASSWORD_REQUIRED', message, { cause: error })
    }

    return new AccountSwapError('UNKNOWN', message, { cause: error })
}
