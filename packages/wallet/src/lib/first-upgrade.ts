import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
    createPublicClient,
    decodeFunctionData,
    encodeAbiParameters,
    encodeFunctionData,
    erc20Abi,
    getAddress,
    http,
    type Address,
    type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hashAuthorization } from 'viem/utils'
import { accountAbi } from '@nubl/contracts/abis'
import {
    bindPreparedCalls,
    buildUpgradeExecution,
    createRelayerTransport,
    encodeSecp256k1Key,
    firstQuotePaymentAmount,
    getChain,
    INTENT_EXPIRY_TTL_SECONDS,
    ORCHESTRATOR_DOMAIN_NAME,
    ORCHESTRATOR_DOMAIN_VERSION,
    resolveSignedFeeCap,
    SIGNED_CALL_TYPES,
    UPGRADE_PRECALL_NONCE,
    waitForBundle,
    type AuthorizeKey,
    type Call,
    type Permission,
    type PrepareCallsResponse,
} from '@nubl/relayer-client'
import { delegateAccountWithAuthorizeKeys, hasDelegationCode } from './delegation-utils'
import { executeSignedCalls } from './execute-calls'
import { PAID_FEE_CAP } from './intent-payment'
import { getUsdcAddressByChainId, type CliNetworkConfig } from './network-config'
import { readAccountNonce } from './nonce-utils'
import { resolveAccountProxyAddress, resolveOrchestratorAddress } from './orchestrator-address'
import { createCliRelayerClient, createEthHttpSigner } from './relayer-client-utils'
import { computeSessionKeyHash, toSpendPeriodEnum } from './session-common'

/**
 * Same 500_000 type-4 hold the relayer signs. Do not raise it.
 * A quote above this is refused and the account stays on the sponsored path.
 */
export const PAID_UPGRADE_GAS_HOLD = 500_000n

export type InstalledPermission =
    | { type: 'call'; to: Address; selector: Hex }
    | { type: 'spend'; token: Address; limit: string; period: string }

export type InstalledSessionKey = {
    hash: Hex
    role: 'admin' | 'normal'
    permissions: InstalledPermission[]
}

export type PaidUpgradeMarker = {
    version: 1
    chainId: number
    sessionAddress: Address
    keyHash: Hex
    status: 'authorizing' | 'key_authorized' | 'permissions_submitted'
    bundleId?: string
    upgradeTxHash?: Hex
    gas?: string
}

type FirstUpgradeErrorCode = 'PERMISSIONS_PENDING' | 'UPGRADE_FAILED' | 'SESSION_KEY_ADMIN'

export class FirstUpgradeError extends Error {
    code: FirstUpgradeErrorCode
    recoveryCommand?: string
    cause?: unknown

    constructor(
        code: FirstUpgradeErrorCode,
        message: string,
        options?: { recoveryCommand?: string; cause?: unknown },
    ) {
        super(message)
        this.name = 'FirstUpgradeError'
        this.code = code
        this.recoveryCommand = options?.recoveryCommand
        this.cause = options?.cause
    }
}

export type FirstUpgradeResult = {
    accountAddress: Address
    txHash?: Hex
    permissionsTxHash?: Hex
    path: 'paid' | 'sponsored'
    resumed: boolean
    noop: boolean
}

/**
 * PR 23 decides the paid path on the relayer: USDC balance must cover the
 * quoted fee, the fee must be greater than zero, quote plus margin must fit
 * under 5 USDC, and the type-4 estimate must fit under the 500k hold.
 * There is no wallet-side check on that branch.
 *
 * This is that gate, and nothing broader. A zero balance cannot satisfy
 * `balance >= paymentAmount`, so it stays on sponsored `upgradeAccount`.
 * A positive balance attempts the paid prepare. A refusal for insufficient
 * balance, a zero fee, the 5 USDC cap, or the 500k hold also stays on the
 * sponsored upgrade, with the full pre-call. A balance read that throws
 * cannot prove the fee is covered, so it takes the sponsored path too.
 */
export function usdcBalanceTakesPaidPath(balance: bigint): boolean {
    return balance > 0n
}

export function paidUpgradeRefusalUsesSponsoredPath(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return (
        message.includes('Insufficient USDC balance') ||
        message.includes('Paid upgrade fee must be greater than zero') ||
        message.includes('exceeds the reserved hold') ||
        message.includes('exceeds cap') ||
        message.includes('exceeds the quoted fee cap') ||
        message.includes('payment amount exceeds fee cap') ||
        message.includes('quote payment is zero') ||
        message.includes('Refusing to sign a zero fee quote') ||
        message.includes('combined gas exceeds the wallet ceiling')
    )
}

