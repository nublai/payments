import { getAddress, type Address, type Hex } from 'viem'
import { type GetKeysResponse, type PermissionInfo } from '@towns-labs/relayer-client'
import { resolveKeystorePath } from './account-create'
import { readKeystoreBundle, readSessionKeystoreFile, resolveSessionKeystorePath } from './keystore'
import {
    resolveNetworkConfig,
    selectDefaultChain,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
} from './network-config'
import { createCliRelayerClient } from './relayer-client-utils'
import {
    deriveKeyAddress,
    formatTokenAmount,
    parsePeriod,
    resolveLocalNameByHash,
    spendHashId,
    spendRuleId,
    tokenLabel,
    type LocalKeyMeta,
    type OnChainPermissionKey,
} from './permissions-common'
import {
    computeSessionKeyHash,
    getChainKeys,
    listSessionNames,
    parseSessionName,
} from './session-common'

export type PermissionsListResult = {
    type: 'permissions_list'
    status: 'complete'
    keystorePath: string
    network: CliNetworkConfig
    accountAddress: Address
    keys: Array<{
        name: string | null
        nameSource: 'local' | 'none'
        hash: Hex
        address: Address
        type: 'secp256k1' | 'external'
        role: 'admin' | 'normal'
        expiryRaw: Hex
        summary: {
            callPermissionCount: number
            spendLimitCount: number
            spendUsage: Array<{
                id: string
                hashId: Hex
                token: Address
                tokenLabel?: string
                period: string
                limitRaw: string
                spentRaw: string
                remainingRaw: string
                limit: string
                spent: string
                remaining: string
            }>
        }
    }>
}

type PermissionsListDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    listSessionNames: typeof listSessionNames
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    getKeys: (input: {
        network: CliNetworkConfig
        account: Address
        chainId: number
    }) => Promise<GetKeysResponse>
}

function getDefaultDeps(): PermissionsListDeps {
    return {
        readKeystoreBundle,
        listSessionNames,
        readSessionKeystoreFile,
        getKeys: async ({ network, account, chainId }) => {
            const client = createCliRelayerClient(network)
            return client.getKeys({ address: account, chainIds: [chainId] })
        },
    }
}

async function loadLocalKeyMeta(input: {
    deps: PermissionsListDeps
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

function splitPermissions(permissions: PermissionInfo[]) {
    const calls = permissions.filter(
        (entry): entry is Extract<PermissionInfo, { type: 'call' }> => {
            return entry.type === 'call'
        },
    )
    const spends = permissions.filter(
        (entry): entry is Extract<PermissionInfo, { type: 'spend' }> => entry.type === 'spend',
    )
    return { calls, spends }
}

export async function executePermissionsList(
    options: {
        env: EnvName
        chain?: ChainName
        name?: string
        keystorePath?: string
    },
    depsArg?: Partial<PermissionsListDeps>,
): Promise<PermissionsListResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const chain = selectDefaultChain(options.env, options.chain)
    const network = resolveNetworkConfig(options.env, chain)
    const keystorePath = resolveKeystorePath({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
    })

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

    const keys = chainKeys.map((key) => {
        const local = resolveLocalNameByHash(key.hash, localKeys)
        const address = deriveKeyAddress(key)
        const { calls, spends } = splitPermissions(key.permissions)

        const spendUsage = spends.map((spend) => {
            const token = getAddress(spend.token)
            const period = parsePeriod(spend.period)
            const limitRaw = BigInt(spend.limit)
            const spentRaw = BigInt(spend.spent)
            const remainingRaw = limitRaw > spentRaw ? limitRaw - spentRaw : 0n

            return {
                id: spendRuleId(token, period),
                hashId: spendHashId(token, period),
                token,
                tokenLabel: tokenLabel(token, chain),
                period,
                limitRaw: limitRaw.toString(),
                spentRaw: spentRaw.toString(),
                remainingRaw: remainingRaw.toString(),
                limit: formatTokenAmount({ token, chain, raw: limitRaw }),
                spent: formatTokenAmount({ token, chain, raw: spentRaw }),
                remaining: formatTokenAmount({ token, chain, raw: remainingRaw }),
            }
        })

        return {
            name: local?.name ?? null,
            nameSource: local ? ('local' as const) : ('none' as const),
            hash: key.hash,
            address,
            type: key.type,
            role: key.role,
            expiryRaw: key.expiry,
            summary: {
                callPermissionCount: calls.length,
                spendLimitCount: spends.length,
                spendUsage,
            },
        }
    })

    return {
        type: 'permissions_list',
        status: 'complete',
        keystorePath,
        network,
        accountAddress,
        keys,
    }
}
