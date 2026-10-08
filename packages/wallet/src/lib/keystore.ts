import { AsyncLocalStorage } from 'node:async_hooks'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { access, chmod, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import argon2 from 'argon2'
import lockfile from 'proper-lockfile'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'

const ARGON2_MEMORY_COST = 19_456

const ARGON2_TIME_COST = 2

const ARGON2_PARALLELISM = 1

const ARGON2_HASH_LENGTH = 32

const ARGON2_SALT_LENGTH = 16

const AES_GCM_NONCE_LENGTH = 12

export type EncryptedSecret = {
    nonce: string
    ciphertext: string
    tag: string
}

export type KdfParams = {
    memoryCost: number
    timeCost: number
    parallelism: number
    hashLength: number
    salt: string
}

type KdfConfig = {
    name: 'argon2id'
    params: KdfParams
}

type NetworkConfig = {
    env: string
    relayerUrl: string
    rpcUrl: string
    chainId: number
}

type RootAddressConfig = {
    root: string
    delegated?: string
}

type SessionAddressConfig = {
    session: string
    delegated: string
}

const SESSION_NAME_REGEX = /^[A-Za-z0-9_-]+$/

type SessionCheckpoint = 'initialized' | 'authorized' | 'pending_rotation' | 'complete'

const SESSION_CHECKPOINTS: ReadonlySet<SessionCheckpoint> = new Set([
    'initialized',
    'authorized',
    'pending_rotation',
    'complete',
])

const ROOT_CHECKPOINTS: ReadonlySet<NonNullable<RelayerRootKeystoreV2['checkpoint']>> = new Set([
    'initialized',
    'delegated',
    'complete',
])

export type RelayerRootKeystoreV2 = {
    version: 2
    createdAt: string
    checkpoint?: 'initialized' | 'delegated' | 'complete'
    network: NetworkConfig
    addresses: RootAddressConfig
    sessionRef: {
        active: string
        dir: string
    }
    kdf: KdfConfig
    crypto: {
        algorithm: 'aes-256-gcm'
    }
    secrets: {
        rootPrivateKey: EncryptedSecret
    }
}

type SessionKeystoreBase = {
    version: 2
    createdAt: string
    name: string
    checkpoint: SessionCheckpoint
    network: NetworkConfig
    kdf: KdfConfig
    crypto: {
        algorithm: 'aes-256-gcm'
    }
    addresses: SessionAddressConfig
}

export type RelayerSessionKeystoreV2 = SessionKeystoreBase & {
    kind?: undefined
    secrets: {
        sessionPrivateKey: EncryptedSecret
    }
}

export type LoginSessionKeystoreV2 = SessionKeystoreBase & {
    kind: 'login'
    delegateAuth?: {
        sig: string
        expiryEpochMs: number
    }
    secrets: {
        sessionPrivateKey: EncryptedSecret
        bearerToken?: EncryptedSecret
    }
}

export type AgentSessionKeystoreV2 = SessionKeystoreBase & {
    kind: 'agent'
    secrets: {
        sessionPrivateKey: EncryptedSecret
        encryptionDevice: EncryptedSecret
    }
    namedChannels?: Record<
        string,
        {
            streamId: string
            secretHash: string
        }
    >
}

export type AnySessionKeystore =
    | RelayerSessionKeystoreV2
    | LoginSessionKeystoreV2
    | AgentSessionKeystoreV2

export type KeystoreBundle = {
    rootPath: string
    sessionPath: string
    root: RelayerRootKeystoreV2
    session: AnySessionKeystore
}

type CreateRootKeystoreInput = {
    password: string
    rootPrivateKey: Hex
    env: string
    relayerUrl: string
    rpcUrl: string
    chainId: number
    activeSession?: string
    sessionsDir?: string
}

type CreateSessionKeystoreBaseInput = {
    password: string
    sessionPrivateKey: Hex
    network: NetworkConfig
    delegated: string
    name?: string
    checkpoint?: SessionCheckpoint
}

type CreateSessionKeystoreInput = CreateSessionKeystoreBaseInput & {
    kind?: undefined
}

type CreateLoginSessionKeystoreInput = CreateSessionKeystoreBaseInput & {
    kind: 'login'
    delegateAuth?: LoginSessionKeystoreV2['delegateAuth']
    bearerToken?: Hex
}

type DecryptedRootKeystore = {
    rootPrivateKey: Hex
}

type DecryptedSessionKeystore = {
    sessionPrivateKey: Hex
}

async function deriveKey(password: string, params?: Partial<KdfParams>) {
    const salt =
        params?.salt !== undefined
            ? Buffer.from(params.salt, 'base64')
            : randomBytes(ARGON2_SALT_LENGTH)

    const derived = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: params?.memoryCost ?? ARGON2_MEMORY_COST,
        timeCost: params?.timeCost ?? ARGON2_TIME_COST,
        parallelism: params?.parallelism ?? ARGON2_PARALLELISM,
        hashLength: params?.hashLength ?? ARGON2_HASH_LENGTH,
        raw: true,
        salt,
    })

    return {
        key: Buffer.from(derived),
        params: {
            memoryCost: params?.memoryCost ?? ARGON2_MEMORY_COST,
            timeCost: params?.timeCost ?? ARGON2_TIME_COST,
            parallelism: params?.parallelism ?? ARGON2_PARALLELISM,
            hashLength: params?.hashLength ?? ARGON2_HASH_LENGTH,
            salt: salt.toString('base64'),
        },
    }
}