export function quotedGasWithinHold(gas: bigint): boolean {
    return gas > 0n && gas <= PAID_UPGRADE_GAS_HOLD
}

export function bareSessionAuthorizeKey(sessionAddress: Address): AuthorizeKey {
    return {
        expiry: '0',
        type: 'secp256k1',
        role: 'normal',
        publicKey: encodeSecp256k1Key(sessionAddress),
        permissions: [],
    }
}

export function fullSessionAuthorizeKey(
    sessionAddress: Address,
    permissions: Permission[],
): AuthorizeKey {
    return {
        expiry: '0',
        type: 'secp256k1',
        role: 'normal',
        publicKey: encodeSecp256k1Key(sessionAddress),
        permissions,
    }
}

export function authorizeCalldataIsNormal(data: Hex): boolean {
    try {
        const decoded = decodeFunctionData({ abi: accountAbi, data })
        if (decoded.functionName !== 'authorize') return false
        const key = decoded.args[0] as {
            isSuperAdmin: boolean
            expiry: number | bigint
        }
        return key.isSuperAdmin === false && Number(key.expiry) === 0
    } catch {
        return false
    }
}

export function buildBareUpgrade(account: Address, sessionAddress: Address) {
    const key = bareSessionAuthorizeKey(sessionAddress)
    const built = buildUpgradeExecution([key], account)
    if (built.calls.length !== 1 || !authorizeCalldataIsNormal(built.calls[0]!.data)) {
        throw new FirstUpgradeError(
            'SESSION_KEY_ADMIN',
            'The default session key must be authorized as a normal key, not admin or super-admin.',
        )
    }
    for (const call of built.calls) {
        const decoded = decodeFunctionData({ abi: accountAbi, data: call.data })
        if (decoded.functionName !== 'authorize') {
            throw new FirstUpgradeError(
                'UPGRADE_FAILED',
                'Paid upgrade pre-call must carry exactly one authorize.',
            )
        }
    }
    return built
}

export function missingPermissionCalls(input: {
    account: Address
    keyHash: Hex
    permissions: Permission[]
    installed: InstalledPermission[]
}): Call[] {
    const calls: Call[] = []
    for (const permission of input.permissions) {
        if (permission.type !== 'spend') continue
        const existing = input.installed.find(
            (entry) =>
                entry.type === 'spend' &&
                entry.token.toLowerCase() === permission.token.toLowerCase() &&
                entry.period === permission.period,
        )
        if (existing && existing.type === 'spend') {
            if (BigInt(existing.limit) !== BigInt(permission.limit)) {
                throw new FirstUpgradeError(
                    'UPGRADE_FAILED',
                    'A spend limit is already installed for this session key. Refusing to install it again.',
                )
            }
            continue
        }
        calls.push({
            target: input.account,
            value: 0n,
            data: encodeFunctionData({
                abi: accountAbi,
                functionName: 'setSpendLimit',
                args: [
                    input.keyHash,
                    permission.token,
                    toSpendPeriodEnum(permission.period),
                    BigInt(permission.limit),
                ],
            }),
        })
    }
    for (const permission of input.permissions) {
        if (permission.type !== 'call') continue
        const present = input.installed.some(
            (entry) =>
                entry.type === 'call' &&
                entry.to.toLowerCase() === permission.to.toLowerCase() &&
                entry.selector.toLowerCase() === permission.selector.toLowerCase(),
        )
        if (present) continue
        calls.push({
            target: input.account,
            value: 0n,
            data: encodeFunctionData({
                abi: accountAbi,
                functionName: 'setCanExecute',
                args: [input.keyHash, permission.to, permission.selector, true],
            }),
        })
    }
    return calls
}

export function permissionsPendingMessage(keystorePath: string): string {
    const command = `tw account create --resume --keystore-path ${JSON.stringify(keystorePath)}`
    return `The session key is authorized, but its permissions are not installed yet. It cannot execute or spend until you resume. ${command}`
}

export function paidUpgradeMarkerPath(
    keystorePath: string,
    sessionsDir = 'sessions',
    chainId: number,
): string {
    return join(dirname(keystorePath), sessionsDir, `.paid-upgrade-${chainId}.json`)
}

export async function readPaidUpgradeMarker(path: string): Promise<PaidUpgradeMarker | null> {
    let content: string
    try {
        content = await readFile(path, 'utf8')
    } catch (error) {
        if (isEnoent(error)) return null
        throw error
    }
    return parsePaidUpgradeMarker(JSON.parse(content))
}

