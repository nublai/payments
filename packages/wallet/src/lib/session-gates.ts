import { getAddress, type Address } from 'viem'
import { resolveKeystorePath } from './account-create'
import { readKeystoreBundle, readSessionKeystoreFile, resolveSessionKeystorePath } from './keystore'
import {
    getUsdcTokenConfig,
    resolveNetworkConfig,
    selectDefaultChain,
    type EnvName,
} from './network-config'
import { createCliRelayerClient } from './relayer-client-utils'
import {
    activeUsdcDailyTotal,
    callsIncludeWildcard,
    computeSessionKeyHash,
    getChainKeys,
    parseSessionName,
    storedPermissionsRequirePhrase,
} from './session-common'

type GateInput = {
    env: EnvName
    chain?: string
    name?: string
    keystorePath?: string
}

async function loadChainKeys(input: GateInput): Promise<
    | {
          keys: ReturnType<typeof getChainKeys>
          usdc: Address
          keystorePath: string
          sessionsDir: string
      }
    | 'unreadable'
> {
    try {
        const chain = selectDefaultChain(input.env, input.chain)
        const network = resolveNetworkConfig(input.env, chain)
        const usdc = getUsdcTokenConfig(chain).address
        const keystorePath = resolveKeystorePath({
            env: input.env,
            name: input.name,
            keystorePath: input.keystorePath,
        })
        const bundle = await readKeystoreBundle(keystorePath)
        const account = getAddress(bundle.root.addresses.delegated ?? bundle.root.addresses.root)
        const client = createCliRelayerClient(network)
        const keys = await client.getKeys({ address: account, chainIds: [network.chainId] })
        return {
            keys: getChainKeys(keys, network.chainId),
            usdc,
            keystorePath,
            sessionsDir: bundle.root.sessionRef.dir,
        }
    } catch {
        return 'unreadable'
    }
}

/**
 * Phrase required when the session's stored permissions are above the gate,
 * or when those permissions cannot be read.
 */
export async function storedSessionRequiresPhrase(
    input: GateInput & { sessionName: string },
): Promise<boolean> {
    const loaded = await loadChainKeys(input)
    if (loaded === 'unreadable') return true
    try {
        const sessionName = parseSessionName(input.sessionName)
        const session = await readSessionKeystoreFile(
            resolveSessionKeystorePath(loaded.keystorePath, sessionName, loaded.sessionsDir),
        )
        const hash = computeSessionKeyHash(getAddress(session.addresses.session))
        const key = loaded.keys.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase())
        if (!key) return true
        return storedPermissionsRequirePhrase(key.permissions, loaded.usdc)
    } catch {
        return true
    }
}

/**
 * Combined active USDC spend on the chain, normalized per day.
 * Pass `excludeSessionName` to omit the session a rotate replaces.
 * Returns `unreadable` when the keys cannot be determined.
 */
export async function readActiveUsdcDaily(
    input: GateInput & { excludeSessionName?: string; excludeKeyHash?: string },
): Promise<bigint | 'unreadable'> {
    const loaded = await loadChainKeys(input)
    if (loaded === 'unreadable') return 'unreadable'
    let excludeHash = input.excludeKeyHash
    if (!excludeHash && input.excludeSessionName) {
        try {
            const session = await readSessionKeystoreFile(
                resolveSessionKeystorePath(
                    loaded.keystorePath,
                    parseSessionName(input.excludeSessionName),
                    loaded.sessionsDir,
                ),
            )
            excludeHash = computeSessionKeyHash(getAddress(session.addresses.session))
        } catch {
            return 'unreadable'
        }
    }
    return activeUsdcDailyTotal(loaded.keys, loaded.usdc, excludeHash)
}

/**
 * True only when the session's on-chain calls include ANY_TARGET or ANY_FN_SEL.
 * Missing keys fail closed as false.
 */
export async function sessionHasWildcardCall(
    input: GateInput & { sessionName?: string; sessionFile?: string },
): Promise<boolean> {
    try {
        const chain = selectDefaultChain(input.env, input.chain)
        const network = resolveNetworkConfig(input.env, chain)
        let sessionAddress: Address
        let account: Address
        if (input.sessionFile) {
            const session = await readSessionKeystoreFile(input.sessionFile)
            sessionAddress = getAddress(session.addresses.session)
            const delegated = session.addresses.delegated
            if (!delegated) return false
            account = getAddress(delegated)
        } else {
            const keystorePath = resolveKeystorePath({
                env: input.env,
                name: input.name,
                keystorePath: input.keystorePath,
            })
            const bundle = await readKeystoreBundle(keystorePath)
            const sessionName = parseSessionName(
                input.sessionName ?? bundle.root.sessionRef.active,
            )
            const session = await readSessionKeystoreFile(
                resolveSessionKeystorePath(keystorePath, sessionName, bundle.root.sessionRef.dir),
            )
            sessionAddress = getAddress(session.addresses.session)
            account = getAddress(bundle.root.addresses.delegated ?? bundle.root.addresses.root)
        }
        const client = createCliRelayerClient(network)
        const keys = await client.getKeys({ address: account, chainIds: [network.chainId] })
        const hash = computeSessionKeyHash(sessionAddress)
        const key = getChainKeys(keys, network.chainId).find(
            (entry) => entry.hash.toLowerCase() === hash.toLowerCase(),
        )
        if (!key) return false
        return callsIncludeWildcard(key.permissions)
    } catch {
        return false
    }
}

export function fullAccessSessionHowTo(kind: 'swap' | 'bridge'): string {
    return `${kind} needs a full-access session. The default session can only transfer and approve this chain's USDC and call escrow (escrow, refund, settler write, and settle), with a 10 USDC daily spend. Create one with \`tw session create <name> --full-access\` and type CREATE FULL ACCESS SESSION.`
}
