import { unlink } from 'node:fs/promises'
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import {
    decodeIntentError,
    type GetKeysResponse,
    type BundleStatusResponse,
    type Call,
    type PrepareCallsResponse,
} from '@nubl/relayer-client'
import { accountAbi } from '@nubl/contracts/abis'
import { resolveKeystorePath } from './account-create'
import { checkAgentListenPid } from './agent-runtime'
import { readAgentChannelRegistry, writeAgentChannelRegistry } from './agent-channel-registry'
import {
    decryptRootKeystore,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    withKeystoreLock,
    writeRootKeystoreFile,
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
    computeSessionKeyHash,
    getChainKeys,
    listSessionNames,
    parseSessionName,
} from './session-common'

type SessionRevokeErrorCode =
    | 'INVALID_NAME'
    | 'MISSING_ARGUMENT'
    | 'KEYSTORE_NOT_FOUND'
    | 'PASSWORD_REQUIRED'
    | 'ACTIVE_SESSION_REVOKE_REQUIRES_FORCE'
    | 'SESSION_REVOKE_FAILED'
    | 'SESSION_REVOCATION_UNVERIFIED'
    | 'KEYSTORE_LOCKED'
    | 'UNKNOWN'

export class SessionRevokeError extends Error {
    code: SessionRevokeErrorCode
    cause?: unknown
    recoveryCommand?: string
    details?: unknown

    constructor(
        code: SessionRevokeErrorCode,
        message: string,
        options?: { cause?: unknown; recoveryCommand?: string; details?: unknown },
    ) {
        super(message)
        this.name = 'SessionRevokeError'
        this.code = code
        this.cause = options?.cause
        this.recoveryCommand = options?.recoveryCommand
        this.details = options?.details
    }
}

export type SessionRevokeResult = {
    type: 'session_revoke'
    status: 'complete'
    keystorePath: string
    sessionPath: string
    network: CliNetworkConfig
    accountAddress: Address
    sessionName: string
    txHash?: Hex
    bundle: {
        id: string
        status: string
        statusCode: number
    }
    fileDeleted: boolean
}

type SessionRevokeDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    decryptRootKeystore: typeof decryptRootKeystore
    writeRootKeystoreFile: typeof writeRootKeystoreFile
    readAgentChannelRegistry: typeof readAgentChannelRegistry
    writeAgentChannelRegistry: typeof writeAgentChannelRegistry
    checkAgentListenPid: typeof checkAgentListenPid
    listSessionNames: typeof listSessionNames
    unlink: (path: string) => Promise<void>
    readNonce: (input: { network: CliNetworkConfig; account: Address }) => Promise<bigint>
    getKeys: (input: {
        network: CliNetworkConfig
        account: Address
        chainId: number
    }) => Promise<GetKeysResponse>
    sleep: (ms: number) => Promise<void>
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

