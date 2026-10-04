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

export type PermissionsGrantResult = {
    type: 'permissions_grant'
    status: 'complete'
    keystorePath: string
    network: CliNetworkConfig
    accountAddress: Address
    keyHash: Hex
    grantType: 'call' | 'spend'
    bundle: {
        id: string
        status: string
        statusCode: number
    }
    txHash?: Hex
}

type PermissionsGrantDeps = {
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

function getDefaultDeps(): PermissionsGrantDeps {
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
    deps: PermissionsGrantDeps
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

export async function executePermissionsGrant(
    options: {
        env: EnvName
        chain?: ChainName
        name?: string
        keystorePath?: string
        keyRef?: string
        keyName?: string
        keyHash?: Hex
        grantType: 'call' | 'spend'
        target?: Address
        selector?: Hex
        token?: Address
        spendLimit?: bigint
        period?: ReturnType<typeof parsePeriod>
        password: string
    },
    depsArg?: Partial<PermissionsGrantDeps>,
): Promise<PermissionsGrantResult> {
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

        let callData: Hex
        if (options.grantType === 'call') {
            if (!options.target || !options.selector) {
                throw new PermissionsError(
                    'MISSING_ARGUMENT',
                    'Call grants require --target and --selector.',
                )
            }
            callData = encodeFunctionData({
                abi: accountAbi,
                functionName: 'setCanExecute',
                args: [selected.key.hash, options.target, options.selector, true],
            })
        } else {
            if (!options.token || options.spendLimit === undefined || !options.period) {
                throw new PermissionsError(
                    'MISSING_ARGUMENT',
                    'Spend grants require --token, --spend-limit, and --period.',
                )
            }
            callData = encodeFunctionData({
                abi: accountAbi,
                functionName: 'setSpendLimit',
                args: [
                    selected.key.hash,
                    options.token,
                    periodToEnum(options.period),
                    options.spendLimit,
                ],
            })
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
                calls: [
                    {
                        target: accountAddress,
                        value: 0n,
                        data: callData,
                    },
                ],
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
            type: 'permissions_grant',
            status: 'complete',
            keystorePath,
            network,
            accountAddress,
            keyHash: selected.key.hash,
            grantType: options.grantType,
            txHash: finalStatus.receipt?.transactionHash,
            bundle: {
                id: submission.id,
                status: finalStatus.status ?? 'unknown',
                statusCode,
            },
        }
    })
}
