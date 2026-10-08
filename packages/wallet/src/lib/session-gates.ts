import { getAddress, type Address } from 'viem'
import { resolveKeystorePath } from './account-create'
import { readKeystoreBundle, readSessionKeystoreFile, resolveSessionKeystorePath } from './keystore'
import {
    chainsForEnv,
    getChainConfig,
    getUsdcTokenConfig,
    resolveNetworkConfig,
    rpcUrlForChain,
    selectDefaultChain,
    type EnvName,
} from './network-config'
import {
    narrowCallAllowlist,
    readAccountKeysFromChain,
    readSessionChainGuard,
} from './session-chain-permissions'
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
 * Narrow only when the key's own calls, the ANY_KEYHASH calls, and every call
 * checker sit in the allowlist, and the key has a USDC spend of at most 10/day.
 * Any call checker is elevated: `callCheckerInfos` lists the checker contract,
 * and that contract's `canExecute` is arbitrary code.
 */
export function accountStateRequiresPhrase(input: {
    permissions: readonly StoredPermission[] | undefined
    anyCalls: readonly StoredPermission[]
    checkerCount: number
    usdcAddress: string | undefined
    allowedCalls: ReadonlySet<string>
}): boolean {
    if (input.checkerCount > 0) return true

    if (!input.permissions || input.permissions.length === 0) return true

    if (storedPermissionsRequirePhrase(input.permissions, input.usdcAddress)) return true

    return !callPermissionsFitAllowlist([...input.permissions, ...input.anyCalls], input.allowedCalls)
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

async function chainVerdict(input: {
    env: EnvName
    chainName: ReturnType<typeof chainsForEnv>[number]
    account: Address
    sessionAddress: Address
}): Promise<'absent' | 'narrow' | 'elevated'> {
    const chain = getChainConfig(input.chainName)
    const usdc = getUsdcTokenConfig(input.chainName).address

    const guard = await readSessionChainGuard({
        rpcUrl: rpcUrlForChain(input.chainName),
        chainId: chain.chainId,
        account: input.account,
        keyHash: computeSessionKeyHash(input.sessionAddress),
    })

    if (!guard.key) return 'absent'

    const elevated = accountStateRequiresPhrase({
        permissions: guard.key.permissions,
        anyCalls: guard.anyCalls,
        checkerCount: guard.checkerCount,
        usdcAddress: usdc,
        allowedCalls: narrowCallAllowlist(input.env, chain.chainId),
    })

    return elevated ? 'elevated' : 'narrow'
}

/**
 * Phrase required unless every configured chain for this env shows the session
 * as a positive match for the narrow allowlist.
 * A chain the key is not on is skipped. An RPC failure, a revert, or an
 * unreadable checker list on any configured chain is elevated.
 */
export async function sessionOnChainRequiresPhrase(input: {
    env: EnvName
    chain?: string
    account: Address
    sessionAddress: Address
}): Promise<boolean> {
    let sawKey = false

    for (const chainName of chainsForEnv(input.env)) {
        try {
            const verdict = await chainVerdict({
                env: input.env,
                chainName,
                account: input.account,
                sessionAddress: input.sessionAddress,
            })

            if (verdict === 'elevated') return true

            if (verdict === 'narrow') sawKey = true
        } catch {
            return true
        }
    }

    // Every chain was readable and none of them authorized this key.
    if (!sawKey) return true

    return false
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
            rpcUrl: rpcUrlForChain(chainName),
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
            rpcUrl: rpcUrlForChain(chainName),
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
    return `${kind} needs a dedicated swap session, not the payment key and not a wildcard. Create one with \`tw session create <name> --swap --chain <chain>\` and type CREATE SWAP SESSION. Pass it with --session <name>. The payment session stays active.`
}