export async function writePaidUpgradeMarker(
    path: string,
    marker: PaidUpgradeMarker,
): Promise<void> {
    const directory = dirname(path)
    const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await mkdir(directory, { recursive: true })
    await writeFile(tempPath, `${JSON.stringify(marker, null, 2)}\n`, {
        mode: 0o600,
    })
    await rename(tempPath, path)
    if (process.platform !== 'win32') {
        await chmod(path, 0o600)
    }
    const file = await stat(path)
    if (file.size === 0) {
        await unlink(path)
        throw new FirstUpgradeError('UPGRADE_FAILED', `Refusing to keep an empty marker at ${path}`)
    }
}

export async function deletePaidUpgradeMarker(path: string): Promise<void> {
    try {
        await unlink(path)
    } catch (error) {
        if (isEnoent(error)) return
        throw error
    }
}

type PaidPrepareResult = {
    gas: bigint
    context: PrepareCallsResponse['context']
    typedData: PrepareCallsResponse['typedData']
}

type FirstUpgradeDeps = {
    readUsdcBalance: () => Promise<bigint>
    readDelegationCode: () => Promise<Hex | undefined>
    readSessionKey: () => Promise<InstalledSessionKey | null>
    preparePaidUpgrade: (input: {
        upgrade: ReturnType<typeof buildBareUpgrade>
        account: Address
        sessionAddress: Address
        rootPrivateKey: Hex
        network: CliNetworkConfig
    }) => Promise<PaidPrepareResult>
    signPaidIntent: (input: {
        typedData: PrepareCallsResponse['typedData']
        rootPrivateKey: Hex
    }) => Promise<Hex>
    sendPaidUpgrade: (input: {
        gas: bigint
        context: PrepareCallsResponse['context']
        signature: Hex
        network: CliNetworkConfig
        rootPrivateKey: Hex
    }) => Promise<{ id: string; txHash?: Hex }>
    waitPaidUpgrade: (input: {
        id: string
        network: CliNetworkConfig
        rootPrivateKey: Hex
    }) => Promise<{ success: boolean; txHash?: Hex; error?: string }>
    installPermissions: (input: {
        calls: Call[]
        account: Address
        rootPrivateKey: Hex
        network: CliNetworkConfig
    }) => Promise<{ txHash?: Hex }>
    sponsoredUpgrade: (input: {
        authorizeKey: AuthorizeKey
        rootPrivateKey: Hex
        sessionAddress: Address
        network: CliNetworkConfig
    }) => Promise<{ accountAddress: Address; txHash?: Hex }>
    readMarker: () => Promise<PaidUpgradeMarker | null>
    writeMarker: (marker: PaidUpgradeMarker) => Promise<void>
    deleteMarker: () => Promise<void>
    sleep: (ms: number) => Promise<void>
}

