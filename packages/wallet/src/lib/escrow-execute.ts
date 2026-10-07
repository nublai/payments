import { createPublicClient, getAddress, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
    computeKeyHash,
    decodeIntentError,
    encodeSecp256k1Key,
    getChain,
    waitForBundle as waitForBundleAction,
    type Call,
} from '@nubl/relayer-client'
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
import type { ChainName, CliNetworkConfig, EnvName } from './network-config'
import {
    createCliRelayerClient,
    createEthHttpSigner,
    readAccountNonce,
} from './relayer-client-utils'
import { executeSignedCalls, type ExecuteSignedCallsDeps } from './execute-calls'
import { parseSessionName } from './session-common'
import { resolveSessionSigner, SessionSignerDaemonError, SessionSignerExpiredError } from './signer'
import { assertEscrowSessionNetworkMatches, EscrowError } from './escrow-common'
import { isMissingFileError } from './fs-utils'

/**
 * Create a password resolver that caches the first resolved password.
 * Used by create/settle/refund so interactive prompt runs at most once.
 */
export function createEscrowPasswordResolver(options: {
    password?: string
    resolvePassword?: () => Promise<string>
}): () => Promise<string> {
    let cached: string | undefined = options.password
    return async (): Promise<string> => {
        if (cached !== undefined) return cached
        if (options.resolvePassword) {
            cached = await options.resolvePassword()
            return cached
        }
        throw new EscrowError('PASSWORD_REQUIRED', 'Password required.')
    }
}

/**
 * Load session keystore and sender address from session file or keystore bundle.
 * @throws EscrowError on network mismatch (session file) or missing keystore.
 */
export async function loadEscrowSessionAndSender(
    options: {
        sessionFile?: string
        sessionName?: string
        env: EnvName
        keystorePath: string
        name?: string
    },
    networkChainId: number,
): Promise<{
    sessionKeystore: RelayerSessionKeystoreV2 | LoginSessionKeystoreV2
    sender: Address
}> {
    if (options.sessionFile && options.sessionName) {
        throw new EscrowError(
            'INVALID_ARGUMENT',
            '--session and --session-file are mutually exclusive.',
        )
    }
    if (options.sessionFile) {
        const sessionKeystore = await readSessionKeystoreFile(options.sessionFile)
        if (isAgentKeystore(sessionKeystore)) {
            throw new EscrowError(
                'INVALID_ARGUMENT',
                'Agent session keystores are not supported for escrow.',
            )
        }
        assertEscrowSessionNetworkMatches(sessionKeystore, options.env, networkChainId)
        const sender = getAddress(sessionKeystore.addresses.delegated)
        return { sessionKeystore, sender }
    }

    let bundle: Awaited<ReturnType<typeof readKeystoreBundle>> | undefined
    try {
        bundle = await readKeystoreBundle(options.keystorePath)
    } catch (error) {
        if (
            !isMissingFileError(error) &&
            !(error instanceof SessionOnlyProfileError) &&
            !(error instanceof LoginProfileError)
        ) {
            throw error
        }

        const sessionProfilePath =
            (error instanceof SessionOnlyProfileError || error instanceof LoginProfileError) &&
            error.sessionPath
                ? error.sessionPath
                : join(dirname(options.keystorePath), 'session.json')
        const sessionKeystore =
            (error instanceof SessionOnlyProfileError || error instanceof LoginProfileError) &&
            error.sessionKeystore
                ? error.sessionKeystore
                : await readSessionKeystoreFile(sessionProfilePath)
        if (isAgentKeystore(sessionKeystore)) {
            throw new EscrowError(
                'INVALID_ARGUMENT',
                'Agent session keystores are not supported for escrow.',
            )
        }
        assertEscrowSessionNetworkMatches(sessionKeystore, options.env, networkChainId)
        return {
            sessionKeystore,
            sender: getAddress(sessionKeystore.addresses.delegated),
        }
    }

    const sender = getAddress(bundle.root.addresses.delegated ?? bundle.root.addresses.root)

    if (!options.sessionName) {
        if (isAgentKeystore(bundle.session)) {
            throw new EscrowError(
                'INVALID_ARGUMENT',
                'Agent session keystores are not supported for escrow.',
            )
        }
        return { sessionKeystore: bundle.session, sender }
    }

    const selectedSessionName = parseSessionName(options.sessionName)
    const sessionPath = resolveSessionKeystorePath(
        options.keystorePath,
        selectedSessionName,
        bundle.root.sessionRef.dir,
    )

    try {
        const sessionKeystore = await readSessionKeystoreFile(sessionPath)
        if (isAgentKeystore(sessionKeystore)) {
            throw new EscrowError(
                'INVALID_ARGUMENT',
                'Agent session keystores are not supported for escrow.',
            )
        }
        return { sessionKeystore, sender }
    } catch (error) {
        if (error instanceof EscrowError) throw error
        const detail = error instanceof Error ? error.message : String(error)
        throw new EscrowError(
            'INVALID_ARGUMENT',
            `Could not load session "${selectedSessionName}" at ${sessionPath}: ${detail}`,
            { cause: error },
        )
    }
}