export async function deriveKeystoreKey(password: string, params: KdfParams): Promise<Buffer> {
    const { key } = await deriveKey(password, params)

    return key
}

export function encryptHexSecret(secret: Hex, key: Buffer): EncryptedSecret {
    const nonce = randomBytes(AES_GCM_NONCE_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const plaintext = Buffer.from(secret.slice(2), 'hex')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()

    return {
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: tag.toString('base64'),
    }
}

export function encryptBufferSecret(secret: Uint8Array, key: Buffer): EncryptedSecret {
    const nonce = randomBytes(AES_GCM_NONCE_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const plaintext = Buffer.from(secret)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()

    return {
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: tag.toString('base64'),
    }
}

export function decryptHexSecret(secret: EncryptedSecret, key: Buffer): Hex {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.nonce, 'base64'))
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))

    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext, 'base64')),
        decipher.final(),
    ])

    return `0x${plaintext.toString('hex')}` as Hex
}

export function decryptBufferSecret(secret: EncryptedSecret, key: Buffer): Uint8Array {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.nonce, 'base64'))
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))

    return Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext, 'base64')),
        decipher.final(),
    ])
}

export async function createRootKeystore(
    input: CreateRootKeystoreInput,
): Promise<RelayerRootKeystoreV2> {
    const { key, params } = await deriveKey(input.password)
    const rootAddress = privateKeyToAccount(input.rootPrivateKey).address

    const keystore: RelayerRootKeystoreV2 = {
        version: 2,
        createdAt: new Date().toISOString(),
        checkpoint: 'initialized',
        network: {
            env: input.env,
            relayerUrl: input.relayerUrl,
            rpcUrl: input.rpcUrl,
            chainId: input.chainId,
        },
        addresses: {
            root: rootAddress,
        },
        sessionRef: {
            active: input.activeSession ?? 'default',
            dir: input.sessionsDir ?? 'sessions',
        },
        kdf: {
            name: 'argon2id',
            params,
        },
        crypto: {
            algorithm: 'aes-256-gcm',
        },
        secrets: {
            rootPrivateKey: encryptHexSecret(input.rootPrivateKey, key),
        },
    }

    key.fill(0)

    return keystore
}

export function createSessionKeystore(
    input: CreateSessionKeystoreInput,
): Promise<RelayerSessionKeystoreV2>
export function createSessionKeystore(
    input: CreateLoginSessionKeystoreInput,
): Promise<LoginSessionKeystoreV2>
export async function createSessionKeystore(
    input: CreateSessionKeystoreInput | CreateLoginSessionKeystoreInput,
): Promise<AnySessionKeystore> {
    const { key, params } = await deriveKey(input.password)
    const sessionAddress = privateKeyToAccount(input.sessionPrivateKey).address

    const base: SessionKeystoreBase = {
        version: 2,
        createdAt: new Date().toISOString(),
        name: input.name ?? 'default',
        checkpoint: input.checkpoint ?? 'initialized',
        network: {
            env: input.network.env,
            relayerUrl: input.network.relayerUrl,
            rpcUrl: input.network.rpcUrl,
            chainId: input.network.chainId,
        },
        kdf: {
            name: 'argon2id',
            params,
        },
        crypto: {
            algorithm: 'aes-256-gcm',
        },
        addresses: {
            session: sessionAddress,
            delegated: input.delegated,
        },
    }

    if (input.kind === 'login') {
        const loginKeystore: LoginSessionKeystoreV2 = {
            ...base,
            kind: 'login',
            delegateAuth: input.delegateAuth,
            secrets: {
                sessionPrivateKey: encryptHexSecret(input.sessionPrivateKey, key),
                ...(input.bearerToken
                    ? { bearerToken: encryptHexSecret(input.bearerToken, key) }
                    : {}),
            },
        }

        key.fill(0)

        return loginKeystore
    }

    const keystore: RelayerSessionKeystoreV2 = {
        ...base,
        secrets: {
            sessionPrivateKey: encryptHexSecret(input.sessionPrivateKey, key),
        },
    }

    key.fill(0)

    return keystore
}