export async function runFirstUpgrade(
    input: {
        rootPrivateKey: Hex
        sessionAddress: Address
        network: CliNetworkConfig
        permissions: Permission[]
        keystorePath?: string
        sessionsDir?: string
        onKeyAuthorized?: (accountAddress: Address) => Promise<void>
    },
    depsArg?: Partial<FirstUpgradeDeps>,
): Promise<FirstUpgradeResult> {
    const account = privateKeyToAccount(input.rootPrivateKey).address
    const keyHash = computeSessionKeyHash(input.sessionAddress)
    const deps: FirstUpgradeDeps = {
        ...defaultDeps(input, account, keyHash),
        ...depsArg,
    }
    const code = await deps.readDelegationCode()
    const delegated = hasDelegationCode(code)
    let key = delegated ? await deps.readSessionKey() : null
    if (key?.role === 'admin') {
        throw new FirstUpgradeError(
            'SESSION_KEY_ADMIN',
            'The default session key is authorized as admin. Refusing to install permissions on it.',
        )
    }
    if (key && permissionsComplete(key.permissions, input.permissions)) {
        await deps.deleteMarker()
        return {
            accountAddress: account,
            path: 'paid',
            resumed: true,
            noop: true,
        }
    }
    if (key) {
        return installMissingPermissions({
            input,
            deps,
            account,
            keyHash,
            upgradeTxHash: (await deps.readMarker())?.upgradeTxHash,
            resumed: true,
        })
    }

    const marker = await deps.readMarker()
    if (marker?.status === 'authorizing' && marker.bundleId) {
        const waited = await deps.waitPaidUpgrade({
            id: marker.bundleId,
            network: input.network,
            rootPrivateKey: input.rootPrivateKey,
        })
        if (waited.success) {
            await markAuthorized(deps, input, account, keyHash, waited.txHash)
            return installMissingPermissions({
                input,
                deps,
                account,
                keyHash,
                upgradeTxHash: waited.txHash,
                resumed: true,
            })
        }
    }

    if (delegated) {
        throw new FirstUpgradeError(
            'UPGRADE_FAILED',
            'Account is delegated and the session key is not authorized. Refusing another paid upgrade.',
        )
    }

    let balance = 0n
    try {
        balance = await deps.readUsdcBalance()
    } catch {
        balance = 0n
    }
    const sponsoredKey = fullSessionAuthorizeKey(input.sessionAddress, input.permissions)
    if (!usdcBalanceTakesPaidPath(balance)) {
        const sponsored = await deps.sponsoredUpgrade({
            authorizeKey: sponsoredKey,
            rootPrivateKey: input.rootPrivateKey,
            sessionAddress: input.sessionAddress,
            network: input.network,
        })
        return {
            accountAddress: sponsored.accountAddress,
            txHash: sponsored.txHash,
            path: 'sponsored',
            resumed: false,
            noop: false,
        }
    }

    const upgrade = buildBareUpgrade(account, input.sessionAddress)
    let prepared: PaidPrepareResult
    try {
        prepared = await deps.preparePaidUpgrade({
            upgrade,
            account,
            sessionAddress: input.sessionAddress,
            rootPrivateKey: input.rootPrivateKey,
            network: input.network,
        })
        if (!quotedGasWithinHold(prepared.gas)) {
            throw new Error(
                `Paid upgrade gas limit exceeds the reserved hold (${prepared.gas} > ${PAID_UPGRADE_GAS_HOLD})`,
            )
        }
    } catch (error) {
        if (!paidUpgradeRefusalUsesSponsoredPath(error)) throw error
        const sponsored = await deps.sponsoredUpgrade({
            authorizeKey: sponsoredKey,
            rootPrivateKey: input.rootPrivateKey,
            sessionAddress: input.sessionAddress,
            network: input.network,
        })
        return {
            accountAddress: sponsored.accountAddress,
            txHash: sponsored.txHash,
            path: 'sponsored',
            resumed: false,
            noop: false,
        }
    }

    await deps.writeMarker({
        version: 1,
        chainId: input.network.chainId,
        sessionAddress: input.sessionAddress,
        keyHash,
        status: 'authorizing',
        gas: prepared.gas.toString(),
    })
    const signature = await deps.signPaidIntent({
        typedData: prepared.typedData,
        rootPrivateKey: input.rootPrivateKey,
    })
    const sent = await deps.sendPaidUpgrade({
        gas: prepared.gas,
        context: prepared.context,
        signature,
        network: input.network,
        rootPrivateKey: input.rootPrivateKey,
    })
    await deps.writeMarker({
        version: 1,
        chainId: input.network.chainId,
        sessionAddress: input.sessionAddress,
        keyHash,
        status: 'authorizing',
        bundleId: sent.id,
        gas: prepared.gas.toString(),
    })
    const waited = await deps.waitPaidUpgrade({
        id: sent.id,
        network: input.network,
        rootPrivateKey: input.rootPrivateKey,
    })
    if (!waited.success) {
        throw new FirstUpgradeError(
            'UPGRADE_FAILED',
            waited.error ?? 'Paid upgrade was not accepted.',
        )
    }
    const upgradeTxHash = waited.txHash ?? sent.txHash
    await markAuthorized(deps, input, account, keyHash, upgradeTxHash)
    return installMissingPermissions({
        input,
        deps,
        account,
        keyHash,
        upgradeTxHash,
        resumed: false,
    })
}

async function markAuthorized(
    deps: FirstUpgradeDeps,
    input: {
        sessionAddress: Address
        network: CliNetworkConfig
        onKeyAuthorized?: (accountAddress: Address) => Promise<void>
    },
    account: Address,
    keyHash: Hex,
    upgradeTxHash?: Hex,
): Promise<void> {
    await deps.writeMarker({
        version: 1,
        chainId: input.network.chainId,
        sessionAddress: input.sessionAddress,
        keyHash,
        status: 'key_authorized',
        upgradeTxHash,
    })
    await input.onKeyAuthorized?.(account)
}

