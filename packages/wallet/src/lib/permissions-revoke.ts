import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import type {
    BundleStatusResponse,
    Call,
    GetKeysResponse,
    PrepareCallsResponse,
} from '@nubl/relayer-client'
import { accountAbi } from '@nubl/contracts/abis'
import { resolveKeystorePath } from './account-create'
import {
    decryptRootKeystore,
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    withKeystoreLock,
} from './keystore'
import {
    resolveNetworkConfig,
    selectDefaultChain,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
} from './network-config'
import {
    parsePeriod,
    parseRuleId,
    periodToEnum,
    resolveSelectedKey,
    type KeySelector,
    type LocalKeyMeta,
    type OnChainPermissionKey,
    PermissionsError,
} from './permissions-common'
import {
    createCliRelayerClient,
    createEthHttpSigner,
    readAccountNonce,
} from './relayer-client-utils'
import {
    computeSessionKeyHash,
    getChainKeys,
    listSessionNames,
    parseSessionName,
} from './session-common'
import { executeSignedCalls, type ExecuteSignedCallsDeps } from './execute-calls'

export type PermissionsRevokeResult = {
    type: 'permissions_revoke'
    status: 'complete'
    keystorePath: string
    network: CliNetworkConfig
    accountAddress: Address
    keyHash: Hex
    ruleCount: number
    bundle: {
        id: string
        status: string
        statusCode: number
    }
    txHash?: Hex
}

type PermissionsRevokeDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    listSessionNames: typeof listSessionNames
    decryptRootKeystore: typeof decryptRootKeystore
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

function getDefaultDeps(): PermissionsRevokeDeps {
    return {
        readKeystoreBundle,
        readSessionKeystoreFile,
        listSessionNames,
        decryptRootKeystore,
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

async function loadLocalKeyMeta(input: {
    deps: PermissionsRevokeDeps
    keystorePath: string
    sessionsDir: string
}): Promise<LocalKeyMeta[]> {
    const names = await input.deps.listSessionNames(input.keystorePath, input.sessionsDir)
    const localKeys: LocalKeyMeta[] = []

    for (const rawName of names) {
        const name = parseSessionName(rawName)
        const sessionPath = resolveSessionKeystorePath(input.keystorePath, name, input.sessionsDir)
        const session = await input.deps.readSessionKeystoreFile(sessionPath)
        const address = getAddress(session.addresses.session)
        localKeys.push({
            name,
            address,
            hash: computeSessionKeyHash(address),
        })
    }

    return localKeys
}

export async function executePermissionsRevoke(
    options: {
        env: EnvName
        chain?: ChainName
        name?: string
        keystorePath?: string
        keyRef?: string
        keyName?: string
        keyHash?: Hex
        rule?: string
        all?: boolean
        password: string
    },
    depsArg?: Partial<PermissionsRevokeDeps>,
): Promise<PermissionsRevokeResult> {
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
            : getAddress(bundle.root.addresses.root)

        const localKeys = await loadLocalKeyMeta({
            deps,
            keystorePath,
            sessionsDir: bundle.root.sessionRef.dir,
        })

        const keysResponse = await deps.getKeys({
            network,
            account: accountAddress,
            chainId: network.chainId,
        })

        const chainKeys = getChainKeys(keysResponse, network.chainId) as OnChainPermissionKey[]

        const selected = resolveSelectedKey({
            selector: {
                positional: options.keyRef,
                keyName: options.keyName,
                keyHash: options.keyHash,
            } as KeySelector,
            keys: chainKeys,
            localKeys,
        })

        if (selected.key.role === 'admin') {
            throw new PermissionsError(
                'UNSUPPORTED_FOR_ADMIN_KEY',
                'Admin keys cannot be modified with rule-level permission operations.',
            )
        }

        if (options.all && options.rule) {
            throw new PermissionsError(
                'MISSING_ARGUMENT',
                'Provide either --rule or --all, not both.',
            )
        }

        if (!options.all && !options.rule) {
            throw new PermissionsError('MISSING_ARGUMENT', 'Provide --rule or --all.')
        }

        const calls: Call[] = []

        if (options.all) {
            for (const permission of selected.key.permissions) {
                if (permission.type === 'call') {
                    const target = getAddress(permission.to)
                    const selector = permission.selector
                    calls.push({
                        target: accountAddress,
                        value: 0n,
                        data: encodeFunctionData({
                            abi: accountAbi,
                            functionName: 'setCanExecute',
                            args: [selected.key.hash, target, selector, false],
                        }),
                    })
                    continue
                }

                const token = getAddress(permission.token)
                const period = parsePeriod(permission.period)
                calls.push({
                    target: accountAddress,
                    value: 0n,
                    data: encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'removeSpendLimit',
                        args: [selected.key.hash, token, periodToEnum(period)],
                    }),
                })
            }
        }

        if (options.rule) {
            const parsed = parseRuleId(options.rule)
            if (parsed.kind === 'call') {
                calls.push({
                    target: accountAddress,
                    value: 0n,
                    data: encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'setCanExecute',
                        args: [selected.key.hash, parsed.target, parsed.selector, false],
                    }),
                })
            } else {
                calls.push({
                    target: accountAddress,
                    value: 0n,
                    data: encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'removeSpendLimit',
                        args: [selected.key.hash, parsed.token, periodToEnum(parsed.period)],
                    }),
                })
            }
        }

        if (calls.length === 0) {
            return {
                type: 'permissions_revoke',
                status: 'complete',
                keystorePath,
                network,
                accountAddress,
                keyHash: selected.key.hash,
                ruleCount: 0,
                bundle: {
                    id: 'no-op',
                    status: 'confirmed',
                    statusCode: 200,
                },
            }
        }

        const decryptedRoot = await deps.decryptRootKeystore(bundle.root, options.password)
        const signedNetwork = {
            ...network,
            authSigner: createEthHttpSigner(decryptedRoot.rootPrivateKey, network.chainId),
        }
        const nonce = await deps.readNonce({ network: signedNetwork, account: accountAddress })

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

        const finalStatus = submission.finalStatus
        const statusCode = finalStatus.statusCode ?? 0

        if (!finalStatus.success || ![200, 201].includes(statusCode)) {
            throw new PermissionsError(
                'SEND_FAILED',
                finalStatus.error ??
                    `Bundle ended in status ${statusCode} (${finalStatus.status ?? 'unknown'}).`,
                {
                    details: {
                        statusCode,
                        txHash: finalStatus.receipt?.transactionHash,
                        intentError: finalStatus.receipt?.intentError,
                    },
                },
            )
        }

        return {
            type: 'permissions_revoke',
            status: 'complete',
            keystorePath,
            network,
            accountAddress,
            keyHash: selected.key.hash,
            ruleCount: calls.length,
            txHash: finalStatus.receipt?.transactionHash,
            bundle: {
                id: submission.id,
                status: finalStatus.status ?? 'unknown',
                statusCode,
            },
        }
    })
}
