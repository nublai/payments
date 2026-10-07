import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from 'viem'
import {
    decodeIntentError,
    type GetKeysResponse,
    type BundleStatusResponse,
    type Call,
    type PrepareCallsResponse,
} from '@nubl/relayer-client'
import { accountAbi } from '@nubl/contracts/abis'
import {
    CONFIRM_ROTATE_FULL_ACCESS_PHRASE,
    HumanConfirmationError,
    humanConfirmationMessage,
} from './human-confirmation'
import { getDefaultSessionPermissions, resolveKeystorePath } from './account-create'
import {
    createSessionKeystore,
    decryptRootKeystore,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    withKeystoreLock,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
} from './keystore'
import {
    chainsForEnv,
    getChainConfig,
    getUsdcTokenConfig,
    resolveNetworkConfig,
    rpcUrlForChain,
    selectDefaultChain,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
} from './network-config'
import { ANY_KEYHASH, readGuardCleanup, type GuardCleanup } from './session-chain-permissions'
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
import { readActiveUsdcDaily } from './session-gates'
import {
    buildPermissionDefaults,
    computeSessionKeyHash,
    DEFAULT_SESSION_SPEND_LIMIT,
    getChainKeys,
    normalizedDailyUsdcUnits,
    parseSessionName,
    toSpendPeriodEnum,
} from './session-common'
import { generatePrivateKey } from 'viem/accounts'

const ROTATION_MARKER_NAME = '.rotation.json'

type RotationIntentBase = {
    oldSessionName: string
    newSessionName: string
    fileName: string
    chain: ChainName
    chainId: number
    newKeyHash: Hex
    narrow: boolean
    fullAccess: boolean
}

type PendingRotationIntent = RotationIntentBase & {
    status: 'pending'
}

type SubmittedRotationIntent = RotationIntentBase & {
    status: 'submitted'
    bundleId: string
}

type RotationIntent = PendingRotationIntent | SubmittedRotationIntent
type PendingRotationIntentPayload = Omit<PendingRotationIntent, 'fileName'>
type SubmittedRotationIntentPayload = Omit<SubmittedRotationIntent, 'fileName'>
type RotationIntentPayload = PendingRotationIntentPayload | SubmittedRotationIntentPayload

type SessionRotateErrorCode =
    | 'NO_ACTIVE_SESSION'
    | 'INVALID_NAME'
    | 'KEYSTORE_NOT_FOUND'
    | 'PASSWORD_REQUIRED'
    | 'ROTATION_FAILED'
    | 'ROTATION_PARTIAL'
    | 'ROTATION_MARKER_AMBIGUOUS'
    | 'ROTATION_MARKER_MISMATCH'
    | 'ROTATION_WRONG_CHAIN'
    | 'ROTATION_VERIFICATION_FAILED'
    | 'KEYSTORE_LOCKED'
    | 'UNKNOWN'

export class SessionRotateError extends Error {
    code: SessionRotateErrorCode
    cause?: unknown
    recoveryCommand?: string
    details?: unknown

    constructor(
        code: SessionRotateErrorCode,
        message: string,
        options?: { cause?: unknown; recoveryCommand?: string; details?: unknown },
    ) {
        super(message)
        this.name = 'SessionRotateError'
        this.code = code
        this.cause = options?.cause
        this.recoveryCommand = options?.recoveryCommand
        this.details = options?.details
    }
}

export type SessionRotateResult = {
    type: 'session_rotate'
    status: 'complete'
    resumed: boolean
    keystorePath: string
    network: CliNetworkConfig
    accountAddress: Address
    oldSessionName: string
    newSessionName: string
    oldSessionPath: string
    newSessionPath: string
    txHash?: Hex
    bundle: {
        id: string
        status: string
        statusCode: number
    }
    feeCap?: ExecuteSignedCallsResult['feeCap']
}

type SessionRotateDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    createSessionKeystore: typeof createSessionKeystore
    writeSessionKeystoreFile: typeof writeSessionKeystoreFile
    writeRootKeystoreFile: typeof writeRootKeystoreFile
    decryptRootKeystore: typeof decryptRootKeystore
    generatePrivateKey: typeof generatePrivateKey
    unlink: (path: string) => Promise<void>
    readRotationIntent: (
        rootKeystorePath: string,
        sessionsDir: string,
    ) => Promise<RotationIntent | null>
    writeRotationIntent: (
        rootKeystorePath: string,
        sessionsDir: string,
        value: RotationIntentPayload,
        fileName?: string,
    ) => Promise<RotationIntent>
    deleteRotationIntent: (
        rootKeystorePath: string,
        sessionsDir: string,
        fileName: string,
    ) => Promise<void>
    readNonce: (input: { network: CliNetworkConfig; account: Address }) => Promise<bigint>
    getKeys: (input: {
        network: CliNetworkConfig
        account: Address
        chainId: number
    }) => Promise<GetKeysResponse>
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
    readGuardCleanup: typeof readGuardCleanup
    readActiveUsdcDaily: typeof readActiveUsdcDaily
}

function rotationDir(rootKeystorePath: string, sessionsDir: string): string {
    return join(dirname(rootKeystorePath), sessionsDir)
}

async function defaultReadRotationIntent(
    rootKeystorePath: string,
    sessionsDir: string,
): Promise<RotationIntent | null> {
    const dir = rotationDir(rootKeystorePath, sessionsDir)
    const entries = await readdir(dir, { withFileTypes: true })
    const candidates = entries
        .filter(
            (entry) =>
                entry.isFile() &&
                entry.name.startsWith('.rotation-') &&
                entry.name.endsWith('.json'),
        )
        .map((entry) => entry.name)
    if (candidates.length === 0) return null
    if (candidates.length > 1) {
        throw new SessionRotateError(
            'ROTATION_MARKER_AMBIGUOUS',
            `Refusing to resume: found ${candidates.length} rotation markers (${candidates.join(', ')}). Keep the one rotation you started.`,
            { details: { files: candidates } },
        )
    }
    const markerName = candidates[0]!
    const content = await readFile(join(dir, markerName), 'utf8')
    const parsed = parseRotationIntentPayload(JSON.parse(content))
    return withRotationIntentFileName(parsed, markerName)
}

