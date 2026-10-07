import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import { chmod, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { encodeFunctionData, getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
    decodeIntentError,
    type GetKeysResponse,
    type BundleStatusResponse,
    type Call,
    type PrepareCallsResponse,
    type SpendPeriod,
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
    decryptSessionKeystore,
    ensureOwnerOnlyDirectory,
    readKeystoreBundle,
    type KdfParams,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    withKeystoreLock,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
    type AnySessionKeystore,
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
    isRotationMarkerFileName,
    normalizedDailyUsdcUnits,
    parseSessionName,
    ROTATION_MARKER_NAME,
    toSpendPeriodEnum,
} from './session-common'
import { generatePrivateKey } from 'viem/accounts'

type RotationPermissions =
    | { kind: 'narrow' }
    | { kind: 'fullAccess' }
    | {
          kind: 'custom'
          target: Address
          selectors: Hex[]
          spendLimit: string
          spendPeriod: SpendPeriod
      }

type RotationIntentBase = {
    oldSessionName: string
    newSessionName: string
    fileName: string
    chain: ChainName
    chainId: number
    newKeyHash: Hex
    narrow: boolean
    fullAccess: boolean
    /** Present on markers written by this code. Older markers omit it and are refused before signing. */
    account?: Address
    oldKeyHash?: Hex
    permissions?: RotationPermissions
    /** Password-derived HMAC. Older markers omit it and are refused before signing. */
    mac?: string
    macKdf?: KdfParams
}

type PendingRotationIntent = RotationIntentBase & {
    status: 'pending'
}

type SubmittedRotationIntent = RotationIntentBase & {
    status: 'submitted'
    /** Absent when the send may have been broadcast but no bundle id came back. */
    bundleId?: string
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
    | 'ROTATION_IN_PROGRESS'
    | 'ROTATION_PARTIAL'
    | 'ROTATION_SUBMITTED'
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
    onChain?: {
        newKeyAuthorized: boolean
        oldKeyLive: boolean
    }
    markerRemoved?: boolean
}

type SessionRotateDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    createSessionKeystore: typeof createSessionKeystore
    writeSessionKeystoreFile: typeof writeSessionKeystoreFile
    writeRootKeystoreFile: typeof writeRootKeystoreFile
    decryptRootKeystore: typeof decryptRootKeystore
    decryptSessionKeystore: typeof decryptSessionKeystore
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
        .filter((entry) => entry.isFile() && isRotationMarkerFileName(entry.name))
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
    const finalPath = join(dir, finalFileName)
    const tempPath = `${finalPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await ensureOwnerOnlyDirectory(dir)
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(tempPath, finalPath)
    if (process.platform !== 'win32') {
        await chmod(finalPath, 0o600)
    }
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

const SPEND_PERIODS = ['minute', 'hour', 'day', 'week', 'month', 'year', 'forever'] as const

function isSpendPeriod(value: unknown): value is SpendPeriod {
    return typeof value === 'string' && (SPEND_PERIODS as readonly string[]).includes(value)
}

function parseMarkerAccount(value: unknown): Address | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !isAddress(value)) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker account is not a valid address.',
        )
    }
    return getAddress(value)
}

function parseMarkerOldKeyHash(value: unknown): Hex | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker old key hash must be 0x followed by 64 hex characters.',
        )
    }
    return value as Hex
}

function parseRotationPermissions(value: unknown): RotationPermissions | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing its permissions.',
        )
    }
    const kind = (value as { kind?: unknown }).kind
    if (kind === 'narrow') return { kind: 'narrow' }
    if (kind === 'fullAccess') return { kind: 'fullAccess' }
    if (kind !== 'custom') {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing its permissions.',
        )
    }
    const custom = value as {
        target?: unknown
        selectors?: unknown
        spendLimit?: unknown
        spendPeriod?: unknown
    }
    if (typeof custom.target !== 'string' || !isAddress(custom.target)) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing its permissions.',
        )
    }
    if (!Array.isArray(custom.selectors) || custom.selectors.length === 0) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing its permissions.',
        )
    }
    const selectors: Hex[] = []
    for (const selector of custom.selectors) {
        if (typeof selector !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(selector)) {
            throw new SessionRotateError(
                'ROTATION_MARKER_MISMATCH',
                'Rotation marker is missing its permissions.',
            )
        }
        selectors.push(selector as Hex)
    }
    if (typeof custom.spendLimit !== 'string' || !/^\d+$/.test(custom.spendLimit)) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing its permissions.',
        )
    }
    if (!isSpendPeriod(custom.spendPeriod)) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing its permissions.',
        )
    }
    return {
        kind: 'custom',
        target: getAddress(custom.target),
        selectors,
        spendLimit: custom.spendLimit,
        spendPeriod: custom.spendPeriod,
    }
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
        account?: unknown
        oldKeyHash?: unknown
        permissions?: unknown
        mac?: unknown
        macKdf?: unknown
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
    if (typeof maybe.newKeyHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(maybe.newKeyHash)) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker newKeyHash must be 0x followed by 64 hex characters.',
        )
    }
    if (typeof maybe.narrow !== 'boolean' || typeof maybe.fullAccess !== 'boolean') {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing its permission flags.',
        )
    }
    const account = parseMarkerAccount(maybe.account)
    const oldKeyHash = parseMarkerOldKeyHash(maybe.oldKeyHash)
    const permissions = parseRotationPermissions(maybe.permissions)
    const mac = parseMarkerMac(maybe.mac)
    const macKdf = parseMarkerMacKdf(maybe.macKdf)
    const bound = {
        oldSessionName: maybe.oldSessionName,
        newSessionName: maybe.newSessionName,
        chain: maybe.chain,
        chainId: maybe.chainId,
        newKeyHash: maybe.newKeyHash as Hex,
        narrow: maybe.narrow,
        fullAccess: maybe.fullAccess,
        ...(account ? { account } : {}),
        ...(oldKeyHash ? { oldKeyHash } : {}),
        ...(permissions ? { permissions } : {}),
        ...(mac ? { mac } : {}),
        ...(macKdf ? { macKdf } : {}),
    }
    if (maybe.status === 'pending') {
        return { ...bound, status: 'pending' }
    }
    if (maybe.status === 'submitted') {
        if (typeof maybe.bundleId === 'string' && maybe.bundleId.length > 0) {
            return { ...bound, status: 'submitted', bundleId: maybe.bundleId }
        }
        if (maybe.bundleId === undefined || maybe.bundleId === '') {
            return { ...bound, status: 'submitted' }
        }
    }
    throw new Error('Invalid rotation intent payload.')
}

function parseMarkerMac(value: unknown): string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return undefined
    return value
}

function parseMarkerMacKdf(value: unknown): KdfParams | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const params = value as {
        memoryCost?: unknown
        timeCost?: unknown
        parallelism?: unknown
        hashLength?: unknown
        salt?: unknown
    }
    if (
        typeof params.memoryCost !== 'number' ||
        typeof params.timeCost !== 'number' ||
        typeof params.parallelism !== 'number' ||
        typeof params.hashLength !== 'number' ||
        typeof params.salt !== 'string' ||
        params.salt.length === 0
    ) {
        return undefined
    }
    return {
        memoryCost: params.memoryCost,
        timeCost: params.timeCost,
        parallelism: params.parallelism,
        hashLength: params.hashLength,
        salt: params.salt,
    }
}

const MARKER_MAC_KDF = {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
} as const

const MARKER_MAC_DOMAIN = 'towns-rotation-marker-v1'
const ROTATION_FRESHNESS_NAME = 'rotation-freshness'

function markerMacKdfAllowed(params: KdfParams): boolean {
    if (params.salt.length < 12 || params.salt.length > 88) return false
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(params.salt)) return false
    const salt = Buffer.from(params.salt, 'base64')
    return (
        Number.isInteger(params.memoryCost) &&
        params.memoryCost >= 1 &&
        params.memoryCost <= MARKER_MAC_KDF.memoryCost &&
        Number.isInteger(params.timeCost) &&
        params.timeCost >= 1 &&
        params.timeCost <= MARKER_MAC_KDF.timeCost &&
        params.parallelism === MARKER_MAC_KDF.parallelism &&
        params.hashLength === MARKER_MAC_KDF.hashLength &&
        salt.length >= 8 &&
        salt.length <= 64
    )
}

function assertMarkerMacKdfAllowed(params: KdfParams): void {
    if (markerMacKdfAllowed(params)) return
    throw new SessionRotateError(
        'ROTATION_MARKER_MISMATCH',
        'Rotation marker KDF parameters are not allowed. Refusing to derive a key.',
    )
}

async function deriveMarkerMacKey(password: string, params: KdfParams): Promise<Buffer> {
    assertMarkerMacKdfAllowed(params)
    const derived = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: params.memoryCost,
        timeCost: params.timeCost,
        parallelism: params.parallelism,
        hashLength: params.hashLength,
        raw: true,
        salt: Buffer.from(params.salt, 'base64'),
        associatedData: Buffer.from(MARKER_MAC_DOMAIN),
    })
    return Buffer.from(derived)
}

function canonicalPermissions(permissions: RotationPermissions | undefined): unknown {
    if (!permissions) return null
    if (permissions.kind !== 'custom') return { kind: permissions.kind }
    return {
        kind: 'custom',
        selectors: permissions.selectors.map((selector) => selector.toLowerCase()),
        spendLimit: permissions.spendLimit,
        spendPeriod: permissions.spendPeriod,
        target: permissions.target.toLowerCase(),
    }
}

/**
 * Canonical bytes for the marker HMAC. Authenticated fields are account,
 * oldKeyHash, newKeyHash, permissions, fullAccess, and newSessionName.
 * narrow, oldSessionName, chain, chainId, status, and bundleId are covered
 * too, so a local edit of any of them fails before resume signs.
 * freshness is the sidecar value, not a field stored in the marker, so
 * restoring an older marker file against a newer sidecar fails.
 */
function rotationMarkerMacBody(value: RotationIntentPayload, freshness: string | null): string {
    return JSON.stringify({
        account: value.account ? value.account.toLowerCase() : null,
        bundleId: value.status === 'submitted' ? (value.bundleId ?? null) : null,
        chain: value.chain,
        chainId: value.chainId,
        freshness,
        fullAccess: value.fullAccess,
        narrow: value.narrow,
        newKeyHash: value.newKeyHash.toLowerCase(),
        newSessionName: value.newSessionName,
        oldKeyHash: value.oldKeyHash ? value.oldKeyHash.toLowerCase() : null,
        oldSessionName: value.oldSessionName,
        permissions: canonicalPermissions(value.permissions),
        status: value.status,
    })
}

function markerMacMatches(expected: string, actual: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(actual)) return false
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
}

/** MAC the marker under an argon2id key derived from the keystore password. */
export async function sealRotationMarker<T extends RotationIntentPayload>(
    value: T,
    password: string,
    freshness: string | null = null,
): Promise<T & { mac: string; macKdf: KdfParams }> {
    const macKdf: KdfParams = value.macKdf ?? {
        ...MARKER_MAC_KDF,
        salt: randomBytes(16).toString('base64'),
    }
    const key = await deriveMarkerMacKey(password, macKdf)
    try {
        const mac = createHmac('sha256', key)
            .update(rotationMarkerMacBody(value, freshness))
            .digest('hex')
        return { ...value, mac, macKdf }
    } finally {
        key.fill(0)
    }
}

async function assertRotationMarkerMac(
    intent: RotationIntent,
    password: string,
    freshness: string | null,
): Promise<void> {
    if (!intent.mac || !intent.macKdf) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is not authenticated. Refusing to sign.',
        )
    }
    const sealed = await sealRotationMarker(intent, password, freshness)
    if (!markerMacMatches(sealed.mac, intent.mac)) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker authentication failed. Refusing to sign.',
        )
    }
}

function rotationFreshnessPath(rootKeystorePath: string, sessionsDir: string): string {
    const name = `${ROTATION_FRESHNESS_NAME}-${basename(rootKeystorePath, '.json')}`
    return join(rotationDir(rootKeystorePath, sessionsDir), name)
}

async function readRotationFreshness(
    rootKeystorePath: string,
    sessionsDir: string,
): Promise<string | null> {
    try {
        const raw = (await readFile(rotationFreshnessPath(rootKeystorePath, sessionsDir), 'utf8')).trim()
        if (!/^[0-9a-f]{32}$/.test(raw)) return null
        return raw
    } catch (error) {
        if (isEnoent(error)) return null
        throw error
    }
}

async function writeRotationFreshness(
    rootKeystorePath: string,
    sessionsDir: string,
): Promise<string> {
    const dir = rotationDir(rootKeystorePath, sessionsDir)
    await ensureOwnerOnlyDirectory(dir)
    const freshness = randomBytes(16).toString('hex')
    const finalPath = rotationFreshnessPath(rootKeystorePath, sessionsDir)
    const tempPath = `${finalPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await writeFile(tempPath, `${freshness}\n`, { mode: 0o600 })
    await rename(tempPath, finalPath)
    if (process.platform !== 'win32') {
        await chmod(finalPath, 0o600)
    }
    return freshness
}

async function sealBoundRotationMarker<T extends RotationIntentPayload>(
    rootKeystorePath: string,
    sessionsDir: string,
    value: T,
    password: string,
): Promise<T & { mac: string; macKdf: KdfParams }> {
    const freshness = await writeRotationFreshness(rootKeystorePath, sessionsDir)
    return sealRotationMarker(value, password, freshness)
}

function markRotationIntentSubmitted(
    intent: RotationIntent,
    bundleId?: string,
): SubmittedRotationIntentPayload {
    return {
        oldSessionName: intent.oldSessionName,
        newSessionName: intent.newSessionName,
        chain: intent.chain,
        chainId: intent.chainId,
        newKeyHash: intent.newKeyHash,
        narrow: intent.narrow,
        fullAccess: intent.fullAccess,
        ...(intent.account ? { account: intent.account } : {}),
        ...(intent.oldKeyHash ? { oldKeyHash: intent.oldKeyHash } : {}),
        ...(intent.permissions ? { permissions: intent.permissions } : {}),
        ...(intent.macKdf ? { macKdf: intent.macKdf } : {}),
        status: 'submitted',
        ...(bundleId ? { bundleId } : {}),
    }
}

function isPossiblySubmittedRotation(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { rotationPossiblySubmitted?: unknown }).rotationPossiblySubmitted === true
    )
}

