import { access, mkdir, readdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { BearerTokenSchema, WalletSessionTokenSchema } from '@nubl/proto'
import { getAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getDefaultKeystorePath } from './account-create'
import {
    createSessionKeystore,
    isLoginKeystore,
    readSessionKeystoreFile,
    writeSessionKeystoreFile,
} from './keystore'
import { isMissingFileError } from './fs-utils'
import { getChainNameByChainId, resolveNetworkConfig, type EnvName } from './network-config'

/** Browser login URL. Unset means `tw login` cannot open a page. Local payments do not use this. */
export function getAuthUrl(env: EnvName): string | undefined {
    const key = env === 'prod' ? 'AUTH_URL_PROD' : env === 'stage' ? 'AUTH_URL_STAGE' : 'AUTH_URL_DEV'
    const value = process.env[key]?.trim()
    return value || undefined
}

export function authUrlUnsetMessage(env: EnvName): string {
    const key = env === 'prod' ? 'AUTH_URL_PROD' : env === 'stage' ? 'AUTH_URL_STAGE' : 'AUTH_URL_DEV'
    return `Login URL is unset. Set ${key} to the browser auth URL for the ${env} environment.`
}

type LoginErrorCode =
    | 'INVALID_TOKEN'
    | 'TOKEN_EXPIRED'
    | 'PROFILE_CONFLICT'
    | 'UNSUPPORTED_CHAIN'
    | 'NOT_LOGIN_PROFILE'
    | 'LOGIN_FAILED'

export class LoginError extends Error {
    code: LoginErrorCode
    cause?: unknown

    constructor(code: LoginErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'LoginError'
        this.code = code
        this.cause = options?.cause
    }
}

export type LoginOptions = {
    tokenHex: string
    profile: string
    env: EnvName
    password: string
}

export type LoginResult = {
    type: 'login'
    status: 'complete'
    profile: string
    profileDir: string
    accountAddress: string
    sessionAddress: string
    chainId: number
    expiryEpochMs: number
}

export type LogoutOptions = {
    profile: string
    env: EnvName
}

export type LogoutResult = {
    type: 'logout'
    status: 'complete'
    profile: string
    warning: string
}

type LoginDeps = {
    createSessionKeystore: typeof createSessionKeystore
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    writeSessionKeystoreFile: typeof writeSessionKeystoreFile
    access: (path: string, mode?: number) => Promise<void>
    mkdir: (path: string, options?: { recursive?: boolean }) => Promise<string | undefined>
    readdir: (path: string) => Promise<string[]>
    rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>
}

function getDefaultDeps(): LoginDeps {
    return {
        createSessionKeystore,
        readSessionKeystoreFile,
        writeSessionKeystoreFile,
        access: (path, mode = constants.F_OK) => access(path, mode),
        mkdir: (path, options) => mkdir(path, options),
        readdir: (path) => readdir(path),
        rm: (path, options) => rm(path, options),
    }
}

function parseHexToBytes(value: string): Uint8Array {
    const normalized = value.trim().startsWith('0x') ? value.trim().slice(2) : value.trim()
    if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
        throw new LoginError('INVALID_TOKEN', 'Invalid token format. Paste the full hex token.')
    }
    return Uint8Array.from(Buffer.from(normalized, 'hex'))
}

function bytesToHex(bytes: Uint8Array): Hex {
    return `0x${Buffer.from(bytes).toString('hex')}` as Hex
}

function toSafeNumber(value: bigint, field: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new LoginError('INVALID_TOKEN', `${field} is out of supported range.`)
    }
    return Number(value)
}

function decodeWalletSessionToken(input: { tokenHex: string; env: EnvName }) {
    let decoded
    try {
        decoded = fromBinary(WalletSessionTokenSchema, parseHexToBytes(input.tokenHex))
    } catch (error) {
        throw new LoginError('INVALID_TOKEN', 'Invalid token format. Generate a new login token.', {
            cause: error,
        })
    }

    if (decoded.sessionPrivateKey.length !== 32) {
        throw new LoginError('INVALID_TOKEN', 'Invalid token: session private key is malformed.')
    }
    if (decoded.accountAddress.length !== 20) {
        throw new LoginError('INVALID_TOKEN', 'Invalid token: account address is malformed.')
    }
    if (decoded.delegateSig.length === 0) {
        throw new LoginError('INVALID_TOKEN', 'Invalid token: missing delegate signature.')
    }
    if (!decoded.bearerToken) {
        throw new LoginError('INVALID_TOKEN', 'Invalid token: missing bearer token.')
    }

    const chainId = toSafeNumber(decoded.chainId, 'chain_id')
    if (chainId <= 0) {
        throw new LoginError('INVALID_TOKEN', 'Invalid token: chain_id must be positive.')
    }
    const chainName = getChainNameByChainId(chainId)
    if (!chainName) {
        throw new LoginError(
            'UNSUPPORTED_CHAIN',
            `Unsupported chain_id ${chainId}. Use a token generated for a supported chain.`,
        )
    }

    const expiryEpochMs = toSafeNumber(decoded.expiryEpochMs, 'expiry_epoch_ms')
    if (expiryEpochMs <= Date.now()) {
        throw new LoginError('TOKEN_EXPIRED', 'Token has expired. Generate a new login token.')
    }

    const delegateExpiryEpochMs = toSafeNumber(
        decoded.delegateExpiryEpochMs,
        'delegate_expiry_epoch_ms',
    )
    if (delegateExpiryEpochMs <= 0) {
        throw new LoginError('INVALID_TOKEN', 'Invalid token: delegate expiry is missing.')
    }
    if (delegateExpiryEpochMs <= Date.now()) {
        throw new LoginError('TOKEN_EXPIRED', 'Token has expired. Generate a new login token.')
    }

    const accountAddress = getAddress(bytesToHex(decoded.accountAddress))
    const sessionPrivateKey = bytesToHex(decoded.sessionPrivateKey)
    const sessionAddress = privateKeyToAccount(sessionPrivateKey).address
    const bearerToken = bytesToHex(toBinary(BearerTokenSchema, decoded.bearerToken))
    const delegateSig = bytesToHex(decoded.delegateSig)
    const network = resolveNetworkConfig(input.env, chainName)

    return {
        accountAddress,
        sessionAddress,
        sessionPrivateKey,
        chainId,
        expiryEpochMs,
        delegateSig,
        delegateExpiryEpochMs,
        bearerToken,
        network,
    }
}

