import { getAddress, type Address, type Hex } from 'viem'
import type { GetKeysResponse } from '@towns-labs/relayer-client'
import { resolveKeystorePath } from './account-create'
import {
    readKeystoreBundle,
    readSessionKeystoreFile,
    resolveSessionKeystorePath,
    type AnySessionKeystore,
    type RelayerSessionKeystoreV2,
} from './keystore'
import {
    resolveNetworkConfig,
    selectDefaultChain,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
} from './network-config'
import { createCliRelayerClient } from './relayer-client-utils'
import {
    computeSessionKeyHash,
    getChainKeys,
    listSessionNames,
    parseSessionName,
} from './session-common'

type SessionListErrorCode =
    | 'INVALID_NAME'
    | 'KEYSTORE_NOT_FOUND'
    | 'SESSION_LIST_FAILED'
    | 'UNKNOWN'

export class SessionListError extends Error {
    code: SessionListErrorCode
    cause?: unknown

    constructor(code: SessionListErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'SessionListError'
        this.code = code
        this.cause = options?.cause
    }
}

export type SessionListResult = {
    type: 'session_list'
    status: 'complete'
    keystorePath: string
    network: CliNetworkConfig
    activeSession: string
    sessions: Array<{
        name: string
        address: Address
        keyHash: Hex
        active: boolean
        kind: 'session' | 'agent'
        checkpoint: RelayerSessionKeystoreV2['checkpoint']
        onChainAuthorized?: boolean
        expiry?: number
    }>
}

type SessionListDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    readSessionKeystoreFile: (path: string) => Promise<AnySessionKeystore>
    listSessionNames: typeof listSessionNames
    getKeys: (input: {
        network: CliNetworkConfig
        account: Address
        chainId: number
    }) => Promise<GetKeysResponse>
}

function getDefaultDeps(): SessionListDeps {
    return {
        readKeystoreBundle,
        readSessionKeystoreFile,
        listSessionNames,
        getKeys: async ({ network, account, chainId }) => {
            const client = createCliRelayerClient(network)
            return client.getKeys({ address: account, chainIds: [chainId] })
        },
    }
}

export async function executeSessionList(
    options: {
        env: EnvName
        chain?: ChainName
        name?: string
        keystorePath?: string
        onChain?: boolean
    },
    depsArg?: Partial<SessionListDeps>,
): Promise<SessionListResult> {
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

    const sessionNames = await deps.listSessionNames(keystorePath, bundle.root.sessionRef.dir)
    const sessions: SessionListResult['sessions'] = []

    for (const sessionNameRaw of sessionNames) {
        const sessionName = parseSessionName(sessionNameRaw)
        const sessionPath = resolveSessionKeystorePath(
            keystorePath,
            sessionName,
            bundle.root.sessionRef.dir,
        )
        const session = await deps.readSessionKeystoreFile(sessionPath)
        sessions.push({
            name: session.name,
            address: getAddress(session.addresses.session),
            keyHash: computeSessionKeyHash(getAddress(session.addresses.session)),
            active: session.name === bundle.root.sessionRef.active,
            kind: session.kind === 'agent' ? 'agent' : 'session',
            checkpoint: session.checkpoint,
        })
    }

    if (options.onChain) {
        const keys = await deps.getKeys({
            network,
            account: accountAddress,
            chainId: network.chainId,
        })
        const chainKeys = getChainKeys(keys, network.chainId)
        const keysByHash = new Map<string, { expiry?: string }>(
            chainKeys
                .filter((entry: { hash?: string }) => typeof entry.hash === 'string')
                .map((entry: { hash?: string; expiry?: string }) => [
                    entry.hash!.toLowerCase(),
                    entry,
                ]),
        )

        for (const session of sessions) {
            const onChainKey = keysByHash.get(session.keyHash.toLowerCase())
            session.onChainAuthorized = onChainKey !== undefined
            if (onChainKey && typeof onChainKey.expiry === 'string') {
                session.expiry = Number(onChainKey.expiry)
            }
        }
    }

    return {
        type: 'session_list',
        status: 'complete',
        keystorePath,
        network,
        activeSession: bundle.root.sessionRef.active,
        sessions,
    }
}