export type EscrowSubmission = Awaited<ReturnType<typeof executeSignedCalls>>

export type EscrowExecuteResult = {
    submission: EscrowSubmission
    finalStatus: EscrowSubmission['finalStatus']
    signerMode: 'daemon' | 'direct' | 'fallback_direct'
    sender: Address
}

/**
 * Load session, resolve signer, run executeSignedCalls with daemon fallback, and validate bundle status.
 * Single place for password resolution, session load, relayer client setup, and status 200/201 handling.
 * @param failureMessage Used in ESCROW_FAILED when finalStatus.success is false (e.g. "Escrow creation", "Settlement", "Refund").
 * @param calls Pre-built calls, or omit and provide buildCalls(sender) when calls depend on the sender (e.g. escrow create).
 */
export async function executeEscrowCallsWithFallback(params: {
    chain: ChainName
    network: CliNetworkConfig
    env: EnvName
    sessionFile?: string
    sessionName?: string
    keystorePath: string
    name?: string
    resolvePassword: () => Promise<string>
    executeSignedCallsDeps?: Partial<ExecuteSignedCallsDeps>
    calls?: Call[]
    buildCalls?: (sender: Address) => Call[]
    failureMessage: string
}): Promise<EscrowExecuteResult> {
    const {
        network,
        env,
        sessionFile,
        sessionName,
        keystorePath,
        name,
        resolvePassword,
        executeSignedCallsDeps = {},
        failureMessage,
    } = params

    const { sessionKeystore, sender } = await loadEscrowSessionAndSender(
        { sessionFile, sessionName, env, keystorePath, name },
        network.chainId,
    )
    const calls = params.calls ?? (params.buildCalls ? params.buildCalls(sender) : undefined)
    if (!calls || calls.length === 0) {
        throw new EscrowError('INVALID_ARGUMENT', 'Either calls or buildCalls must be provided.')
    }

    const resolvedSigner = await resolveSessionSigner({
        sessionName: sessionKeystore.name ?? 'default',
        sessionKeystore,
        chainId: network.chainId,
        decryptSessionKeystore,
        resolvePassword,
    })

    const signedNetwork: CliNetworkConfig = {
        ...network,
        authSigner: resolvedSigner.authSigner,
    }
    const client = createPublicClient({
        chain: getChain(signedNetwork.chainId, signedNetwork.rpcUrl),
        transport: http(signedNetwork.rpcUrl),
    })
    const nonce = await readAccountNonce(client, sender)

    const sessionPublicKey = encodeSecp256k1Key(sessionKeystore.addresses.session as Address)
    const sessionKeyHash = computeKeyHash('secp256k1', sessionPublicKey)

    const relayerClient = createCliRelayerClient(signedNetwork)
    const baseExecDeps: ExecuteSignedCallsDeps = {
        prepareCalls: async (input) =>
            relayerClient.prepareCalls({
                from: input.from,
                chainId: signedNetwork.chainId,
                calls: input.calls,
                sessionKey: input.sessionKey,
                nonce: input.nonce,
            }),
        signTypedData: resolvedSigner.signTypedData,
        sendPreparedCalls: async (input) =>
            relayerClient.sendPreparedCalls({
                context: input.context,
                signature: input.signature,
            }),
        waitForBundle: async (input) =>
            waitForBundleAction(relayerClient, {
                id: input.id,
                chainId: signedNetwork.chainId,
            }),
    }
    const execDeps: ExecuteSignedCallsDeps = {
        ...baseExecDeps,
        ...executeSignedCallsDeps,
    }

    let submission: Awaited<ReturnType<typeof executeSignedCalls>>
    let signerMode: EscrowExecuteResult['signerMode'] =
        resolvedSigner.mode === 'daemon' ? 'daemon' : 'direct'

    try {
        submission = await executeSignedCalls(execDeps, {
            from: sender,
            calls,
            nonce,
            sessionKey: sessionPublicKey,
            signerPrivateKey: resolvedSigner.signerPrivateKey,
            signerKeyHash: sessionKeyHash,
            chainId: signedNetwork.chainId,
            env: signedNetwork.env,
        })
    } catch (error) {
        if (error instanceof SessionSignerExpiredError) {
            throw new EscrowError('SESSION_EXPIRED', error.message, { cause: error })
        }
        if (!(error instanceof SessionSignerDaemonError) || resolvedSigner.mode !== 'daemon') {
            throw error
        }
        const fallback = await decryptSessionKeystore(sessionKeystore, await resolvePassword())
        const fallbackNetwork: CliNetworkConfig = {
            ...signedNetwork,
            authSigner: createEthHttpSigner(fallback.sessionPrivateKey, network.chainId),
        }
        signerMode = 'fallback_direct'
        const fallbackClient = createCliRelayerClient(fallbackNetwork)
        const fallbackBaseDeps: ExecuteSignedCallsDeps = {
            ...baseExecDeps,
            prepareCalls: async (input) =>
                fallbackClient.prepareCalls({
                    from: input.from,
                    chainId: fallbackNetwork.chainId,
                    calls: input.calls,
                    sessionKey: input.sessionKey,
                    nonce: input.nonce,
                }),
            signTypedData: async (input) => {
                const signer = privateKeyToAccount(input.privateKey)
                return signer.signTypedData(input.typedData)
            },
            sendPreparedCalls: async (input) =>
                fallbackClient.sendPreparedCalls({
                    context: input.context,
                    signature: input.signature,
                }),
            waitForBundle: async (input) =>
                waitForBundleAction(fallbackClient, {
                    id: input.id,
                    chainId: fallbackNetwork.chainId,
                }),
        }
        const fallbackDeps: ExecuteSignedCallsDeps = {
            ...fallbackBaseDeps,
            ...executeSignedCallsDeps,
        }
        submission = await executeSignedCalls(fallbackDeps, {
            from: sender,
            calls,
            nonce,
            sessionKey: sessionPublicKey,
            signerPrivateKey: fallback.sessionPrivateKey,
            signerKeyHash: sessionKeyHash,
            chainId: fallbackNetwork.chainId,
            env: fallbackNetwork.env,
        })
    }

    const finalStatus = submission.finalStatus
    if (!finalStatus.success) {
        throw new EscrowError(
            'ESCROW_FAILED',
            finalStatus.error ?? `${failureMessage} did not complete successfully.`,
            {
                details: {
                    statusCode: finalStatus.statusCode,
                    txHash: finalStatus.receipt?.transactionHash,
                },
            },
        )
    }

    const statusCode = finalStatus.statusCode
    if (statusCode !== undefined && ![200, 201].includes(statusCode)) {
        const intentError = finalStatus.receipt?.intentError as Hex | undefined
        const intentErrorName = intentError ? decodeIntentError(intentError) : undefined
        throw new EscrowError(
            'INTENT_REVERTED',
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
        submission,
        finalStatus,
        signerMode,
        sender,
    }
}
