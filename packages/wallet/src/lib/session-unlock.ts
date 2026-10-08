import { getAddress, type Address } from 'viem'
import { toBinary } from '@bufbuild/protobuf'
import { ExportedDeviceSchema } from '@nubl/proto'
import { dirname, join } from 'node:path'
import { resolveKeystorePath } from './account-create'
import { decryptAgentDevice } from './agent-sessions'
import { SessionDaemonClient } from './session-daemon-client'
import {
    LoginProfileError,
    SessionOnlyProfileError,
    type AnySessionKeystore,
    decryptSessionKeystore,
    isAgentKeystore,
    isLoginKeystore,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
} from './keystore'
import { isMissingFileError } from './fs-utils'
import { parseDuration, parseSessionName } from './session-common'
import { sessionOnChainRequiresPhrase } from './session-gates'
import { isSwapSessionKey } from './swap-session'
import { computeSessionKeyHash } from './session-common'
import { readAccountKeysFromChain } from './session-chain-permissions'
import {
    chainsForEnv,
    getChainConfig,
    rpcUrlForChain,
    type EnvName,
} from './network-config'

const DEFAULT_DURATION_SECONDS = 60 * 60

const MAX_DURATION_SECONDS = 24 * 60 * 60

export class SessionUnlockError extends Error {
    code:
        | 'PASSWORD_REQUIRED'
        | 'DAEMON_UNAVAILABLE'
        | 'INVALID_DURATION'
        | 'SESSION_UNLOCK_FAILED'
        | 'INVALID_SESSION_KIND'

    constructor(code: SessionUnlockError['code'], message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'SessionUnlockError'
        this.code = code
        this.cause = options?.cause
    }
}

export type SessionUnlockResult = {
    type: 'session_unlock'
    status: 'complete'
    name: string
    address: string
    expiresAt: number
}

type SessionUnlockDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    decryptSessionKeystore: typeof decryptSessionKeystore
    decryptAgentDevice: typeof decryptAgentDevice
    createDaemonClient: () => Pick<SessionDaemonClient, 'loadKey'>
    sessionRequiresPhrase: (input: {
        env: EnvName
        account: Address
        sessionAddress: Address
    }) => Promise<boolean>
    sessionIsSwap: (input: {
        env: EnvName
        account: Address
        sessionAddress: Address
    }) => Promise<boolean>
}

function getDefaultDeps(): SessionUnlockDeps {
    return {
        readKeystoreBundle,
        readSessionKeystoreFile,
        decryptSessionKeystore,
        decryptAgentDevice,
        createDaemonClient: () => new SessionDaemonClient(),
        sessionRequiresPhrase: (input) => sessionOnChainRequiresPhrase(input),
        sessionIsSwap: (input) => sessionIsSwapOnChain(input),
    }
}

/** True when any configured chain shows this key as a swap session. A failed read is not one. */
export async function sessionIsSwapOnChain(input: {
    env: EnvName
    account: Address
    sessionAddress: Address
}): Promise<boolean> {
    const keyHash = computeSessionKeyHash(input.sessionAddress).toLowerCase()

    for (const chainName of chainsForEnv(input.env)) {
        const chain = getChainConfig(chainName)

        try {
            const keys = await readAccountKeysFromChain({
                rpcUrl: rpcUrlForChain(chainName),
                chainId: chain.chainId,
                account: input.account,
            })

            const key = keys.find((entry) => entry.hash.toLowerCase() === keyHash)

            if (key && isSwapSessionKey(key.permissions, chain.chainId)) return true
        } catch {
            continue
        }
    }

    return false
}

export async function resolveSessionUnlockPassword(
    args: { passwordStdin?: boolean },
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

    throw new SessionUnlockError(
        'PASSWORD_REQUIRED',
        'Password required. Use --password-stdin, TW_PASSWORD, or run in interactive TTY.',
    )
}

function parseDurationSeconds(duration?: string, force?: boolean): number {
    const resolved = duration ? parseDuration(duration) : DEFAULT_DURATION_SECONDS

    if (resolved > MAX_DURATION_SECONDS && !force) {
        throw new SessionUnlockError(
            'INVALID_DURATION',
            'Maximum duration is 24h. Re-run with --force to override.',
        )
    }

    return resolved
}