export async function decryptRootKeystore(
    keystore: RelayerRootKeystoreV2,
    password: string,
): Promise<DecryptedRootKeystore> {
    const { key } = await deriveKey(password, keystore.kdf.params)
    const rootPrivateKey = decryptHexSecret(keystore.secrets.rootPrivateKey, key)
    key.fill(0)

    return { rootPrivateKey }
}

export async function decryptSessionKeystore(
    keystore: AnySessionKeystore,
    password: string,
): Promise<DecryptedSessionKeystore> {
    const { key } = await deriveKey(password, keystore.kdf.params)
    const sessionPrivateKey = decryptHexSecret(keystore.secrets.sessionPrivateKey, key)
    key.fill(0)

    return { sessionPrivateKey }
}

export function isAgentKeystore(keystore: AnySessionKeystore): keystore is AgentSessionKeystoreV2 {
    if (typeof keystore !== 'object' || keystore === null) {
        return false
    }

    return keystore.kind === 'agent'
}

export function isLoginKeystore(keystore: AnySessionKeystore): keystore is LoginSessionKeystoreV2 {
    if (typeof keystore !== 'object' || keystore === null) {
        return false
    }

    return keystore.kind === 'login'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEncryptedSecret(value: unknown): value is EncryptedSecret {
    return (
        isRecord(value) &&
        typeof value.nonce === 'string' &&
        typeof value.ciphertext === 'string' &&
        typeof value.tag === 'string'
    )
}

function isKdfParams(value: unknown): value is KdfParams {
    return (
        isRecord(value) &&
        typeof value.memoryCost === 'number' &&
        typeof value.timeCost === 'number' &&
        typeof value.parallelism === 'number' &&
        typeof value.hashLength === 'number' &&
        typeof value.salt === 'string'
    )
}

function isKdfConfig(value: unknown): value is KdfConfig {
    return isRecord(value) && value.name === 'argon2id' && isKdfParams(value.params)
}

function isNetworkConfig(value: unknown): value is NetworkConfig {
    return (
        isRecord(value) &&
        typeof value.env === 'string' &&
        typeof value.relayerUrl === 'string' &&
        typeof value.rpcUrl === 'string' &&
        typeof value.chainId === 'number'
    )
}

function isSessionCheckpoint(value: unknown): value is SessionCheckpoint {
    return typeof value === 'string' && SESSION_CHECKPOINTS.has(value as SessionCheckpoint)
}

function validateAgentKeystore(
    keystore: Partial<AgentSessionKeystoreV2>,
    path: string,
): asserts keystore is AgentSessionKeystoreV2 {
    const encryptionDevice = keystore.secrets?.encryptionDevice

    if (
        typeof encryptionDevice?.nonce !== 'string' ||
        typeof encryptionDevice.ciphertext !== 'string' ||
        typeof encryptionDevice.tag !== 'string'
    ) {
        throw new Error(`Unsupported session keystore format at ${path}`)
    }

    if (keystore.namedChannels !== undefined) {
        if (typeof keystore.namedChannels !== 'object' || keystore.namedChannels === null) {
            throw new Error(`Unsupported session keystore format at ${path}`)
        }

        for (const [key, value] of Object.entries(keystore.namedChannels)) {
            if (typeof key !== 'string' || typeof value !== 'object' || value === null) {
                throw new Error(`Unsupported session keystore format at ${path}`)
            }

            const record = value as { streamId?: unknown; secretHash?: unknown }

            if (typeof record.streamId !== 'string' || typeof record.secretHash !== 'string') {
                throw new Error(`Unsupported session keystore format at ${path}`)
            }
        }
    }
}

function validateLoginKeystore(
    keystore: Partial<LoginSessionKeystoreV2>,
    path: string,
): asserts keystore is LoginSessionKeystoreV2 {
    if (keystore.delegateAuth !== undefined) {
        if (
            typeof keystore.delegateAuth !== 'object' ||
            keystore.delegateAuth === null ||
            typeof keystore.delegateAuth.sig !== 'string' ||
            typeof keystore.delegateAuth.expiryEpochMs !== 'number'
        ) {
            throw new Error(`Unsupported session keystore format at ${path}`)
        }
    }

    if (keystore.secrets?.bearerToken !== undefined) {
        const bearerToken = keystore.secrets.bearerToken

        if (
            typeof bearerToken?.nonce !== 'string' ||
            typeof bearerToken.ciphertext !== 'string' ||
            typeof bearerToken.tag !== 'string'
        ) {
            throw new Error(`Unsupported session keystore format at ${path}`)
        }
    }
}

export function isRootKeystoreV2(keystore: unknown): keystore is RelayerRootKeystoreV2 {
    if (!isRecord(keystore) || keystore.version !== 2) {
        return false
    }

    if (typeof keystore.createdAt !== 'string') {
        return false
    }

    if (
        keystore.checkpoint !== undefined &&
        !ROOT_CHECKPOINTS.has(
            keystore.checkpoint as NonNullable<RelayerRootKeystoreV2['checkpoint']>,
        )
    ) {
        return false
    }

    if (!isNetworkConfig(keystore.network)) {
        return false
    }

    if (
        !isRecord(keystore.addresses) ||
        typeof keystore.addresses.root !== 'string' ||
        (keystore.addresses.delegated !== undefined &&
            typeof keystore.addresses.delegated !== 'string')
    ) {
        return false
    }

    if (
        !isRecord(keystore.sessionRef) ||
        typeof keystore.sessionRef.active !== 'string' ||
        typeof keystore.sessionRef.dir !== 'string' ||
        !SESSION_NAME_REGEX.test(keystore.sessionRef.active) ||
        !SESSION_NAME_REGEX.test(keystore.sessionRef.dir)
    ) {
        return false
    }

    if (
        !isRecord(keystore.crypto) ||
        keystore.crypto.algorithm !== 'aes-256-gcm' ||
        !isKdfConfig(keystore.kdf) ||
        !isRecord(keystore.secrets) ||
        !isEncryptedSecret(keystore.secrets.rootPrivateKey)
    ) {
        return false
    }

    return true
}

export function resolveSessionKeystorePath(
    rootKeystorePath: string,
    sessionName = 'default',
    sessionsDir = 'sessions',
): string {
    assertValidSessionName(sessionName)
    assertValidSessionName(sessionsDir)

    return join(dirname(rootKeystorePath), sessionsDir, `${sessionName}.json`)
}

export class SessionOnlyProfileError extends Error {
    readonly sessionPath?: string
    readonly sessionKeystore?: AnySessionKeystore

    constructor(
        rootPath: string,
        options?: { sessionPath?: string; sessionKeystore?: AnySessionKeystore },
    ) {
        super(`This is a session-only profile. Root-keystore operations require ${rootPath}.`)
        this.name = 'SessionOnlyProfileError'
        this.sessionPath = options?.sessionPath
        this.sessionKeystore = options?.sessionKeystore
    }
}

export class LoginProfileError extends Error {
    readonly sessionPath?: string
    readonly sessionKeystore?: AnySessionKeystore

    constructor(options?: { sessionPath?: string; sessionKeystore?: AnySessionKeystore }) {
        super(
            'This is a login profile. Root-key operations require the web app, or use `tw account create` for a fully local profile.',
        )
        this.name = 'LoginProfileError'
        this.sessionPath = options?.sessionPath
        this.sessionKeystore = options?.sessionKeystore
    }
}

export async function readKeystoreBundle(rootPath: string): Promise<KeystoreBundle> {
    const { maybeRecoverPendingQuoteSpend } = await import('./quote-spend-lifecycle')
    await maybeRecoverPendingQuoteSpend(rootPath)

    return readKeystoreBundleNow(rootPath)
}

async function readKeystoreBundleNow(rootPath: string): Promise<KeystoreBundle> {
    let content: string

    try {
        content = await readFile(rootPath, 'utf8')
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'ENOENT'
        ) {
            const sessionOnlyPath = join(dirname(rootPath), 'session.json')

            try {
                const sessionOnlyKeystore = await readSessionKeystoreFile(sessionOnlyPath)

                if (isLoginKeystore(sessionOnlyKeystore)) {
                    throw new LoginProfileError({
                        sessionPath: sessionOnlyPath,
                        sessionKeystore: sessionOnlyKeystore,
                    })
                }

                throw new SessionOnlyProfileError(rootPath, {
                    sessionPath: sessionOnlyPath,
                    sessionKeystore: sessionOnlyKeystore,
                })
            } catch (sessionError) {
                if (
                    sessionError instanceof LoginProfileError ||
                    sessionError instanceof SessionOnlyProfileError
                ) {
                    throw sessionError
                }

                if (
                    typeof sessionError === 'object' &&
                    sessionError !== null &&
                    'code' in sessionError &&
                    (sessionError as { code?: unknown }).code === 'ENOENT'
                ) {
                    // Root keystore is missing and there is no session-only marker either.
                } else {
                    throw sessionError
                }
            }
        }

        throw error
    }

    let parsed: unknown

    try {
        parsed = JSON.parse(content) as unknown
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to parse keystore JSON at ${rootPath}: ${error.message}`)
        }

        throw error
    }

    if (isRootKeystoreV2(parsed)) {
        const sessionPath = resolveSessionKeystorePath(
            rootPath,
            parsed.sessionRef.active,
            parsed.sessionRef.dir,
        )

        const session = await readSessionKeystoreFile(sessionPath)

        return {
            rootPath,
            sessionPath,
            root: parsed,
            session,
        }
    }

    throw new Error(`Unsupported keystore format at ${rootPath}; expected version 2 split keystore`)
}

export async function readRootKeystoreFile(path: string): Promise<RelayerRootKeystoreV2> {
    const content = await readFile(path, 'utf8')

    return JSON.parse(content) as RelayerRootKeystoreV2
}

export async function readSessionKeystoreFile(path: string): Promise<AnySessionKeystore> {
    const content = await readFile(path, 'utf8')
    const parsed = JSON.parse(content) as unknown

    if (
        !isRecord(parsed) ||
        parsed.version !== 2 ||
        typeof parsed.name !== 'string' ||
        !isSessionCheckpoint(parsed.checkpoint) ||
        !isNetworkConfig(parsed.network) ||
        !isKdfConfig(parsed.kdf) ||
        !isRecord(parsed.crypto) ||
        parsed.crypto.algorithm !== 'aes-256-gcm' ||
        !isRecord(parsed.addresses) ||
        typeof parsed.addresses.session !== 'string' ||
        typeof parsed.addresses.delegated !== 'string' ||
        !isRecord(parsed.secrets) ||
        !isEncryptedSecret(parsed.secrets.sessionPrivateKey)
    ) {
        throw new Error(`Unsupported session keystore format at ${path}`)
    }

    const sessionKeystore = parsed as AnySessionKeystore

    if (sessionKeystore.kind === 'agent') {
        validateAgentKeystore(sessionKeystore, path)
    } else if (sessionKeystore.kind === 'login') {
        validateLoginKeystore(sessionKeystore, path)
    } else if ('kind' in sessionKeystore && sessionKeystore.kind !== undefined) {
        throw new Error(`Unsupported session keystore format at ${path}`)
    }

    assertValidSessionName(sessionKeystore.name)

    return sessionKeystore
}

type WriteJsonAtomicOptions = {
    overwrite?: boolean
    existsMessage: string
    emptyMessage: string
}

function isEnoent(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
    )
}

/**
 * Create `dir` as mode 0700, or tighten an existing real directory to 0700.
 * A symlink is refused. chmod would follow it and change the target.
 */
export async function ensureOwnerOnlyDirectory(dir: string): Promise<void> {
    if (process.platform !== 'win32') {
        try {
            const existing = await lstat(dir)

            if (existing.isSymbolicLink()) {
                throw new Error(
                    `Refusing to chmod ${dir}: it is a symlink. sessions/ must be a real directory.`,
                )
            }
        } catch (error) {
            if (!isEnoent(error)) throw error
        }
    }

    await mkdir(dir, { recursive: true, mode: 0o700 })

    if (process.platform === 'win32') return
    const info = await lstat(dir)

    if (info.isSymbolicLink()) {
        throw new Error(
            `Refusing to chmod ${dir}: it is a symlink. sessions/ must be a real directory.`,
        )
    }

    if ((info.mode & 0o777) !== 0o700) {
        await chmod(dir, 0o700)
    }
}

async function writeJsonAtomic(
    path: string,
    data: unknown,
    options: WriteJsonAtomicOptions,
): Promise<void> {
    const overwrite = options?.overwrite ?? false
    const directory = dirname(path)
    const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`

    await mkdir(directory, { recursive: true })

    if (!overwrite) {
        try {
            await access(path, constants.F_OK)
            throw new Error(options.existsMessage)
        } catch (error) {
            if (error instanceof Error && error.message.includes('already exists')) {
                throw error
            }

            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                (error as { code?: unknown }).code === 'ENOENT'
            ) {
                // Path does not exist yet, continue.
            } else {
                throw error
            }
        }
    }

    const payload = `${JSON.stringify(data, null, 2)}\n`
    await writeFile(tempPath, payload, { mode: 0o600 })
    await rename(tempPath, path)

    if (process.platform !== 'win32') {
        await chmod(path, 0o600)
    }

    const file = await stat(path)

    if (file.size === 0) {
        await unlink(path)
        throw new Error(options.emptyMessage)
    }
}