function getDefaultDeps(): SessionRevokeDeps {
    return {
        readKeystoreBundle,
        readSessionKeystoreFile,
        decryptRootKeystore,
        writeRootKeystoreFile,
        readAgentChannelRegistry,
        writeAgentChannelRegistry,
        checkAgentListenPid,
        listSessionNames,
        unlink,
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

function registryKeyContainsAddress(registryKey: string, address: Address): boolean {
    const [, memberSetKey] = registryKey.split('|', 3)
    if (!memberSetKey) {
        return false
    }
    return memberSetKey.split(':').includes(address.toLowerCase())
}

export async function executeSessionRevoke(
    options: {
        env: EnvName
        chain?: ChainName
        name?: string
        keystorePath?: string
        sessionName: string
        force?: boolean
        resume?: boolean
        password: string
    },
    depsArg?: Partial<SessionRevokeDeps>,
): Promise<SessionRevokeResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const chain = selectDefaultChain(options.env, options.chain)
    const network = resolveNetworkConfig(options.env, chain)
    const keystorePath = resolveKeystorePath({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
    })
    const sessionName = parseSessionName(options.sessionName)

    return deps.withKeystoreLock(keystorePath, async () => {
        const bundle = await deps.readKeystoreBundle(keystorePath)
        const sessionPath = resolveSessionKeystorePath(
            keystorePath,
            sessionName,
            bundle.root.sessionRef.dir,
        )
        const sessionKeystore = await deps.readSessionKeystoreFile(sessionPath)
        const isAgentSession = sessionKeystore.kind === 'agent'

        const isRevokingActiveSession = sessionName === bundle.root.sessionRef.active
        let replacementActiveSession: string | null = null

        if (!options.force && (isRevokingActiveSession || isAgentSession)) {
            const reasons = [
                ...(isRevokingActiveSession ? ['active'] : []),
                ...(isAgentSession ? ['an agent with messaging channels'] : []),
            ]
            throw new SessionRevokeError(
                'ACTIVE_SESSION_REVOKE_REQUIRES_FORCE',
                `This session is ${reasons.join(' and ')}. Use --force to confirm.`,
            )
        }
        if (isRevokingActiveSession) {
            const candidates = await deps.listSessionNames(keystorePath, bundle.root.sessionRef.dir)
            replacementActiveSession = candidates.find((value) => value !== sessionName) ?? null
            if (!replacementActiveSession) {
                throw new SessionRevokeError(
                    'SESSION_REVOKE_FAILED',
                    'Cannot revoke active session without a replacement. Create another session first.',
                    {
                        recoveryCommand: 'tw session create <session-name> --json',
                    },
                )
            }
        }
        if (isAgentSession) {
            const listenStatus = await deps.checkAgentListenPid(sessionPath)
            if (listenStatus.active) {
                throw new SessionRevokeError(
                    'SESSION_REVOKE_FAILED',
                    `listen is running for agent "${sessionName}". Stop it first.`,
                )
            }
        }

        const accountAddress = bundle.root.addresses.delegated
            ? getAddress(bundle.root.addresses.delegated)
            : getAddress(bundle.root.addresses.root)

        const sessionAddress = getAddress(sessionKeystore.addresses.session)
        const sessionKeyHash = computeSessionKeyHash(sessionAddress)

        async function cleanupAgentChannels(): Promise<void> {
            if (!isAgentSession) {
                return
            }
            const registry = await deps.readAgentChannelRegistry(keystorePath)
            const nextChannels = Object.fromEntries(
                Object.entries(registry.channels).filter(
                    ([key]) => !registryKeyContainsAddress(key, sessionAddress),
                ),
            )
            if (Object.keys(nextChannels).length !== Object.keys(registry.channels).length) {
                await deps.writeAgentChannelRegistry(keystorePath, {
                    ...registry,
                    channels: nextChannels,
                })
            }
        }

        async function isSessionKeyPresent(): Promise<boolean> {
            const keys = await deps.getKeys({
                network,
                account: accountAddress,
                chainId: network.chainId,
            })
            return getChainKeys(keys, network.chainId).some(
                (entry: { hash?: string }) =>
                    typeof entry.hash === 'string' &&
                    entry.hash.toLowerCase() === sessionKeyHash.toLowerCase(),
            )
        }

        async function cleanupLocalSessionFile(): Promise<boolean> {
            let fileDeleted = true
            try {
                await deps.unlink(sessionPath)
            } catch {
                fileDeleted = false
            }

            if (isRevokingActiveSession) {
                if (!replacementActiveSession) {
                    throw new SessionRevokeError(
                        'SESSION_REVOKE_FAILED',
                        'Cannot revoke active session without a replacement. Create another session first.',
                    )
                }
                bundle.root.sessionRef.active = replacementActiveSession
                await deps.writeRootKeystoreFile(keystorePath, bundle.root, { overwrite: true })
            }

            return fileDeleted
        }

        const presentBeforeRevoke = await isSessionKeyPresent()
        if (!presentBeforeRevoke && options.resume) {
            await cleanupAgentChannels()
            const fileDeleted = await cleanupLocalSessionFile()
            return {
                type: 'session_revoke',
                status: 'complete',
                keystorePath,
                sessionPath,
                network,
                accountAddress,
                sessionName,
                bundle: {
                    id: 'already-revoked',
                    status: 'confirmed',
                    statusCode: 200,
                },
                fileDeleted,
            }
        }

        const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
        const signedNetwork = {
            ...network,
            authSigner: createEthHttpSigner(decryptedRoot.rootPrivateKey, network.chainId),
        }
        const nonce = await deps.readNonce({ network: signedNetwork, account: accountAddress })

        const calls: Call[] = [
            {
                target: accountAddress,
                value: 0n,
                data: encodeFunctionData({
                    abi: accountAbi,
                    functionName: 'revoke',
                    args: [sessionKeyHash],
                }),
            },
        ]

        let submission: { id: string; finalStatus: BundleStatusResponse }
        try {
            submission = await deps.executeSignedCalls(
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
        } catch (error) {
            const message =
                error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
            if (options.resume && message.includes('simulation failed')) {
                const stillPresent = await isSessionKeyPresent()
                if (!stillPresent) {
                    await cleanupAgentChannels()
                    const fileDeleted = await cleanupLocalSessionFile()
                    return {
                        type: 'session_revoke',
                        status: 'complete',
                        keystorePath,
                        sessionPath,
                        network,
                        accountAddress,
                        sessionName,
                        bundle: {
                            id: 'already-revoked',
                            status: 'confirmed',
                            statusCode: 200,
                        },
                        fileDeleted,
                    }
                }
            }
            throw error
        }

        const finalStatus = submission.finalStatus
        const statusCode = finalStatus.statusCode ?? 0
        if (!finalStatus.success || ![200, 201].includes(statusCode)) {
            const intentError = finalStatus.receipt?.intentError as Hex | undefined
            throw new SessionRevokeError(
                'SESSION_REVOKE_FAILED',
                finalStatus.error ??
                    `Bundle ended in status ${statusCode} (${finalStatus.status ?? 'unknown'}).`,
                {
                    details: {
                        statusCode,
                        txHash: finalStatus.receipt?.transactionHash,
                        intentError,
                        intentErrorName: intentError ? decodeIntentError(intentError) : undefined,
                    },
                },
            )
        }

        let stillPresent = await isSessionKeyPresent()
        if (stillPresent) {
            for (let attempt = 0; attempt < 4; attempt += 1) {
                await deps.sleep(500 * (attempt + 1))
                stillPresent = await isSessionKeyPresent()
                if (!stillPresent) break
            }
        }
        if (stillPresent) {
            await cleanupAgentChannels()
            throw new SessionRevokeError(
                'SESSION_REVOCATION_UNVERIFIED',
                'On-chain revoke confirmation was not verifiable yet.',
                { recoveryCommand: 'tw session list --on-chain --json' },
            )
        }

        await cleanupAgentChannels()
        const fileDeleted = await cleanupLocalSessionFile()

        return {
            type: 'session_revoke',
            status: 'complete',
            keystorePath,
            sessionPath,
            network,
            accountAddress,
            sessionName,
            txHash: finalStatus.receipt?.transactionHash,
            bundle: {
                id: submission.id,
                status: finalStatus.status ?? 'unknown',
                statusCode,
            },
            fileDeleted,
        }
    })
}