async function installMissingPermissions(args: {
    input: {
        rootPrivateKey: Hex
        sessionAddress: Address
        network: CliNetworkConfig
        permissions: Permission[]
        keystorePath?: string
    }
    deps: FirstUpgradeDeps
    account: Address
    keyHash: Hex
    upgradeTxHash?: Hex
    resumed: boolean
}): Promise<FirstUpgradeResult> {
    const { input, deps, account, keyHash } = args
    let key = await deps.readSessionKey()
    if (!key) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            await deps.sleep(200 * (attempt + 1))
            key = await deps.readSessionKey()
            if (key) break
        }
    }
    if (key?.role === 'admin') {
        throw new FirstUpgradeError(
            'SESSION_KEY_ADMIN',
            'The default session key is authorized as admin. Refusing to install permissions on it.',
        )
    }
    const calls = missingPermissionCalls({
        account,
        keyHash,
        permissions: input.permissions,
        installed: key?.permissions ?? [],
    })
    if (calls.length === 0) {
        await deps.deleteMarker()
        return {
            accountAddress: account,
            txHash: args.upgradeTxHash,
            path: 'paid',
            resumed: args.resumed,
            noop: true,
        }
    }
    await deps.writeMarker({
        version: 1,
        chainId: input.network.chainId,
        sessionAddress: input.sessionAddress,
        keyHash,
        status: 'key_authorized',
        upgradeTxHash: args.upgradeTxHash,
    })
    try {
        const installed = await deps.installPermissions({
            calls,
            account,
            rootPrivateKey: input.rootPrivateKey,
            network: input.network,
        })
        await deps.deleteMarker()
        return {
            accountAddress: account,
            txHash: args.upgradeTxHash,
            permissionsTxHash: installed.txHash,
            path: 'paid',
            resumed: args.resumed,
            noop: false,
        }
    } catch (error) {
        if (error instanceof FirstUpgradeError && error.code === 'PERMISSIONS_PENDING') throw error
        const text = input.keystorePath
            ? permissionsPendingMessage(input.keystorePath)
            : 'The session key is authorized, but its permissions are not installed yet. It cannot execute or spend until you resume.'
        const detail = error instanceof Error ? error.message : String(error)
        throw new FirstUpgradeError('PERMISSIONS_PENDING', `${text} ${detail}`, {
            recoveryCommand: input.keystorePath
                ? `tw account create --resume --keystore-path ${JSON.stringify(input.keystorePath)}`
                : undefined,
            cause: error,
        })
    }
}

function permissionsComplete(installed: InstalledPermission[], wanted: Permission[]): boolean {
    return (
        missingPermissionCalls({
            account: '0x0000000000000000000000000000000000000001',
            keyHash: `0x${'11'.repeat(32)}`,
            permissions: wanted,
            installed,
        }).length === 0
    )
}

function defaultDeps(
    input: {
        rootPrivateKey: Hex
        sessionAddress: Address
        network: CliNetworkConfig
        keystorePath?: string
        sessionsDir?: string
    },
    account: Address,
    keyHash: Hex,
): FirstUpgradeDeps {
    const markerPath = input.keystorePath
        ? paidUpgradeMarkerPath(
              input.keystorePath,
              input.sessionsDir ?? 'sessions',
              input.network.chainId,
          )
        : undefined
    let memory: PaidUpgradeMarker | null = null
    return {
        readUsdcBalance: () => readUsdcBalance(input.network, account),
        readDelegationCode: async () => {
            const { readAccountCode } = await import('./delegation-utils')
            return readAccountCode({ network: input.network, address: account })
        },
        readSessionKey: () => readSessionKey(input.network, account, input.sessionAddress),
        preparePaidUpgrade: (args) => preparePaidUpgrade(args),
        signPaidIntent: async (args) =>
            privateKeyToAccount(args.rootPrivateKey).signTypedData(args.typedData),
        sendPaidUpgrade: async (args) => {
            const client = signedClient(args.network, args.rootPrivateKey)
            const sent = await client.sendPreparedCalls({
                context: args.context,
                signature: args.signature,
            })
            return { id: sent.id }
        },
        waitPaidUpgrade: async (args) => {
            const client = signedClient(args.network, args.rootPrivateKey)
            const status = await waitForBundle(client, {
                id: args.id,
                chainId: args.network.chainId,
            })
            const statusCode = status.statusCode ?? 0
            const success = Boolean(status.success) && [200, 201].includes(statusCode)
            return {
                success,
                txHash: status.receipt?.transactionHash,
                error:
                    status.error ?? (success ? undefined : `Bundle ended in status ${statusCode}`),
            }
        },
        installPermissions: (args) => installPermissionCalls(args),
        sponsoredUpgrade: async (args) => {
            const result = await delegateAccountWithAuthorizeKeys({
                rootPrivateKey: args.rootPrivateKey,
                sessionAddress: args.sessionAddress,
                network: args.network,
                authorizeKeys: [args.authorizeKey],
            })
            return {
                accountAddress: result.accountAddress,
                txHash: result.txHash,
            }
        },
        readMarker: async () => (markerPath ? readPaidUpgradeMarker(markerPath) : memory),
        writeMarker: async (marker) => {
            if (marker.chainId !== input.network.chainId) return
            if (marker.keyHash.toLowerCase() !== keyHash.toLowerCase()) return
            if (markerPath) {
                await writePaidUpgradeMarker(markerPath, marker)
                return
            }
            memory = marker
        },
        deleteMarker: async () => {
            if (markerPath) {
                await deletePaidUpgradeMarker(markerPath)
                return
            }
            memory = null
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }
}

async function readUsdcBalance(network: CliNetworkConfig, account: Address): Promise<bigint> {
    const token = getUsdcAddressByChainId(network.chainId)
    if (!token) return 0n
    const client = createPublicClient({
        chain: getChain(network.chainId, network.rpcUrl),
        transport: http(network.rpcUrl),
    })
    return client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account],
    })
}