export async function writeRootKeystoreFile(
    path: string,
    keystore: RelayerRootKeystoreV2,
    options?: { overwrite?: boolean },
): Promise<void> {
    await writeJsonAtomic(path, keystore, {
        overwrite: options?.overwrite,
        existsMessage: `Keystore already exists at ${path}`,
        emptyMessage: `Refusing to keep empty keystore at ${path}`,
    })
}

export async function writeSessionKeystoreFile(
    path: string,
    keystore: AnySessionKeystore,
    options?: { overwrite?: boolean },
): Promise<void> {
    await ensureOwnerOnlyDirectory(dirname(path))
    await writeJsonAtomic(path, keystore, {
        overwrite: options?.overwrite,
        existsMessage: `Session keystore already exists at ${path}`,
        emptyMessage: `Refusing to keep empty session keystore at ${path}`,
    })
}

export function assertValidSessionName(name: string): void {
    if (!SESSION_NAME_REGEX.test(name)) {
        throw new Error(`Invalid session name "${name}". Use letters, numbers, "-" or "_" only.`)
    }
}

const keystoreLockDepth = new AsyncLocalStorage<number>()

type KeystoreLockOptions = {
    stale?: number
    retries?: {
        retries: number
        minTimeout?: number
        maxTimeout?: number
    }
}

