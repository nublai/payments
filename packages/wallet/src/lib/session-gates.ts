import { getAddress, type Address } from 'viem'
import { resolveKeystorePath } from './account-create'
import { readKeystoreBundle, readSessionKeystoreFile, resolveSessionKeystorePath } from './keystore'
import {
    getUsdcTokenConfig,
    resolveNetworkConfig,
    selectDefaultChain,
    type EnvName,
} from './network-config'
import { narrowCallAllowlist, readAccountKeysFromChain } from './session-chain-permissions'
import {
    activeUsdcDailyTotal,
    callPermissionsFitAllowlist,
    callsIncludeWildcard,
    computeSessionKeyHash,
    parseSessionName,
    storedPermissionsRequirePhrase,
} from './session-common'

type GateInput = {
    env: EnvName
    chain?: string
    name?: string
    keystorePath?: string
}

type StoredPermission = {
    type: string
    to?: string
    selector?: string
    token?: string
    limit?: string
    period?: string
}

/**
 * Missing, empty, or unreadable permissions are elevated.
 * A narrow verdict is a non-empty list whose calls sit in the allowlist and
 * whose USDC spend is at most 10 per day.
 */
export function chainPermissionsRequirePhrase(
    permissions: readonly StoredPermission[] | undefined,
    usdcAddress: string | undefined,
    allowedCalls: ReadonlySet<string>,
): boolean {
    if (!permissions || permissions.length === 0) return true
    if (storedPermissionsRequirePhrase(permissions, usdcAddress)) return true
    return !callPermissionsFitAllowlist(permissions, allowedCalls)
}

/**
 * Phrase required unless this session's permissions, read from the account
 * contract, are a positive match for the narrow allowlist.
 * RPC failure, a revert, or an unknown chain is elevated.
 */
export async function sessionOnChainRequiresPhrase(input: {
    env: EnvName
    chain?: string
    account: Address
    sessionAddress: Address
}): Promise<boolean> {
    try {
        const chainName = selectDefaultChain(input.env, input.chain)
        const network = resolveNetworkConfig(input.env, chainName)
        const usdc = getUsdcTokenConfig(chainName).address
        const keys = await readAccountKeysFromChain({
            rpcUrl: network.rpcUrl,
            chainId: network.chainId,
            account: input.account,
        })
        const hash = computeSessionKeyHash(input.sessionAddress)
        const key = keys.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase())
        if (!key) return true
        return chainPermissionsRequirePhrase(
            key.permissions,
            usdc,
            narrowCallAllowlist(input.env, network.chainId),
        )
    } catch {
        return true
    }
}

/**
 * Phrase required when the session's on-chain permissions are above the gate,
 * or when those permissions cannot be read from chain.
 */
export async function storedSessionRequiresPhrase(
    input: GateInput & { sessionName: string },
): Promise<boolean> {
    try {
        const keystorePath = resolveKeystorePath({
            env: input.env,
            name: input.name,
            keystorePath: input.keystorePath,
        })
        const bundle = await readKeystoreBundle(keystorePath)
        const sessionName = parseSessionName(input.sessionName)
        const session = await readSessionKeystoreFile(
            resolveSessionKeystorePath(keystorePath, sessionName, bundle.root.sessionRef.dir),
        )
        const account = getAddress(bundle.root.addresses.delegated ?? bundle.root.addresses.root)
        return sessionOnChainRequiresPhrase({
            env: input.env,
            chain: input.chain,
            account,
            sessionAddress: getAddress(session.addresses.session),
        })
    } catch {
        return true
    }
}

/**
 * Combined active USDC spend on the chain, normalized per day.
 * Pass `excludeSessionName` to omit the session a rotate replaces.
 * Returns `unreadable` when the keys cannot be read from chain.
 */
export async function readActiveUsdcDaily(
    input: GateInput & { excludeSessionName?: string; excludeKeyHash?: string },
): Promise<bigint | 'unreadable'> {
    try {
        const chainName = selectDefaultChain(input.env, input.chain)
        const network = resolveNetworkConfig(input.env, chainName)
        const usdc = getUsdcTokenConfig(chainName).address
        const keystorePath = resolveKeystorePath({
            env: input.env,
            name: input.name,
            keystorePath: input.keystorePath,
        })
        const bundle = await readKeystoreBundle(keystorePath)
        const account = getAddress(bundle.root.addresses.delegated ?? bundle.root.addresses.root)
        const keys = await readAccountKeysFromChain({
            rpcUrl: network.rpcUrl,
            chainId: network.chainId,
            account,
        })
        let excludeHash = input.excludeKeyHash
        if (!excludeHash && input.excludeSessionName) {
            const session = await readSessionKeystoreFile(
                resolveSessionKeystorePath(
                    keystorePath,
                    parseSessionName(input.excludeSessionName),
                    bundle.root.sessionRef.dir,
                ),
            )
            excludeHash = computeSessionKeyHash(getAddress(session.addresses.session))
        }
        return activeUsdcDailyTotal(keys, usdc, excludeHash)
    } catch {
        return 'unreadable'
    }
}

/**
 * True only when the session's on-chain calls include ANY_TARGET or ANY_FN_SEL.
 * Missing keys and a failed chain read fail closed as false.
 */
export async function sessionHasWildcardCall(
    input: GateInput & { sessionName?: string; sessionFile?: string },
): Promise<boolean> {
    try {
        const chainName = selectDefaultChain(input.env, input.chain)
        const network = resolveNetworkConfig(input.env, chainName)
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
            const sessionName = parseSessionName(input.sessionName ?? bundle.root.sessionRef.active)
            const session = await readSessionKeystoreFile(
                resolveSessionKeystorePath(keystorePath, sessionName, bundle.root.sessionRef.dir),
            )
            sessionAddress = getAddress(session.addresses.session)
            account = getAddress(bundle.root.addresses.delegated ?? bundle.root.addresses.root)
        }
        const keys = await readAccountKeysFromChain({
            rpcUrl: network.rpcUrl,
            chainId: network.chainId,
            account,
        })
        const hash = computeSessionKeyHash(sessionAddress)
        const key = keys.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase())
        if (!key) return false
        return callsIncludeWildcard(key.permissions)
    } catch {
        return false
    }
}

export function fullAccessSessionHowTo(kind: 'swap' | 'bridge'): string {
    return `${kind} needs a full-access session. The default session can only transfer and approve this chain's USDC and call escrow (escrow, refund, settler write, and settle), with a 10 USDC daily spend. Create one with \`tw session create <name> --full-access\` and type CREATE FULL ACCESS SESSION.`
}