async function readSessionKey(
    network: CliNetworkConfig,
    account: Address,
    sessionAddress: Address,
): Promise<InstalledSessionKey | null> {
    const client = createCliRelayerClient(network)
    const keys = await client.getKeys({
        address: account,
        chainIds: [network.chainId],
    })
    const chainKey = `0x${network.chainId.toString(16)}`
    const list = keys[chainKey] ?? []
    const wanted = computeSessionKeyHash(sessionAddress).toLowerCase()
    const found = list.find((entry) => entry.hash.toLowerCase() === wanted)
    if (!found) return null
    return {
        hash: found.hash,
        role: found.role,
        permissions: found.permissions.map((permission) =>
            permission.type === 'call'
                ? {
                      type: 'call' as const,
                      to: getAddress(permission.to),
                      selector: permission.selector,
                  }
                : {
                      type: 'spend' as const,
                      token: getAddress(permission.token),
                      limit: permission.limit,
                      period: permission.period,
                  },
        ),
    }
}

async function preparePaidUpgrade(input: {
    upgrade: ReturnType<typeof buildBareUpgrade>
    account: Address
    sessionAddress: Address
    rootPrivateKey: Hex
    network: CliNetworkConfig
}): Promise<PaidPrepareResult> {
    const delegation = resolveAccountProxyAddress(input.network.env, input.network.chainId)
    const orchestrator = resolveOrchestratorAddress(input.network.env, input.network.chainId)
    const usdc = getUsdcAddressByChainId(input.network.chainId)
    if (!usdc) {
        throw new FirstUpgradeError(
            'UPGRADE_FAILED',
            `No USDC deployment for chain ${input.network.chainId}.`,
        )
    }
    const client = signedClient(input.network, input.rootPrivateKey)
    const capabilities = await client.getCapabilities({
        chainIds: [input.network.chainId],
    })
    if (capabilities.success === false) {
        throw new Error(capabilities.error ?? 'Relayer capabilities request failed')
    }
    const advertised = capabilities.contracts?.accountProxy
    if (!advertised || getAddress(advertised) !== delegation) {
        throw new Error('Relayer capabilities delegation does not match the local account proxy')
    }
    const publicClient = createPublicClient({
        chain: getChain(input.network.chainId, input.network.rpcUrl),
        transport: http(input.network.rpcUrl),
    })
    const authNonce = await publicClient.getTransactionCount({
        address: input.account,
        blockTag: 'pending',
    })
    const owner = privateKeyToAccount(input.rootPrivateKey)
    const execSignature = await owner.signTypedData({
        domain: {
            name: ORCHESTRATOR_DOMAIN_NAME,
            version: ORCHESTRATOR_DOMAIN_VERSION,
            chainId: input.network.chainId,
            verifyingContract: orchestrator,
        },
        types: SIGNED_CALL_TYPES,
        primaryType: 'SignedCall',
        message: {
            multichain: false,
            eoa: input.account,
            calls: input.upgrade.calls,
            nonce: UPGRADE_PRECALL_NONCE,
        },
    })
    const authorizationSignature = await owner.sign({
        hash: hashAuthorization({
            contractAddress: delegation,
            chainId: input.network.chainId,
            nonce: Number(authNonce),
        }),
    })
    const preCall = {
        eoa: input.account,
        executionData: input.upgrade.executionData,
        nonce: UPGRADE_PRECALL_NONCE.toString(),
        signature: execSignature,
    }
    const encodedPreCall = encodeSignedPreCall(preCall)
    const balanceData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [input.account],
    })
    const calls: Call[] = [{ target: usdc, value: 0n, data: balanceData }]
    const now = BigInt(Math.floor(Date.now() / 1000))
    const expiry = now + INTENT_EXPIRY_TTL_SECONDS
    const transport = createRelayerTransport(client)
    const prepared = await requestPaidPrepare(transport, {
        from: input.account,
        chainId: input.network.chainId,
        calls,
        nonce: 0n,
        expiry,
        payer: input.account,
        paymentToken: usdc,
        paymentMaxAmount: PAID_FEE_CAP,
        delegation,
        authNonce: Number(authNonce),
        authorizationSignature,
        preCall,
    })
    const signedCap = resolveSignedFeeCap({
        paymentAmount: firstQuotePaymentAmount(prepared),
        ceiling: PAID_FEE_CAP,
        zeroFee: false,
    })
    const gas = quotedTxGas(prepared)
    if (!quotedGasWithinHold(gas)) {
        throw new Error(
            `Paid upgrade gas limit exceeds the reserved hold (${gas} > ${PAID_UPGRADE_GAS_HOLD})`,
        )
    }
    const bound = bindPreparedCalls(prepared, {
        from: input.account,
        calls,
        chainId: input.network.chainId,
        verifyingContract: orchestrator,
        nonce: 0n,
        expiry,
        now,
        combinedGasCeiling: PAID_UPGRADE_GAS_HOLD,
        payer: input.account,
        paymentToken: usdc,
        paymentMaxAmount: signedCap,
        paymentCeiling: PAID_FEE_CAP,
        encodedPreCalls: [encodedPreCall],
    })
    return { gas, context: prepared.context, typedData: bound.typedData }
}