async function defaultDeleteRotationIntent(
    rootKeystorePath: string,
    sessionsDir: string,
    fileName: string,
): Promise<void> {
    await unlink(join(rotationDir(rootKeystorePath, sessionsDir), fileName))
    await unlink(rotationFreshnessPath(rootKeystorePath, sessionsDir)).catch((error) => {
        if (!isEnoent(error)) throw error
    })
}

function getDefaultDeps(): SessionRotateDeps {
    return {
        readKeystoreBundle,
        readSessionKeystoreFile,
        createSessionKeystore,
        writeSessionKeystoreFile,
        writeRootKeystoreFile,
        decryptRootKeystore,
        decryptSessionKeystore,
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

function isBundleWaitTimeout(error: unknown): boolean {
    return error instanceof Error && error.message.includes('Timeout waiting for bundle')
}

function bundleWaitTimeoutId(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'bundleId' in error) {
        const id = (error as { bundleId?: unknown }).bundleId
        if (typeof id === 'string' && id.length > 0) return id
    }
    if (!(error instanceof Error)) return undefined
    const match = error.message.match(/Timeout waiting for bundle (\S+) to reach final status/)
    return match?.[1]
}

function rotationSubmittedError(bundleId: string | undefined, timedOut = false): SessionRotateError {
    const which = bundleId ? `bundle ${bundleId} ` : ''
    const why = timedOut ? 'confirmation timed out' : 'confirmation did not finish'
    return new SessionRotateError(
        'ROTATION_SUBMITTED',
        `Session rotation ${which}was submitted, but ${why}. The new session file was kept. Resume with \`tw session rotate --resume\`.`,
        {
            recoveryCommand: 'tw session rotate --resume',
            details: bundleId ? { bundleId } : undefined,
        },
    )
}

function requireRotateFullAccessPhrase(
    fullAccess: boolean,
    confirmed: boolean | undefined,
    resumed: boolean,
): void {
    if (!fullAccess || confirmed) return
    const rerun = resumed
        ? ' Re-run `tw session rotate --resume --full-access` and type the phrase when prompted.'
        : ''
    throw new HumanConfirmationError(
        `${humanConfirmationMessage(
            'Rotating to a full-access session',
            CONFIRM_ROTATE_FULL_ACCESS_PHRASE,
        )}${rerun}`,
    )
}

function requireMarkerBinding(intent: RotationIntent): asserts intent is RotationIntent & {
    account: Address
    oldKeyHash: Hex
    permissions: RotationPermissions
} {
    if (!intent.account) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing the account.',
        )
    }
    if (!intent.oldKeyHash) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing the old key hash.',
        )
    }
    if (!intent.permissions) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker is missing its permissions.',
        )
    }
    if (intent.permissions.kind === 'fullAccess' && intent.fullAccess !== true) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker permissions do not match its full-access flag.',
        )
    }
    if (intent.permissions.kind === 'narrow' && intent.narrow !== true) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker permissions do not match its narrow flag.',
        )
    }
    if (intent.permissions.kind === 'custom' && (intent.narrow || intent.fullAccess)) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Rotation marker permissions do not match its permission flags.',
        )
    }
}