async function defaultWriteRotationIntent(
    rootKeystorePath: string,
    sessionsDir: string,
    value: RotationIntentPayload,
    fileName?: string,
): Promise<RotationIntent> {
    const dir = rotationDir(rootKeystorePath, sessionsDir)
    const finalFileName = fileName ?? ROTATION_MARKER_NAME
    await writeFile(join(dir, finalFileName), `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
    })
    return withRotationIntentFileName(value, finalFileName)
}

function withRotationIntentFileName(
    intent: RotationIntentPayload,
    fileName: string,
): RotationIntent {
    if (intent.status === 'submitted') {
        return { ...intent, fileName }
    }
    return { ...intent, fileName }
}

function parseRotationIntentPayload(value: unknown): RotationIntentPayload {
    if (typeof value !== 'object' || value === null) {
        throw new Error('Invalid rotation intent payload.')
    }
    const maybe = value as {
        oldSessionName?: unknown
        newSessionName?: unknown
        status?: unknown
        bundleId?: unknown
        chain?: unknown
        chainId?: unknown
        newKeyHash?: unknown
        narrow?: unknown
        fullAccess?: unknown
    }
    if (typeof maybe.oldSessionName !== 'string' || typeof maybe.newSessionName !== 'string') {
        throw new Error('Invalid rotation intent payload.')
    }
    if (maybe.chain !== 'base' && maybe.chain !== 'polygon' && maybe.chain !== 'anvil') {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing the chain it was started on.',
        )
    }
    if (typeof maybe.chainId !== 'number' || !Number.isInteger(maybe.chainId)) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing its chain id.',
        )
    }
    if (typeof maybe.newKeyHash !== 'string' || !maybe.newKeyHash.startsWith('0x')) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing the new key hash.',
        )
    }
    if (typeof maybe.narrow !== 'boolean' || typeof maybe.fullAccess !== 'boolean') {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing its permission flags.',
        )
    }
    const bound = {
        oldSessionName: maybe.oldSessionName,
        newSessionName: maybe.newSessionName,
        chain: maybe.chain,
        chainId: maybe.chainId,
        newKeyHash: maybe.newKeyHash as Hex,
        narrow: maybe.narrow,
        fullAccess: maybe.fullAccess,
    }
    if (maybe.status === 'pending') {
        return { ...bound, status: 'pending' }
    }
    if (maybe.status === 'submitted' && typeof maybe.bundleId === 'string' && maybe.bundleId) {
        return { ...bound, status: 'submitted', bundleId: maybe.bundleId }
    }
    throw new Error('Invalid rotation intent payload.')
}

function markRotationIntentSubmitted(
    intent: RotationIntent,
    bundleId: string,
): SubmittedRotationIntentPayload {
    return {
        oldSessionName: intent.oldSessionName,
        newSessionName: intent.newSessionName,
        chain: intent.chain,
        chainId: intent.chainId,
        newKeyHash: intent.newKeyHash,
        narrow: intent.narrow,
        fullAccess: intent.fullAccess,
        status: 'submitted',
        bundleId,
    }
}

async function defaultDeleteRotationIntent(
    rootKeystorePath: string,
    sessionsDir: string,
    fileName: string,
): Promise<void> {
    await unlink(join(rotationDir(rootKeystorePath, sessionsDir), fileName))
}

function getDefaultDeps(): SessionRotateDeps {
    return {
        readKeystoreBundle,
        readSessionKeystoreFile,
        createSessionKeystore,
        writeSessionKeystoreFile,
        writeRootKeystoreFile,
        decryptRootKeystore,
        generatePrivateKey,
        unlink,
        readRotationIntent: defaultReadRotationIntent,
        writeRotationIntent: defaultWriteRotationIntent,
        deleteRotationIntent: defaultDeleteRotationIntent,
        readNonce: async ({ network, account }) => {
            const client = createCliRelayerClient(network)
            return readAccountNonce(client, account)
        },
        getKeys: async ({ network, account, chainId }) => {
            const client = createCliRelayerClient(network)
            return client.getKeys({ address: account, chainIds: [chainId] })
        },
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
        readGuardCleanup,
        readActiveUsdcDaily,
    }
}

function guardCleanupCalls(account: Address, cleanup: GuardCleanup): Call[] {
    const calls: Call[] = []
    for (const call of cleanup.anyCalls) {
        calls.push({
            target: account,
            value: 0n,
            data: encodeFunctionData({
                abi: accountAbi,
                functionName: 'setCanExecute',
                args: [ANY_KEYHASH, call.target, call.selector, false],
            }),
        })
    }
    for (const checker of cleanup.checkers) {
        calls.push({
            target: account,
            value: 0n,
            data: encodeFunctionData({
                abi: accountAbi,
                functionName: 'setCallChecker',
                args: [checker.keyHash, checker.target, zeroAddress],
            }),
        })
    }
    return calls
}

async function executeExtraCleanups(input: {
    deps: SessionRotateDeps
    env: EnvName
    accountAddress: Address
    rootPrivateKey: Hex
    extras: { chainName: ChainName; calls: Call[] }[]
}): Promise<ChainName[]> {
    const failed: ChainName[] = []
    for (const extra of input.extras) {
        try {
            const extraNetwork = {
                ...resolveNetworkConfig(input.env, extra.chainName),
                authSigner: createEthHttpSigner(
                    input.rootPrivateKey,
                    getChainConfig(extra.chainName).chainId,
                ),
            }
            const extraNonce = await input.deps.readNonce({
                network: extraNetwork,
                account: input.accountAddress,
            })
            const submission = await input.deps.executeSignedCalls(
                {
                    prepareCalls: (call) =>
                        input.deps.prepareCalls({
                            network: extraNetwork,
                            from: call.from,
                            calls: call.calls,
                            nonce: call.nonce,
                            expiry: call.expiry,
                            payer: call.payer,
                            paymentToken: call.paymentToken,
                            paymentMaxAmount: call.paymentMaxAmount,
                            sessionKey: call.sessionKey,
                        }),
                    signTypedData: input.deps.signTypedData,
                    sendPreparedCalls: (call) =>
                        input.deps.sendPreparedCalls({
                            network: extraNetwork,
                            context: call.context,
                            signature: call.signature,
                        }),
                    waitForBundle: (call) =>
                        input.deps.waitForBundle({ network: extraNetwork, id: call.id }),
                },
                {
                    from: input.accountAddress,
                    calls: extra.calls,
                    nonce: extraNonce,
                    signerPrivateKey: input.rootPrivateKey,
                    chainId: extraNetwork.chainId,
                    env: extraNetwork.env,
                },
            )
            const status = submission.finalStatus
            if (!status?.success || ![200, 201].includes(status.statusCode ?? 0)) {
                failed.push(extra.chainName)
            }
        } catch {
            failed.push(extra.chainName)
        }
    }
    return failed
}

function partialRotationError(chain: ChainName, failed: ChainName[]): SessionRotateError {
    return new SessionRotateError(
        'ROTATION_PARTIAL',
        `Session rotation submitted on ${chain}, but cleanup failed on ${failed.join(', ')}. The new session file was kept. Resume with \`tw session rotate --resume\`.`,
        {
            details: { chains: failed },
            recoveryCommand: 'tw session rotate --resume',
        },
    )
}