async function installPermissionCalls(input: {
    calls: Call[]
    account: Address
    rootPrivateKey: Hex
    network: CliNetworkConfig
}): Promise<{ txHash?: Hex }> {
    const client = signedClient(input.network, input.rootPrivateKey)
    const nonce = await readAccountNonce(client, input.account)
    const submission = await executeSignedCalls(
        {
            prepareCalls: (args) =>
                client.prepareCalls({
                    from: args.from,
                    chainId: input.network.chainId,
                    calls: args.calls,
                    nonce: args.nonce,
                    expiry: args.expiry,
                    payer: args.payer,
                    paymentToken: args.paymentToken,
                    paymentMaxAmount: args.paymentMaxAmount,
                }),
            signTypedData: async (args) =>
                privateKeyToAccount(args.privateKey).signTypedData(args.typedData),
            sendPreparedCalls: (args) =>
                client.sendPreparedCalls({
                    context: args.context,
                    signature: args.signature,
                }),
            waitForBundle: (args) =>
                waitForBundle(client, { id: args.id, chainId: input.network.chainId }),
        },
        {
            from: input.account,
            calls: input.calls,
            nonce,
            signerPrivateKey: input.rootPrivateKey,
            chainId: input.network.chainId,
            env: input.network.env,
            rpcUrl: input.network.rpcUrl,
        },
    )
    const statusCode = submission.finalStatus.statusCode ?? 0
    if (!submission.finalStatus.success || ![200, 201].includes(statusCode)) {
        throw new Error(
            submission.finalStatus.error ??
                `Bundle ended in status ${statusCode} (${submission.finalStatus.status ?? 'unknown'}).`,
        )
    }
    return { txHash: submission.finalStatus.receipt?.transactionHash }
}

function signedClient(network: CliNetworkConfig, rootPrivateKey: Hex) {
    return createCliRelayerClient({
        ...network,
        authSigner: createEthHttpSigner(rootPrivateKey, network.chainId),
    })
}

function encodeSignedPreCall(preCall: {
    eoa: Address
    executionData: Hex
    nonce: string
    signature: Hex
}): Hex {
    return encodeAbiParameters(
        [
            {
                type: 'tuple',
                components: [
                    { name: 'eoa', type: 'address' },
                    { name: 'executionData', type: 'bytes' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'signature', type: 'bytes' },
                ],
            },
        ],
        [
            {
                eoa: getAddress(preCall.eoa),
                executionData: preCall.executionData,
                nonce: BigInt(preCall.nonce),
                signature: preCall.signature,
            },
        ],
    )
}

