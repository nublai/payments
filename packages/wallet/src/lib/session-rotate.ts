import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import {
    decodeIntentError,
    type GetKeysResponse,
    type BundleStatusResponse,
    type Call,
    type PrepareCallsResponse,
} from '@nubl/relayer-client'
import { accountAbi } from '@nubl/contracts/abis'
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
import { executeSignedCalls, type ExecuteSignedCallsDeps } from './execute-calls'
import {
    buildPermissionDefaults,
    computeSessionKeyHash,
    getChainKeys,
    parseSessionName,
    toSpendPeriodEnum,
} from './session-common'
import { generatePrivateKey } from 'viem/accounts'

type RotationIntentBase = {
    oldSessionName: string
    newSessionName: string
    fileName: string
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
        params: {
            from: Address
            calls: Call[]
            nonce: bigint
            signerPrivateKey: Hex
            signerKeyHash?: Hex
            sessionKey?: Hex
        },
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
        .sort()
    const latest = candidates.at(-1)
    if (!latest) return null
    const content = await readFile(join(dir, latest), 'utf8')
    const parsed = parseRotationIntentPayload(JSON.parse(content))
    return withRotationIntentFileName(parsed, latest)
}

async function defaultWriteRotationIntent(
    rootKeystorePath: string,
    sessionsDir: string,
    value: RotationIntentPayload,
    fileName?: string,
): Promise<RotationIntent> {
    const dir = rotationDir(rootKeystorePath, sessionsDir)
    const finalFileName = fileName ?? `.rotation-${Date.now()}.json`
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
    }
    if (typeof maybe.oldSessionName !== 'string' || typeof maybe.newSessionName !== 'string') {
        throw new Error('Invalid rotation intent payload.')
    }
    if (maybe.status === 'pending') {
        return {
            oldSessionName: maybe.oldSessionName,
            newSessionName: maybe.newSessionName,
            status: 'pending',
        }
    }
    if (maybe.status === 'submitted' && typeof maybe.bundleId === 'string' && maybe.bundleId) {
        return {
            oldSessionName: maybe.oldSessionName,
            newSessionName: maybe.newSessionName,
            status: 'submitted',
            bundleId: maybe.bundleId,
        }
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
        target?: Address
        selectors?: Hex[]
        spendLimit?: bigint
        spendPeriod?: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' | 'forever'
        password: string
    },
    depsArg?: Partial<SessionRotateDeps>,
): Promise<SessionRotateResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const chain = selectDefaultChain(options.env, options.chain)
    const network = resolveNetworkConfig(options.env, chain)
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
        const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
        const signedNetwork = {
            ...network,
            authSigner: createEthHttpSigner(decryptedRoot.rootPrivateKey, network.chainId),
        }

        let bundleId = intent.status === 'submitted' ? intent.bundleId : undefined
        let finalStatus: BundleStatusResponse | null = null

        if (intent.status === 'pending') {
            if (options.narrow && options.fullAccess) {
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
            let calls: Call[]
            if (options.narrow) {
                const permissions = getDefaultSessionPermissions(network.chainId, {
                    env: options.env,
                })
                const spend = permissions.find((permission) => permission.type === 'spend')
                if (!spend || spend.type !== 'spend') {
                    throw new SessionRotateError(
                        'ROTATION_FAILED',
                        'Narrow default session is missing a USDC spend limit.',
                    )
                }
                calls = [
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
                const permissionDefaults = buildPermissionDefaults({
                    fullAccess: options.fullAccess ?? false,
                    chain,
                    target: options.target,
                    selectors: options.selectors,
                    spendLimit: options.spendLimit,
                    spendPeriod: options.spendPeriod,
                })
                calls = [
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
                    },
                )
                bundleId = submission.id
                finalStatus = submission.finalStatus
                intent = await deps.writeRotationIntent(
                    keystorePath,
                    bundle.root.sessionRef.dir,
                    markRotationIntentSubmitted(intent, submission.id),
                    intent.fileName,
                )
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
        }
    })
}