export async function executeSessionUnlock(
    options: {
        env: EnvName
        name?: string
        keystorePath?: string
        sessionName: string
        password: string
        duration?: string
        force?: boolean
        device?: boolean
        /** Set only after the caller collected UNLOCK FULL ACCESS SESSION. */
        humanConfirmed?: boolean
    },
    depsArg?: Partial<SessionUnlockDeps>,
): Promise<SessionUnlockResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const sessionName = parseSessionName(options.sessionName)
    const durationSeconds = parseDurationSeconds(options.duration, options.force)

    const keystorePath = resolveKeystorePath({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
    })

    let sessionKeystore: AnySessionKeystore

    try {
        const bundle = await deps.readKeystoreBundle(keystorePath)

        const sessionPath = resolveSessionKeystorePath(
            keystorePath,
            sessionName,
            bundle.root.sessionRef.dir,
        )

        sessionKeystore = await deps.readSessionKeystoreFile(sessionPath)
    } catch (error) {
        if (
            !isMissingFileError(error) &&
            !(error instanceof SessionOnlyProfileError) &&
            !(error instanceof LoginProfileError)
        ) {
            throw error
        }

        const sessionProfilePath = join(dirname(keystorePath), 'session.json')
        sessionKeystore = await deps.readSessionKeystoreFile(sessionProfilePath)

        if (sessionKeystore.kind !== undefined && !isLoginKeystore(sessionKeystore)) {
            throw new SessionUnlockError(
                'INVALID_SESSION_KIND',
                `Session-only profile at ${sessionProfilePath} has unsupported kind "${sessionKeystore.kind}".`,
            )
        }

        if (sessionKeystore.name !== sessionName) {
            throw new SessionUnlockError(
                'SESSION_UNLOCK_FAILED',
                `Session "${sessionName}" not found in this session-only profile. Use "${sessionKeystore.name}" instead.`,
            )
        }
    }

    if (options.device && !isAgentKeystore(sessionKeystore)) {
        throw new SessionUnlockError(
            'INVALID_SESSION_KIND',
            'Session is not an agent session. `--device` is only supported for agent sessions.',
        )
    }

    if (!options.humanConfirmed) {
        const delegated = sessionKeystore.addresses.delegated

        const elevated = delegated
            ? await deps.sessionRequiresPhrase({
                  env: options.env,
                  account: getAddress(delegated),
                  sessionAddress: getAddress(sessionKeystore.addresses.session),
              })
            : true

        if (elevated) {
            throw new SessionUnlockError(
                'SESSION_UNLOCK_FAILED',
                'Unlocking a full-access session requires a human at an interactive terminal. Type "UNLOCK FULL ACCESS SESSION" when prompted.',
            )
        }
    }

    const decrypted = await deps.decryptSessionKeystore(sessionKeystore, options.password)
    let encryptionDeviceHex: `0x${string}` | undefined

    if (options.device) {
        const exportedDevice = await deps.decryptAgentDevice(sessionKeystore, options.password)
        encryptionDeviceHex = `0x${Buffer.from(toBinary(ExportedDeviceSchema, exportedDevice)).toString('hex')}`
    }

    const client = deps.createDaemonClient()

    const response = await client.loadKey({
        name: sessionName,
        privateKey: decrypted.sessionPrivateKey,
        address: getAddress(sessionKeystore.addresses.session),
        durationSeconds,
        kind: options.device ? 'agent' : undefined,
        encryptionDevice: encryptionDeviceHex,
        phraseConfirmed: options.humanConfirmed === true,
        swapSession: sessionKeystore.addresses.delegated
            ? await deps.sessionIsSwap({
                  env: options.env,
                  account: getAddress(sessionKeystore.addresses.delegated),
                  sessionAddress: getAddress(sessionKeystore.addresses.session),
              })
            : false,
        env: options.env,
    })

    if (response === null) {
        throw new SessionUnlockError(
            'DAEMON_UNAVAILABLE',
            'Session daemon is not running. Run `tw daemon start` first.',
        )
    }

    if (!response.ok) {
        throw new SessionUnlockError('SESSION_UNLOCK_FAILED', response.error.message)
    }

    return {
        type: 'session_unlock',
        status: 'complete',
        name: response.result.name,
        address: response.result.address,
        expiresAt: response.result.expiresAt,
    }
}