function isEnoent(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
    )
}

function hashListed(keys: { hash?: string }[], hash: string | undefined): boolean {
    if (!hash) return false
    const needle = hash.toLowerCase()
    return keys.some(
        (entry) => typeof entry.hash === 'string' && entry.hash.toLowerCase() === needle,
    )
}

async function requireDecryptedSessionAddress(
    deps: SessionRotateDeps,
    session: AnySessionKeystore,
    password: string,
): Promise<Address> {
    let decrypted: { sessionPrivateKey: Hex }
    try {
        decrypted = await deps.decryptSessionKeystore(session, password)
    } catch (error) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Could not decrypt the session key. Refusing to authorize or revoke.',
            { cause: error },
        )
    }
    const derived = privateKeyToAccount(decrypted.sessionPrivateKey).address
    const claimed = getAddress(session.addresses.session)
    if (derived.toLowerCase() !== claimed.toLowerCase()) {
        throw new SessionRotateError(
            'ROTATION_MARKER_MISMATCH',
            'Session file address does not match the decrypted session key. Refusing to authorize or revoke.',
        )
    }
    return derived
}

function resolveRotationPermissions(
    options: {
        narrow?: boolean
        fullAccess?: boolean
        target?: Address
        selectors?: Hex[]
        spendLimit?: bigint
        spendPeriod?: SpendPeriod
    },
    chain: ChainName,
): RotationPermissions {
    const narrow = options.narrow === true
    const fullAccess = options.fullAccess === true
    if (narrow && fullAccess) {
        throw new SessionRotateError(
            'ROTATION_FAILED',
            '--narrow cannot be combined with full access.',
        )
    }
    if (narrow) return { kind: 'narrow' }
    if (fullAccess) return { kind: 'fullAccess' }
    const defaults = buildPermissionDefaults({
        fullAccess: false,
        chain,
        target: options.target,
        selectors: options.selectors,
        spendLimit: options.spendLimit,
        spendPeriod: options.spendPeriod,
    })
    return {
        kind: 'custom',
        target: defaults.target,
        selectors: defaults.selectors,
        spendLimit: defaults.spendLimit.toString(),
        spendPeriod: defaults.spendPeriod,
    }
}

