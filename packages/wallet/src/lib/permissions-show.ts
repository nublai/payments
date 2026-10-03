import { getAddress, type Address, type Hex } from 'viem'
import type { GetKeysResponse, PermissionInfo } from '@agentic-payments/relayer-client'
import { resolveKeystorePath } from './account-create'
import { readKeystoreBundle, readSessionKeystoreFile, resolveSessionKeystorePath } from './keystore'
import {
    resolveNetworkConfig,
    selectDefaultChain,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
} from './network-config'
import {
    callHashId,
    callRuleId,
    deriveKeyAddress,
    formatTokenAmount,
    normalizeHexLower,
    parsePeriod,
    resolveSelectedKey,
    selectorLabel,
    spendHashId,
    spendRuleId,
    tokenLabel,
    type KeySelector,
    type LocalKeyMeta,
    type OnChainPermissionKey,
} from './permissions-common'
import { createCliRelayerClient } from './relayer-client-utils'
import {
    computeSessionKeyHash,
    getChainKeys,
    listSessionNames,
    parseSessionName,
} from './session-common'

export type PermissionsShowResult = {
    type: 'permissions_show'
    status: 'complete'
    keystorePath: string
    network: CliNetworkConfig
    accountAddress: Address
    key: {
        name: string | null
        nameSource: 'local' | 'none'
        hash: Hex
        address: Address
        type: 'secp256k1' | 'external'
        role: 'admin' | 'normal'
        expiryRaw: Hex
    }
    callPermissions: Array<{
        id: string
        hashId: Hex
        target: Address
        targetLabel?: string
        selector: Hex
        selectorLabel?: string
    }>
    spendLimits: Array<{
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

type PermissionsShowDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    listSessionNames: typeof listSessionNames
    readSessionKeystoreFile: typeof readSessionKeystoreFile
    getKeys: (input: {
        network: CliNetworkConfig
        account: Address
        chainId: number
    }) => Promise<GetKeysResponse>
}

function getDefaultDeps(): PermissionsShowDeps {
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
    deps: PermissionsShowDeps
    keystorePath: string
    sessionsDir: string
}): Promise<LocalKeyMeta[]> {
    const names = await input.deps.listSessionNames(input.keystorePath, input.sessionsDir)
    const result: LocalKeyMeta[] = []

    for (const rawName of names) {
        const name = parseSessionName(rawName)
        const sessionPath = resolveSessionKeystorePath(input.keystorePath, name, input.sessionsDir)
        const session = await input.deps.readSessionKeystoreFile(sessionPath)
        const address = getAddress(session.addresses.session)
        result.push({
            name,
            address,
            hash: computeSessionKeyHash(address),
        })
    }

    return result
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

export async function executePermissionsShow(
    options: {
        env: EnvName
        chain?: ChainName
        name?: string
        keystorePath?: string
        keyRef?: string
        keyName?: string
        keyHash?: Hex
    },
    depsArg?: Partial<PermissionsShowDeps>,
): Promise<PermissionsShowResult> {
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

    const selected = resolveSelectedKey({
        selector: {
            positional: options.keyRef,
            keyName: options.keyName,
            keyHash: options.keyHash,
        } as KeySelector,
        keys: chainKeys,
        localKeys,
    })

    const { key, local } = selected
    const address = deriveKeyAddress(key)

    const { calls, spends } = splitPermissions(key.permissions)

    const callPermissions = calls.map((permission) => {
        const target = getAddress(permission.to)
        const selector = normalizeHexLower(permission.selector)
        return {
            id: callRuleId(target, selector),
            hashId: callHashId(target, selector),
            target,
            targetLabel: tokenLabel(target, chain),
            selector,
            selectorLabel: selectorLabel(selector),
        }
    })

    const spendLimits = spends.map((permission) => {
        const token = getAddress(permission.token)
        const period = parsePeriod(permission.period)
        const limitRaw = BigInt(permission.limit)
        const spentRaw = BigInt(permission.spent)
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
        type: 'permissions_show',
        status: 'complete',
        keystorePath,
        network,
        accountAddress,
        key: {
            name: local?.name ?? null,
            nameSource: local ? 'local' : 'none',
            hash: key.hash,
            address,
            type: key.type,
            role: key.role,
            expiryRaw: key.expiry,
        },
        callPermissions,
        spendLimits,
    }
}
