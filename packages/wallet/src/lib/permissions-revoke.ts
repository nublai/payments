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
    getUsdcTokenConfig,
    resolveNetworkConfig,
    rpcUrlForChain,
    selectDefaultChain,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
} from './network-config'
import {
    CONFIRM_REVOKE_FULL_ACCESS_PHRASE,
    HumanConfirmationError,
    humanConfirmationMessage,
} from './human-confirmation'
import { accountStateRequiresPhrase } from './session-gates'
import { narrowCallAllowlist, readSessionChainGuard } from './session-chain-permissions'
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
import {
    executeSignedCalls,
    type ExecuteSignedCallsDeps,
    type ExecuteSignedCallsParams,
    type ExecuteSignedCallsResult,
} from './execute-calls'

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
    feeCap?: ExecuteSignedCallsResult['feeCap']
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
    readSessionChainGuard: typeof readSessionChainGuard
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
        readSessionChainGuard,
    }
}

function sameAddress(left: string | undefined, right: string): boolean {
    if (!left) return false
    try {
        return getAddress(left).toLowerCase() === getAddress(right).toLowerCase()
    } catch {
        return false
    }
}

/** True when the permissions left after this revoke are above the narrow gate. */
export async function revokeLeavesElevated(input: {
    env: EnvName
    chain: ChainName
    chainId: number
    account: Address
    keyHash: Hex
    all?: boolean
    rule?: string
    readSessionChainGuard: typeof readSessionChainGuard
}): Promise<boolean> {
    try {
        const guard = await input.readSessionChainGuard({
            rpcUrl: rpcUrlForChain(input.chain),
            chainId: input.chainId,
            account: input.account,
            keyHash: input.keyHash,
        })
        if (!guard.key) return true
        let remaining = guard.key.permissions
        if (input.all) {
            remaining = []
        } else if (input.rule) {
            const parsed = parseRuleId(input.rule)
            remaining = guard.key.permissions.filter((permission) => {
                if (parsed.kind === 'call' && permission.type === 'call') {
                    return !(
                        sameAddress(permission.to, parsed.target) &&
                        permission.selector?.toLowerCase() === parsed.selector.toLowerCase()
                    )
                }
                if (parsed.kind === 'spend' && permission.type === 'spend') {
                    return !(
                        sameAddress(permission.token, parsed.token) &&
                        permission.period === parsed.period
                    )
                }
                return true
            })
        }
        return accountStateRequiresPhrase({
            permissions: remaining,
            anyCalls: guard.anyCalls,
            checkerCount: guard.checkerCount,
            usdcAddress: getUsdcTokenConfig(input.chain).address,
            allowedCalls: narrowCallAllowlist(input.env, input.chainId),
        })
    } catch (error) {
        if (error instanceof PermissionsError) throw error
        return true
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
        /** Set only after REVOKE FULL ACCESS SESSION was typed. */
        phraseConfirmed?: boolean
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

        if (!options.phraseConfirmed && calls.length > 0) {
            const leavesElevated = await revokeLeavesElevated({
                env: options.env,
                chain,
                chainId: network.chainId,
                account: accountAddress,
                keyHash: selected.key.hash,
                all: options.all,
                rule: options.rule,
                readSessionChainGuard: deps.readSessionChainGuard,
            })
            if (leavesElevated) {
                throw new HumanConfirmationError(
                    humanConfirmationMessage(
                        'Revoking this permission leaves the key with full access',
                        CONFIRM_REVOKE_FULL_ACCESS_PHRASE,
                    ),
                )
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
            feeCap: submission.feeCap,
        }
    })
}