function resolveProfilePaths(
    env: EnvName,
    profile: string,
): {
    profileDir: string
    rootPath: string
    sessionPath: string
} {
    const profileDir = dirname(getDefaultKeystorePath(env, profile))
    return {
        profileDir,
        rootPath: join(profileDir, 'default.keystore.json'),
        sessionPath: join(profileDir, 'session.json'),
    }
}

export async function executeLogin(
    options: LoginOptions,
    depsArg?: Partial<LoginDeps>,
): Promise<LoginResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const decoded = decodeWalletSessionToken({ tokenHex: options.tokenHex, env: options.env })
    const { profileDir, rootPath, sessionPath } = resolveProfilePaths(options.env, options.profile)

    try {
        await deps.mkdir(profileDir, { recursive: true })

        try {
            await deps.access(rootPath, constants.F_OK)
            throw new LoginError(
                'PROFILE_CONFLICT',
                'Profile has a root keystore. Use a different --profile name.',
            )
        } catch (error) {
            if (error instanceof LoginError) {
                throw error
            }
            if (!isMissingFileError(error)) {
                throw error
            }
        }

        let overwrite = false
        try {
            const existing = await deps.readSessionKeystoreFile(sessionPath)
            if (!isLoginKeystore(existing)) {
                throw new LoginError(
                    'PROFILE_CONFLICT',
                    'Profile has an imported session. Use a different --profile name.',
                )
            }
            overwrite = true
        } catch (error) {
            if (error instanceof LoginError) {
                throw error
            }
            if (!isMissingFileError(error)) {
                throw error
            }
        }

        const sessionKeystore = await deps.createSessionKeystore({
            password: options.password,
            sessionPrivateKey: decoded.sessionPrivateKey,
            network: {
                env: decoded.network.env,
                relayerUrl: decoded.network.relayerUrl,
                rpcUrl: decoded.network.rpcUrl,
                chainId: decoded.network.chainId,
            },
            delegated: decoded.accountAddress,
            name: 'default',
            checkpoint: 'authorized',
            kind: 'login',
            delegateAuth: {
                sig: decoded.delegateSig,
                expiryEpochMs: decoded.delegateExpiryEpochMs,
            },
            bearerToken: decoded.bearerToken,
        })

        await deps.writeSessionKeystoreFile(sessionPath, sessionKeystore, { overwrite })

        return {
            type: 'login',
            status: 'complete',
            profile: options.profile,
            profileDir,
            accountAddress: decoded.accountAddress,
            sessionAddress: decoded.sessionAddress,
            chainId: decoded.chainId,
            expiryEpochMs: decoded.expiryEpochMs,
        }
    } catch (error) {
        if (error instanceof LoginError) {
            throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new LoginError('LOGIN_FAILED', message, { cause: error })
    }
}

export async function executeLogout(
    options: LogoutOptions,
    depsArg?: Partial<LoginDeps>,
): Promise<LogoutResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const { profileDir, sessionPath } = resolveProfilePaths(options.env, options.profile)

    try {
        const sessionKeystore = await deps.readSessionKeystoreFile(sessionPath)
        if (!isLoginKeystore(sessionKeystore)) {
            throw new LoginError(
                'NOT_LOGIN_PROFILE',
                'Profile is not a login profile. Refusing to remove session.json.',
            )
        }

        await deps.rm(sessionPath)
        try {
            const entries = await deps.readdir(profileDir)
            if (entries.length === 0) {
                await deps.rm(profileDir)
            }
        } catch (error) {
            // Ignore best-effort profile directory cleanup.
            void error
        }

        const expiryHint =
            sessionKeystore.delegateAuth?.expiryEpochMs !== undefined
                ? new Date(sessionKeystore.delegateAuth.expiryEpochMs).toISOString()
                : 'its configured expiry'

        return {
            type: 'logout',
            status: 'complete',
            profile: options.profile,
            warning: `WARNING: The session key is still authorized on-chain until ${expiryHint}. Revoke it in the web app if this device may be compromised.`,
        }
    } catch (error) {
        if (error instanceof LoginError) {
            throw error
        }
        if (isMissingFileError(error)) {
            throw new LoginError(
                'NOT_LOGIN_PROFILE',
                `Login profile not found for profile "${options.profile}".`,
                { cause: error },
            )
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new LoginError('LOGIN_FAILED', message, { cause: error })
    }
}