export class KeystoreLockError extends Error {
    code = 'KEYSTORE_LOCKED' as const
    lockPath: string

    constructor(rootKeystorePath: string, cause?: unknown) {
        const lockPath = `${rootKeystorePath}.lock`
        super(
            `Keystore is locked at ${lockPath}. Retry shortly or remove stale lock if no process is running.`,
        )
        this.name = 'KeystoreLockError'
        this.lockPath = lockPath

        if (cause !== undefined) {
            ;(this as { cause?: unknown }).cause = cause
        }
    }
}

export async function withKeystoreLock<T>(
    rootKeystorePath: string,
    action: () => Promise<T>,
    lock: typeof lockfile.lock = lockfile.lock,
    options?: KeystoreLockOptions,
): Promise<T> {
    if ((keystoreLockDepth.getStore() ?? 0) > 0) {
        return action()
    }

    let release: (() => Promise<void>) | undefined

    try {
        release = await lock(rootKeystorePath, {
            lockfilePath: `${rootKeystorePath}.lock`,
            stale: options?.stale ?? 10_000,
            retries: options?.retries ?? {
                retries: 3,
                minTimeout: 100,
            },
        })
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'ENOENT'
        ) {
            throw error
        }

        throw new KeystoreLockError(rootKeystorePath, error)
    }

    let result: T | undefined
    let actionError: unknown

    try {
        result = await keystoreLockDepth.run(1, () => action())
    } catch (error) {
        actionError = error
    }

    if (release) {
        try {
            await release()
        } catch (releaseError) {
            if (actionError !== undefined) {
                throw actionError
            }

            throw releaseError
        }
    }

    if (actionError !== undefined) {
        throw actionError
    }

    return result as T
}