type StoredPermissionDefaults = {
    target: Address
    selectors: Hex[]
    spendToken: Address
    spendLimit: bigint
    spendPeriod: SpendPeriod
}

function storedPermissionDefaults(
    permissions: RotationPermissions,
    chain: ChainName,
): StoredPermissionDefaults | undefined {
    if (permissions.kind === 'narrow') return undefined
    if (permissions.kind === 'fullAccess') {
        return buildPermissionDefaults({ fullAccess: true, chain })
    }
    return {
        target: permissions.target,
        selectors: permissions.selectors,
        spendToken: getUsdcTokenConfig(chain).address,
        spendLimit: BigInt(permissions.spendLimit),
        spendPeriod: permissions.spendPeriod,
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
        /** Set only after ROTATE FULL ACCESS SESSION was typed. */
        fullAccessPhraseConfirmed?: boolean
        /** Report on-chain keys, then remove the marker. Does not sign. */
        abandon?: boolean
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
        await ensureOwnerOnlyDirectory(rotationDir(keystorePath, bundle.root.sessionRef.dir))
        const oldSession = await deps.readSessionKeystoreFile(oldSessionPath)
        let oldKeyHash = computeSessionKeyHash(getAddress(oldSession.addresses.session))

        let intent = await deps.readRotationIntent(keystorePath, bundle.root.sessionRef.dir)
        let resumed = false

        if (options.abandon) {
            if (options.resume) {
                throw new SessionRotateError(
                    'ROTATION_FAILED',
                    '--abandon cannot be combined with --resume.',
                )
            }
            if (!intent) {
                throw new SessionRotateError('ROTATION_FAILED', 'No rotation marker to abandon.')
            }
            try {
                await assertRotationMarkerMac(
                    intent,
                    options.password,
                    await readRotationFreshness(keystorePath, bundle.root.sessionRef.dir),
                )
            } catch (error) {
                if (error instanceof SessionRotateError && error.code === 'ROTATION_MARKER_MISMATCH') {
                    throw new SessionRotateError(
                        'ROTATION_MARKER_MISMATCH',
                        'Rotation marker is unverified. Refusing to abandon it or to report on-chain keys from it. Nothing was signed. Delete the marker file only after you have checked the chain yourself.',
                        { cause: error },
                    )
                }
                throw error
            }
            const reportNetwork = resolveNetworkConfig(options.env, intent.chain)
            const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
            const signedNetwork = {
                ...reportNetwork,
                authSigner: createEthHttpSigner(decryptedRoot.rootPrivateKey, reportNetwork.chainId),
            }
            const keysNow = await deps.getKeys({
                network: signedNetwork,
                account: accountAddress,
                chainId: intent.chainId,
            })
            const present = getChainKeys(keysNow, intent.chainId)
            const newKeyAuthorized = hashListed(present, intent.newKeyHash)
            const oldKeyLive = hashListed(present, intent.oldKeyHash)
            await deps.deleteRotationIntent(
                keystorePath,
                bundle.root.sessionRef.dir,
                intent.fileName,
            )
            return {
                type: 'session_rotate',
                status: 'complete',
                resumed: false,
                keystorePath,
                network: reportNetwork,
                accountAddress,
                oldSessionName: intent.oldSessionName,
                newSessionName: intent.newSessionName,
                oldSessionPath,
                newSessionPath: resolveSessionKeystorePath(
                    keystorePath,
                    intent.newSessionName,
                    bundle.root.sessionRef.dir,
                ),
                bundle: { id: 'abandoned', status: 'marker-removed', statusCode: 0 },
                onChain: { newKeyAuthorized, oldKeyLive },
                markerRemoved: true,
            }
        }

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

        if (intent && !options.resume) {
            throw new SessionRotateError(
                'ROTATION_IN_PROGRESS',
                'A session rotation is already in progress. Resume with `tw session rotate --resume`, or remove the marker with `tw session rotate --abandon` after you check the chain.',
                { recoveryCommand: 'tw session rotate --resume' },
            )
        }

        if (!intent || !options.resume) {
            const activeDerived = await requireDecryptedSessionAddress(
                deps,
                oldSession,
                options.password,
            )
            oldKeyHash = computeSessionKeyHash(activeDerived)
            const permissions = resolveRotationPermissions(options, chain)
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
            intent = await deps.writeRotationIntent(
                keystorePath,
                bundle.root.sessionRef.dir,
                await sealBoundRotationMarker(
                    keystorePath,
                    bundle.root.sessionRef.dir,
                    {
                        oldSessionName: activeSessionName,
                        newSessionName,
                        status: 'pending',
                        chain,
                        chainId: network.chainId,
                        newKeyHash: computeSessionKeyHash(getAddress(newSession.addresses.session)),
                        narrow: options.narrow === true,
                        fullAccess: options.fullAccess === true,
                        account: accountAddress,
                        oldKeyHash,
                        permissions,
                    },
                    options.password,
                ),
            )
        } else {
            resumed = true
        }

        const newSessionPath = resolveSessionKeystorePath(
            keystorePath,
            intent.newSessionName,
            bundle.root.sessionRef.dir,
        )
        let newSession: AnySessionKeystore
        try {
            newSession = await deps.readSessionKeystoreFile(newSessionPath)
        } catch (error) {
            if (resumed && isEnoent(error)) {
                await assertRotationMarkerMac(
                intent,
                options.password,
                await readRotationFreshness(keystorePath, bundle.root.sessionRef.dir),
            )
                const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
                const signedNetwork = {
                    ...network,
                    authSigner: createEthHttpSigner(decryptedRoot.rootPrivateKey, network.chainId),
                }
                const keysNow = await deps.getKeys({
                    network: signedNetwork,
                    account: accountAddress,
                    chainId: network.chainId,
                })
                const present = getChainKeys(keysNow, network.chainId)
                const newAuthorized = hashListed(present, intent.newKeyHash)
                const oldKnown = typeof intent.oldKeyHash === 'string'
                const oldLive = oldKnown && hashListed(present, intent.oldKeyHash)
                const newText = newAuthorized ? 'authorized' : 'not authorized'
                const oldText = !oldKnown
                    ? 'not loaded from this marker'
                    : oldLive
                      ? 'still live'
                      : 'not live'
                const next =
                    !newAuthorized && oldLive
                        ? 'The new key is not on chain and the old key is still live. After you confirm that, remove the rotation marker and start a new rotation. Nothing was signed.'
                        : newAuthorized && oldKnown && !oldLive
                          ? 'The new key is authorized and the old key is not live, but the new session file is gone so this wallet cannot use that key. Nothing was signed.'
                          : newAuthorized && oldLive
                            ? 'Both keys are still on chain. Restore the missing session file before resuming. Nothing was signed.'
                            : 'Nothing was signed.'
                throw new SessionRotateError(
                    'ROTATION_VERIFICATION_FAILED',
                    `The new session file ${intent.newSessionName} is missing, so this rotation cannot sign. On-chain, the new key is ${newText} and the old key is ${oldText}. ${next}`,
                    { recoveryCommand: 'tw session rotate --resume' },
                )
            }
            throw error
        }
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
            requireMarkerBinding(intent)
            if (getAddress(intent.account) !== accountAddress) {
                throw new SessionRotateError(
                    'ROTATION_MARKER_MISMATCH',
                    'Rotation marker account does not match this keystore.',
                )
            }
        }
        const newDerived = await requireDecryptedSessionAddress(deps, newSession, options.password)
        if (computeSessionKeyHash(newDerived).toLowerCase() !== newKeyHash.toLowerCase()) {
            throw new SessionRotateError(
                'ROTATION_MARKER_MISMATCH',
                'Session file address does not match the decrypted session key. Refusing to authorize or revoke.',
            )
        }
        if (resumed && activeSessionName === intent.newSessionName) {
            requireRotateFullAccessPhrase(intent.fullAccess, options.fullAccessPhraseConfirmed, true)
            const previousSessionPath = resolveSessionKeystorePath(
                keystorePath,
                intent.oldSessionName,
                bundle.root.sessionRef.dir,
            )
            let previousSession: AnySessionKeystore
            try {
                previousSession = await deps.readSessionKeystoreFile(previousSessionPath)
            } catch (error) {
                if (isEnoent(error)) {
                    throw new SessionRotateError(
                        'ROTATION_VERIFICATION_FAILED',
                        'The previous session file is missing, so this rotation cannot finish cleanup. The marker was kept. Nothing was signed.',
                        { recoveryCommand: 'tw session rotate --resume' },
                    )
                }
                throw error
            }
            const previousDerived = await requireDecryptedSessionAddress(
                deps,
                previousSession,
                options.password,
            )
            const previousHash = computeSessionKeyHash(previousDerived)
            if (previousHash.toLowerCase() !== intent.oldKeyHash!.toLowerCase()) {
                throw new SessionRotateError(
                    'ROTATION_MARKER_MISMATCH',
                    'Rotation marker old key does not match the previous session file. Refusing to delete it.',
                )
            }
            await assertRotationMarkerMac(
                intent,
                options.password,
                await readRotationFreshness(keystorePath, bundle.root.sessionRef.dir),
            )
            const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
            const signedNetwork = {
                ...network,
                authSigner: createEthHttpSigner(decryptedRoot.rootPrivateKey, network.chainId),
            }
            const keysNow = await deps.getKeys({
                network: signedNetwork,
                account: accountAddress,
                chainId: network.chainId,
            })
            const present = getChainKeys(keysNow, network.chainId)
            if (!hashListed(present, newKeyHash)) {
                throw new SessionRotateError(
                    'ROTATION_VERIFICATION_FAILED',
                    'Rotation confirmation failed on-chain verification.',
                    { recoveryCommand: 'tw session list --on-chain --json' },
                )
            }
            if (hashListed(present, intent.oldKeyHash)) {
                throw new SessionRotateError(
                    'ROTATION_VERIFICATION_FAILED',
                    'The previous session key is still authorized on chain. The session file was kept. Nothing was signed.',
                    { recoveryCommand: 'tw session rotate --resume' },
                )
            }
            await deps.writeSessionKeystoreFile(
                newSessionPath,
                { ...newSession, checkpoint: 'authorized' },
                { overwrite: true },
            )
            await deps.deleteRotationIntent(
                keystorePath,
                bundle.root.sessionRef.dir,
                intent.fileName,
            )
            if (previousSessionPath !== newSessionPath) {
                await deps.unlink(previousSessionPath)
            }
            const finishedId =
                intent.status === 'submitted'
                    ? (intent.bundleId ?? 'already-complete')
                    : 'already-complete'
            return {
                type: 'session_rotate',
                status: 'complete',
                resumed: true,
                keystorePath,
                network,
                accountAddress,
                oldSessionName: intent.oldSessionName,
                newSessionName: intent.newSessionName,
                oldSessionPath: previousSessionPath,
                newSessionPath,
                bundle: {
                    id: finishedId,
                    status: 'already-complete',
                    statusCode: 200,
                },
            }
        }
        requireMarkerBinding(intent)
        const activeDerived = await requireDecryptedSessionAddress(deps, oldSession, options.password)
        oldKeyHash = computeSessionKeyHash(activeDerived)
        if (oldKeyHash.toLowerCase() !== intent.oldKeyHash.toLowerCase()) {
            throw new SessionRotateError(
                'ROTATION_MARKER_MISMATCH',
                'Rotation marker old key does not match the active session. Refusing to revoke.',
            )
        }
        requireRotateFullAccessPhrase(
            intent.fullAccess,
            options.fullAccessPhraseConfirmed,
            resumed,
        )
        if (resumed) {
            await assertRotationMarkerMac(
                intent,
                options.password,
                await readRotationFreshness(keystorePath, bundle.root.sessionRef.dir),
            )
        }
        const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
        const signedNetwork = {
            ...network,
            authSigner: createEthHttpSigner(decryptedRoot.rootPrivateKey, network.chainId),
        }

        let bundleId = intent.status === 'submitted' ? intent.bundleId : undefined
        let finalStatus: BundleStatusResponse | null = null

        if (intent.status === 'submitted' && !intent.bundleId) {
            const keysNow = await deps.getKeys({
                network: signedNetwork,
                account: accountAddress,
                chainId: network.chainId,
            })
            const present = getChainKeys(keysNow, network.chainId)
            const hasNew = hashListed(present, intent.newKeyHash)
            const hasOld = hashListed(present, intent.oldKeyHash)
            if (!(hasNew && !hasOld)) {
                throw new SessionRotateError(
                    'ROTATION_SUBMITTED',
                    'Session rotation may already be submitted, but getKeys does not show the new key as the only authorized key. Nothing was signed. Resume with `tw session rotate --resume`.',
                    { recoveryCommand: 'tw session rotate --resume' },
                )
            }
            bundle.root.sessionRef.active = intent.newSessionName
            await deps.writeRootKeystoreFile(keystorePath, bundle.root, { overwrite: true })
            await deps.writeSessionKeystoreFile(
                newSessionPath,
                { ...newSession, checkpoint: 'authorized' },
                { overwrite: true },
            )
            await deps.deleteRotationIntent(
                keystorePath,
                bundle.root.sessionRef.dir,
                intent.fileName,
            )
            if (!hashListed(present, oldKeyHash)) {
                await deps.unlink(oldSessionPath).catch(() => undefined)
            }
            return {
                type: 'session_rotate',
                status: 'complete',
                resumed: true,
                keystorePath,
                network,
                accountAddress,
                oldSessionName: intent.oldSessionName,
                newSessionName: intent.newSessionName,
                oldSessionPath,
                newSessionPath,
                bundle: { id: 'chain-settled', status: 'confirmed', statusCode: 200 },
            }
        }

        let feeCap: ExecuteSignedCallsResult['feeCap'] | undefined
        let extraCleanups: { chainName: ChainName; calls: Call[] }[] = []

        if (intent.status === 'pending') {
            const narrow = intent.permissions!.kind === 'narrow'
            const fullAccess = intent.permissions!.kind === 'fullAccess'
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
            const permissionDefaults = storedPermissionDefaults(intent.permissions!, chain)
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
                        onBundleSubmitted: async (id) => {
                            intent = await deps.writeRotationIntent(
                                keystorePath,
                                bundle.root.sessionRef.dir,
                                await sealBoundRotationMarker(
                                    keystorePath,
                                    bundle.root.sessionRef.dir,
                                    markRotationIntentSubmitted(intent, id),
                                    options.password,
                                ),
                                intent.fileName,
                            )
                        },
                    },
                )
                bundleId = submission.id
                finalStatus = submission.finalStatus
                feeCap = submission.feeCap
            } catch (error) {
                const submittedId =
                    bundleWaitTimeoutId(error) ??
                    (intent.status === 'submitted' ? intent.bundleId : undefined)
                if (submittedId || isPossiblySubmittedRotation(error)) {
                    if (intent.status !== 'submitted' || intent.bundleId !== submittedId) {
                        intent = await deps.writeRotationIntent(
                            keystorePath,
                            bundle.root.sessionRef.dir,
                            await sealBoundRotationMarker(
                                keystorePath,
                                bundle.root.sessionRef.dir,
                                markRotationIntentSubmitted(intent, submittedId),
                                options.password,
                            ),
                            intent.fileName,
                        )
                    }
                    throw rotationSubmittedError(submittedId, isBundleWaitTimeout(error))
                }
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
                await sealBoundRotationMarker(
                    keystorePath,
                    bundle.root.sessionRef.dir,
                    markRotationIntentSubmitted(intent, bundleId),
                    options.password,
                ),
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

        if (intent.status === 'submitted' && intent.bundleId && !finalStatus) {
            try {
                finalStatus = await deps.waitForBundle({
                    network: signedNetwork,
                    id: intent.bundleId,
                })
            } catch (error) {
                throw rotationSubmittedError(intent.bundleId, isBundleWaitTimeout(error))
            }
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
                `${finalStatus?.error ?? 'Session rotation did not complete successfully.'} The rotation marker was kept. After you check the chain, remove it with \`tw session rotate --abandon\`.`,
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
            if (!options.fullAccessPhraseConfirmed && !intent.fullAccess && intent.permissions) {
                const permissions =
                    intent.permissions.kind === 'narrow'
                        ? getDefaultSessionPermissions(network.chainId, { env: options.env })
                        : undefined
                const defaults = storedPermissionDefaults(intent.permissions, chain)
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