function quotedTxGas(prepared: PrepareCallsResponse): bigint {
    const quote = prepared.context?.quote?.quotes?.[0] as
        | {
              txGas?: number | string | bigint
              telemetry?: { txGas?: string | number }
          }
        | undefined
    const values: bigint[] = []
    if (quote?.txGas !== undefined && `${quote.txGas}` !== '') values.push(BigInt(quote.txGas))
    if (quote?.telemetry?.txGas !== undefined && `${quote.telemetry.txGas}` !== '') {
        values.push(BigInt(quote.telemetry.txGas))
    }
    if (values.length === 0) {
        throw new Error('Paid upgrade quote did not include a gas limit')
    }
    return values.reduce((max, value) => (value > max ? value : max))
}

async function requestPaidPrepare(
    transport: { request: <T>(method: string, params?: unknown) => Promise<T> },
    input: {
        from: Address
        chainId: number
        calls: Call[]
        nonce: bigint
        expiry: bigint
        payer: Address
        paymentToken: Address
        paymentMaxAmount: bigint
        delegation: Address
        authNonce: number
        authorizationSignature: Hex
        preCall: {
            eoa: Address
            executionData: Hex
            nonce: string
            signature: Hex
        }
    },
): Promise<PrepareCallsResponse> {
    const result = await transport.request<{
        context: PrepareCallsResponse['context']
        digest: Hex
        typedData: {
            domain: PrepareCallsResponse['typedData']['domain']
            types: PrepareCallsResponse['typedData']['types']
            primaryType: 'Intent'
            message: Record<string, unknown>
        }
    }>('wallet_prepareCalls', {
        from: input.from,
        chain_id: `0x${input.chainId.toString(16)}`,
        calls: input.calls.map((call) => ({
            to: call.target,
            data: call.data,
            value: `0x${call.value.toString(16)}`,
        })),
        capabilities: {
            meta: {
                nonce: input.nonce.toString(),
                expiry: input.expiry.toString(),
                fee_payer: input.payer,
                fee_token: input.paymentToken,
                fee_max_amount: input.paymentMaxAmount.toString(),
            },
            accountUpgrade: {
                authorization: {
                    contractAddress: input.delegation,
                    chainId: input.chainId,
                    nonce: input.authNonce,
                    signature: input.authorizationSignature,
                },
                preCall: input.preCall,
            },
        },
    })
    const rawMessage = result.typedData.message
    const rawCalls = rawMessage.calls as Array<{
        to: Address
        value: string
        data: Hex
    }>
    return {
        context: result.context,
        digest: result.digest,
        typedData: {
            domain: result.typedData.domain,
            types: result.typedData.types,
            primaryType: 'Intent',
            message: {
                multichain: rawMessage.multichain as boolean,
                eoa: rawMessage.eoa as Address,
                calls: rawCalls.map((call) => ({
                    to: call.to,
                    value: BigInt(call.value),
                    data: call.data,
                })),
                nonce: BigInt(rawMessage.nonce as string),
                payer: rawMessage.payer as Address,
                paymentToken: rawMessage.paymentToken as Address,
                paymentMaxAmount: BigInt(rawMessage.paymentMaxAmount as string),
                combinedGas: BigInt(rawMessage.combinedGas as string),
                encodedPreCalls: rawMessage.encodedPreCalls as Hex[],
                encodedFundTransfers: rawMessage.encodedFundTransfers as Hex[],
                settler: rawMessage.settler as Address,
                expiry: BigInt(rawMessage.expiry as string),
            },
        },
    }
}

function parsePaidUpgradeMarker(value: unknown): PaidUpgradeMarker | null {
    if (typeof value !== 'object' || value === null) return null
    const marker = value as Partial<PaidUpgradeMarker>
    if (marker.version !== 1) return null
    if (typeof marker.chainId !== 'number') return null
    if (typeof marker.sessionAddress !== 'string') return null
    if (typeof marker.keyHash !== 'string') return null
    if (
        marker.status !== 'authorizing' &&
        marker.status !== 'key_authorized' &&
        marker.status !== 'permissions_submitted'
    ) {
        return null
    }
    return {
        version: 1,
        chainId: marker.chainId,
        sessionAddress: getAddress(marker.sessionAddress),
        keyHash: marker.keyHash,
        status: marker.status,
        bundleId: typeof marker.bundleId === 'string' ? marker.bundleId : undefined,
        upgradeTxHash: typeof marker.upgradeTxHash === 'string' ? marker.upgradeTxHash : undefined,
        gas: typeof marker.gas === 'string' ? marker.gas : undefined,
    }
}

function isEnoent(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
    )
}