export async function executeSessionRotate(
    options: {
        env: EnvName
        chain?: ChainName
        name?: string
        keystorePath?: string
        newName?: string
        resume?: boolean
        fullAccess?: boolean
        narrow?: boolean
        /** Set only after ROTATE FULL ACCESS SESSION was typed. */
        fullAccessPhraseConfirmed?: boolean
        target?: Address
        selectors?: Hex[]
        spendLimit?: bigint
        spendPeriod?: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' | 'forever'
        password: string
    },
    depsArg?: Partial<SessionRotateDeps>,
): Promise<SessionRotateResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    let chain = selectDefaultChain(options.env, options.chain)
    let network = resolveNetworkConfig(options.env, chain)
    const keystorePath = resolveKeystorePath({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
    })

    return deps.withKeystoreLock(keystorePath, async () => {
        const bundle = await deps.readKeystoreBundle(keystorePath)

        const accountAddress = bundle.root.addresses.delegated
            ? getAddress(bundle.root.addresses.delegated)
            : undefined
        if (!accountAddress) {
            throw new SessionRotateError('ROTATION_FAILED', 'Account is not delegated yet.')
        }

        const activeSessionName = parseSessionName(bundle.root.sessionRef.active)
        if (!activeSessionName) {
            throw new SessionRotateError('NO_ACTIVE_SESSION', 'No active session found.')
        }

        const oldSessionPath = resolveSessionKeystorePath(
            keystorePath,
            activeSessionName,
            bundle.root.sessionRef.dir,
        )
        const oldSession = await deps.readSessionKeystoreFile(oldSessionPath)
        const oldSessionAddress = getAddress(oldSession.addresses.session)
        const oldKeyHash = computeSessionKeyHash(oldSessionAddress)

        let intent = await deps.readRotationIntent(keystorePath, bundle.root.sessionRef.dir)
        let resumed = false

        if (options.resume && !intent) {
            await deps.decryptRootKeystore(bundle.root, options.password)
            return {
                type: 'session_rotate',
                status: 'complete',
                resumed: true,
                keystorePath,
                network,
                accountAddress,
                oldSessionName: activeSessionName,
                newSessionName: activeSessionName,
                oldSessionPath,
                newSessionPath: oldSessionPath,
                bundle: { id: 'noop', status: 'already-complete', statusCode: 0 },
            }
        }

        if (!intent || !options.resume) {
            const newSessionName = options.newName
                ? parseSessionName(options.newName)
                : `${activeSessionName}-${Math.floor(Date.now() / 1000)}`
            const newSessionPrivateKey = deps.generatePrivateKey()
            const newSession = await deps.createSessionKeystore({
                password: options.password,
                sessionPrivateKey: newSessionPrivateKey,
                network,
                delegated: accountAddress,
                name: newSessionName,
                checkpoint: 'pending_rotation',
            })
            const newSessionPath = resolveSessionKeystorePath(
                keystorePath,
                newSessionName,
                bundle.root.sessionRef.dir,
            )
            await deps.writeSessionKeystoreFile(newSessionPath, newSession)
            intent = await deps.writeRotationIntent(keystorePath, bundle.root.sessionRef.dir, {
                oldSessionName: activeSessionName,
                newSessionName,
                status: 'pending',
                chain,
                chainId: network.chainId,
                newKeyHash: computeSessionKeyHash(getAddress(newSession.addresses.session)),
                narrow: options.narrow === true,
                fullAccess: options.fullAccess === true,
            })
        } else {
            resumed = true
        }

        const newSessionPath = resolveSessionKeystorePath(
            keystorePath,
            intent.newSessionName,
            bundle.root.sessionRef.dir,
        )
        const newSession = await deps.readSessionKeystoreFile(newSessionPath)
        const newSessionAddress = getAddress(newSession.addresses.session)
        const newKeyHash = computeSessionKeyHash(newSessionAddress)
        if (resumed) {
            if (intent.newKeyHash.toLowerCase() !== newKeyHash.toLowerCase()) {
                throw new SessionRotateError(
                    'ROTATION_MARKER_MISMATCH',
                    'Rotation marker key does not match the new session file. Refusing to authorize.',
                    { details: { markerKeyHash: intent.newKeyHash, sessionKeyHash: newKeyHash } },
                )
            }
            if (options.chain && options.chain !== intent.chain) {
                throw new SessionRotateError(
                    'ROTATION_WRONG_CHAIN',
                    `This rotation was started on ${intent.chain}. Refusing to resume it on ${options.chain}.`,
                    { details: { markerChain: intent.chain, requestedChain: options.chain } },
                )
            }
            if (intent.chain !== chain) {
                chain = intent.chain
                network = resolveNetworkConfig(options.env, chain)
            }
            if (intent.chainId !== network.chainId) {
                throw new SessionRotateError(
                    'ROTATION_MARKER_MISMATCH',
                    'Rotation marker chain id does not match the chain.',
                )
            }
            if (options.narrow === true && intent.narrow !== true) {
                throw new SessionRotateError(
                    'ROTATION_MARKER_MISMATCH',
                    'Resume asked for --narrow, but this rotation marker is not narrow.',
                )
            }
            if (options.fullAccess === true && intent.fullAccess !== true) {
                throw new SessionRotateError(
                    'ROTATION_MARKER_MISMATCH',
                    'Resume asked for full access, but this rotation marker is not full access.',
                )
            }
        }
        const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
        const signedNetwork = {
            ...network,
            authSigner: createEthHttpSigner(decryptedRoot.rootPrivateKey, network.chainId),
        }

        let bundleId = intent.status === 'submitted' ? intent.bundleId : undefined
        let finalStatus: BundleStatusResponse | null = null
        let feeCap: ExecuteSignedCallsResult['feeCap'] | undefined
        let extraCleanups: { chainName: ChainName; calls: Call[] }[] = []

        if (intent.status === 'pending') {
            const narrow = resumed ? intent.narrow === true : options.narrow === true
            const fullAccess = resumed ? intent.fullAccess === true : options.fullAccess === true
            if (narrow && fullAccess) {
                throw new SessionRotateError(
                    'ROTATION_FAILED',
                    '--narrow cannot be combined with full access.',
                )
            }
            const { encodeSecp256k1Key } = await import('@nubl/relayer-client')
            const authorizeCall: Call = {
                target: accountAddress,
                value: 0n,
                data: encodeFunctionData({
                    abi: accountAbi,
                    functionName: 'authorize',
                    args: [
                        {
                            expiry: 0,
                            keyType: 0,
                            isSuperAdmin: false,
                            publicKey: encodeSecp256k1Key(newSessionAddress),
                        },
                    ],
                }),
            }
            const revokeCall: Call = {
                target: accountAddress,
                value: 0n,
                data: encodeFunctionData({
                    abi: accountAbi,
                    functionName: 'revoke',
                    args: [oldKeyHash],
                }),
            }
            const narrowPermissions = narrow
                ? getDefaultSessionPermissions(network.chainId, { env: options.env })
                : undefined
            const permissionDefaults = narrow
                ? undefined
                : buildPermissionDefaults({
                      fullAccess,
                      chain,
                      target: options.target,
                      selectors: options.selectors,
                      spendLimit: options.spendLimit,
                      spendPeriod: options.spendPeriod,
                  })
            if (!options.fullAccessPhraseConfirmed) {
                const usdc = getUsdcTokenConfig(chain).address
                const spendToken = narrowPermissions
                    ? narrowPermissions.find((permission) => permission.type === 'spend')?.token
                    : permissionDefaults?.spendToken
                const spendLimit = narrowPermissions
                    ? BigInt(
                          narrowPermissions.find((permission) => permission.type === 'spend')
                              ?.limit ?? '0',
                      )
                    : permissionDefaults?.spendLimit
                const spendPeriod = narrowPermissions
                    ? narrowPermissions.find((permission) => permission.type === 'spend')?.period
                    : permissionDefaults?.spendPeriod
                if (
                    spendToken &&
                    spendLimit !== undefined &&
                    spendPeriod &&
                    spendToken.toLowerCase() === usdc.toLowerCase()
                ) {
                    const proposed = normalizedDailyUsdcUnits(spendLimit, spendPeriod)
                    const existing = await deps.readActiveUsdcDaily({
                        env: options.env,
                        chain,
                        name: options.name,
                        keystorePath,
                        excludeSessionName: activeSessionName,
                    })
                    if (
                        existing === 'unreadable' ||
                        existing + proposed > DEFAULT_SESSION_SPEND_LIMIT
                    ) {
                        throw new HumanConfirmationError(
                            humanConfirmationMessage(
                                'Rotating to a full-access session',
                                CONFIRM_ROTATE_FULL_ACCESS_PHRASE,
                            ),
                        )
                    }
                }
            }

            let selectedCleanup: Call[] = []
            extraCleanups = []
            for (const chainName of chainsForEnv(options.env)) {
                let cleanup: GuardCleanup
                try {
                    cleanup = await deps.readGuardCleanup({
                        rpcUrl: rpcUrlForChain(chainName),
                        chainId: getChainConfig(chainName).chainId,
                        account: accountAddress,
                        keyHashes: [oldKeyHash, newKeyHash],
                    })
                } catch (error) {
                    throw new SessionRotateError(
                        'ROTATION_FAILED',
                        'Could not read ANY_KEYHASH permissions before rotating.',
                        { cause: error },
                    )
                }
                const cleanupCalls = guardCleanupCalls(accountAddress, cleanup)
                if (chainName === chain) selectedCleanup = cleanupCalls
                else if (cleanupCalls.length > 0) extraCleanups.push({ chainName, calls: cleanupCalls })
            }

            let calls: Call[]
            if (narrow) {
                const permissions = narrowPermissions ?? []
                const spend = permissions.find((permission) => permission.type === 'spend')
                if (!spend || spend.type !== 'spend') {
                    throw new SessionRotateError(
                        'ROTATION_FAILED',
                        'Narrow default session is missing a USDC spend limit.',
                    )
                }
                calls = [
                    ...selectedCleanup,
                    authorizeCall,
                    {
                        target: accountAddress,
                        value: 0n,
                        data: encodeFunctionData({
                            abi: accountAbi,
                            functionName: 'setSpendLimit',
                            args: [
                                newKeyHash,
                                spend.token,
                                toSpendPeriodEnum(spend.period),
                                BigInt(spend.limit),
                            ],
                        }),
                    },
                    ...permissions
                        .filter((permission) => permission.type === 'call')
                        .map((permission) => ({
                            target: accountAddress,
                            value: 0n,
                            data: encodeFunctionData({
                                abi: accountAbi,
                                functionName: 'setCanExecute' as const,
                                args: [newKeyHash, permission.to, permission.selector, true] as [
                                    Hex,
                                    Address,
                                    Hex,
                                    boolean,
                                ],
                            }),
                        })),
                    revokeCall,
                ]
            } else {
                if (!permissionDefaults) {
                    throw new SessionRotateError('ROTATION_FAILED', 'Missing rotation permissions.')
                }
                calls = [
                    ...selectedCleanup,
                    authorizeCall,
                    {
                        target: accountAddress,
                        value: 0n,
                        data: encodeFunctionData({
                            abi: accountAbi,
                            functionName: 'setSpendLimit',
                            args: [
                                newKeyHash,
                                permissionDefaults.spendToken,
                                toSpendPeriodEnum(permissionDefaults.spendPeriod),
                                permissionDefaults.spendLimit,
                            ],
                        }),
                    },
                    ...permissionDefaults.selectors.map((selector) => ({
                        target: accountAddress,
                        value: 0n,
                        data: encodeFunctionData({
                            abi: accountAbi,
                            functionName: 'setCanExecute' as const,
                            args: [newKeyHash, permissionDefaults.target, selector, true] as [
                                Hex,
                                Address,
                                Hex,
                                boolean,
                            ],
                        }),
                    })),
                    revokeCall,
                ]
            }

            let skipSelectedAuthorize = false
            if (resumed) {
                const keysNow = await deps.getKeys({
                    network: signedNetwork,
                    account: accountAddress,
                    chainId: network.chainId,
                })
                const present = getChainKeys(keysNow, network.chainId)
                const hasNew = present.some(
                    (entry: { hash?: string }) =>
                        typeof entry.hash === 'string' &&
                        entry.hash.toLowerCase() === newKeyHash.toLowerCase(),
                )
                const hasOld = present.some(
                    (entry: { hash?: string }) =>
                        typeof entry.hash === 'string' &&
                        entry.hash.toLowerCase() === oldKeyHash.toLowerCase(),
                )
                if (hasNew && !hasOld) skipSelectedAuthorize = true
                else if (!(!hasNew && hasOld)) {
                    throw new SessionRotateError(
                        'ROTATION_MARKER_MISMATCH',
                        'On-chain keys do not match this rotation marker. Refusing to authorize.',
                    )
                }
            }

            if (!skipSelectedAuthorize) {
            const nonce = await deps.readNonce({ network: signedNetwork, account: accountAddress })

            try {
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
                bundleId = submission.id
                finalStatus = submission.finalStatus
                feeCap = submission.feeCap
            } catch (error) {
                await deps.unlink(newSessionPath).catch(() => undefined)
                await deps
                    .deleteRotationIntent(keystorePath, bundle.root.sessionRef.dir, intent.fileName)
                    .catch(() => undefined)
                throw new SessionRotateError(
                    'ROTATION_FAILED',
                    'Session rotation transaction failed.',
                    {
                        cause: error,
                    },
                )
            }
            if (!bundleId) {
                throw new SessionRotateError(
                    'ROTATION_FAILED',
                    'Session rotation transaction failed.',
                )
            }
            intent = await deps.writeRotationIntent(
                keystorePath,
                bundle.root.sessionRef.dir,
                markRotationIntentSubmitted(intent, bundleId),
                intent.fileName,
            )
            } else {
                finalStatus = {
                    id: 'already-authorized',
                    success: true,
                    status: 'confirmed',
                    statusCode: 200,
                }
                bundleId = 'already-authorized'
            }
        }

        if (intent.status === 'submitted' && !finalStatus) {
            finalStatus = await deps.waitForBundle({ network: signedNetwork, id: intent.bundleId })
            bundleId = intent.bundleId
        }

        if (
            !finalStatus ||
            !finalStatus.success ||
            ![200, 201].includes(finalStatus.statusCode ?? 0)
        ) {
            const intentError = finalStatus?.receipt?.intentError as Hex | undefined
            throw new SessionRotateError(
                'ROTATION_FAILED',
                finalStatus?.error ?? 'Session rotation did not complete successfully.',
                {
                    details: {
                        statusCode: finalStatus?.statusCode,
                        txHash: finalStatus?.receipt?.transactionHash,
                        intentError,
                        intentErrorName: intentError ? decodeIntentError(intentError) : undefined,
                    },
                },
            )
        }

        if (resumed && intent.status === 'submitted') {
            const existing = await deps.readActiveUsdcDaily({
                env: options.env,
                chain,
                name: options.name,
                keystorePath,
                excludeSessionName: activeSessionName,
            })
            if (!options.fullAccessPhraseConfirmed && !intent.fullAccess) {
                const permissions = intent.narrow
                    ? getDefaultSessionPermissions(network.chainId, { env: options.env })
                    : undefined
                const defaults = intent.narrow
                    ? undefined
                    : buildPermissionDefaults({
                          fullAccess: false,
                          chain,
                          target: options.target,
                          selectors: options.selectors,
                          spendLimit: options.spendLimit,
                          spendPeriod: options.spendPeriod,
                      })
                const usdc = getUsdcTokenConfig(chain).address
                const spend = permissions?.find((permission) => permission.type === 'spend')
                const spendToken = permissions ? spend?.token : defaults?.spendToken
                const spendLimit = permissions
                    ? BigInt(spend && spend.type === 'spend' ? spend.limit : '0')
                    : defaults?.spendLimit
                const spendPeriod = permissions
                    ? spend && spend.type === 'spend'
                        ? spend.period
                        : undefined
                    : defaults?.spendPeriod
                if (
                    spendToken &&
                    spendLimit !== undefined &&
                    spendPeriod &&
                    spendToken.toLowerCase() === usdc.toLowerCase()
                ) {
                    const proposed = normalizedDailyUsdcUnits(spendLimit, spendPeriod)
                    if (
                        existing === 'unreadable' ||
                        existing + proposed > DEFAULT_SESSION_SPEND_LIMIT
                    ) {
                        throw new HumanConfirmationError(
                            humanConfirmationMessage(
                                'Rotating to a full-access session',
                                CONFIRM_ROTATE_FULL_ACCESS_PHRASE,
                            ),
                        )
                    }
                }
            }
        }

        if (resumed) {
            extraCleanups = []
            const unreadable: ChainName[] = []
            for (const chainName of chainsForEnv(options.env)) {
                if (chainName === chain) continue
                try {
                    const cleanup = await deps.readGuardCleanup({
                        rpcUrl: rpcUrlForChain(chainName),
                        chainId: getChainConfig(chainName).chainId,
                        account: accountAddress,
                        keyHashes: [oldKeyHash, newKeyHash],
                    })
                    const cleanupCalls = guardCleanupCalls(accountAddress, cleanup)
                    if (cleanupCalls.length > 0) extraCleanups.push({ chainName, calls: cleanupCalls })
                } catch {
                    unreadable.push(chainName)
                }
            }
            if (unreadable.length > 0) {
                throw partialRotationError(chain, unreadable)
            }
        }

        const failedChains = await executeExtraCleanups({
            deps,
            env: options.env,
            accountAddress,
            rootPrivateKey: decryptedRoot.rootPrivateKey,
            extras: extraCleanups,
        })
        if (failedChains.length > 0) {
            throw partialRotationError(chain, failedChains)
        }

        const keys = await deps.getKeys({
            network: signedNetwork,
            account: accountAddress,
            chainId: network.chainId,
        })
        const chainKeys = getChainKeys(keys, network.chainId)
        const hasNew = chainKeys.some(
            (entry: { hash?: string }) =>
                typeof entry.hash === 'string' &&
                entry.hash.toLowerCase() === newKeyHash.toLowerCase(),
        )
        const hasOld = chainKeys.some(
            (entry: { hash?: string }) =>
                typeof entry.hash === 'string' &&
                entry.hash.toLowerCase() === oldKeyHash.toLowerCase(),
        )

        if (!hasNew || hasOld) {
            throw new SessionRotateError(
                'ROTATION_VERIFICATION_FAILED',
                'Rotation confirmation failed on-chain verification.',
                { recoveryCommand: 'tw session list --on-chain --json' },
            )
        }

        bundle.root.sessionRef.active = intent.newSessionName
        await deps.writeRootKeystoreFile(keystorePath, bundle.root, { overwrite: true })
        await deps.writeSessionKeystoreFile(
            newSessionPath,
            {
                ...newSession,
                checkpoint: 'authorized',
            },
            { overwrite: true },
        )

        await deps.deleteRotationIntent(keystorePath, bundle.root.sessionRef.dir, intent.fileName)
        await deps.unlink(oldSessionPath).catch(() => undefined)

        return {
            type: 'session_rotate',
            status: 'complete',
            resumed,
            keystorePath,
            network,
            accountAddress,
            oldSessionName: intent.oldSessionName,
            newSessionName: intent.newSessionName,
            oldSessionPath,
            newSessionPath,
            txHash: finalStatus.receipt?.transactionHash,
            bundle: {
                id: bundleId ?? 'unknown',
                status: finalStatus.status ?? 'unknown',
                statusCode: finalStatus.statusCode ?? 0,
            },
            feeCap,
        }
    })
}
