import { access, utimes } from 'node:fs/promises'
import {
    createPublicClient,
    erc20Abi,
    getAddress,
    http,
    zeroAddress,
    type Address,
    type Hex,
    type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { accountAbi } from '@nubl/contracts/abis'
import {
    getChain,
    waitForBundle as waitForBundleAction,
    type Call,
} from '@nubl/relayer-client'
import lockfile from 'proper-lockfile'
import { executeSignedCalls } from './execute-calls'
import {
    decryptRootKeystore,
    readKeystoreBundle,
    withKeystoreLock,
} from './keystore'
import { readlineExistingPassword } from './password-readline'
import {
    createCliRelayerClient,
    createEthHttpSigner,
    readAccountNonce,
} from './relayer-client-utils'
import {
    getUsdcAddressByChainId,
    type CliNetworkConfig,
} from './network-config'
import { quoteSpendRecoverySuspended, withoutQuoteSpendRecovery } from './quote-spend-guard'
import {
    QuoteSpendError,
    WETH_BY_CHAIN,
    planQuoteSpendSlots,
    quoteSpendSetCalls,
    type QuoteSpendBound,
    type SpendInfoLike,
} from './quote-spend'
import {
    clearPendingQuoteLimit,
    grantsFromPending,
    pendingQuoteLimitExists,
    pendingRecordFromSlots,
    readPendingQuoteLimit,
    restoreCallsForChain,
    writePendingQuoteLimit,
    type PendingQuoteLimitRecord,
} from './quote-spend-pending'
import { canExecuteChangeCalls, type SwapCallGrant } from './swap-session'
import {
    authorizeKeyExpiryCall,
    expectedInstalledKey,
    limitsAfterInstall,
    permissionsAfterInstall,
    planQuoteKeyExpiry,
    quoteKeyDifferences,
    restoreQuoteKeyExpiryCall,
    type QuoteKeyLimit,
    type QuoteKeyMaterial,
    type QuoteKeyPermission,
    type QuoteKeySnapshot,
} from './quote-key-expiry'

type NetworkConfig = CliNetworkConfig

let recovering = false

export async function withQuoteAccountLock<T>(
    keystorePath: string,
    action: () => Promise<T>,
): Promise<T> {
    try {
        await access(keystorePath)
    } catch (error) {
        if (isEnoent(error)) return action()
        throw error
    }

    return withKeystoreLock(
        keystorePath,
        async () => {
            const lockPath = `${keystorePath}.lock`

            const timer = setInterval(() => {
                void utimes(lockPath, new Date(), new Date()).catch(() => {})
            }, 5_000)

            timer.unref()

            try {
                return await action()
            } finally {
                clearInterval(timer)
            }
        },
        lockfile.lock,
        {
            stale: 30_000,
            retries: { retries: 600, minTimeout: 100, maxTimeout: 1_000 },
        },
    )
}

export async function maybeRecoverPendingQuoteSpend(
    keystorePath: string,
    options?: {
        password?: string
        resolvePassword?: () => Promise<string>
        readMinuteLimits?: (
            record: PendingQuoteLimitRecord,
        ) => Promise<Map<string, bigint | null>>
        readQuoteKey?: (record: PendingQuoteLimitRecord) => Promise<QuoteKeyRead>
        submit?: (record: PendingQuoteLimitRecord, calls: Call[]) => Promise<void>
    },
): Promise<void> {
    if (quoteSpendRecoverySuspended() || recovering) return

    if (!(await pendingQuoteLimitExists(keystorePath))) return
    recovering = true

    try {
        await withKeystoreLock(
            keystorePath,
            () => recoverPendingQuoteSpend(keystorePath, options),
            lockfile.lock,
            {
                stale: 30_000,
                retries: { retries: 600, minTimeout: 100, maxTimeout: 1_000 },
            },
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (message.toLowerCase().includes('pending quote spend limit')) throw error
        throw new Error(
            `A pending quote spend limit is still installed and could not be restored: ${message}`,
        )
    } finally {
        recovering = false
    }
}

export async function recoverPendingQuoteSpend(
    keystorePath: string,
    options?: {
        password?: string
        resolvePassword?: () => Promise<string>
        readMinuteLimits?: (
            record: PendingQuoteLimitRecord,
        ) => Promise<Map<string, bigint | null>>
        readQuoteKey?: (record: PendingQuoteLimitRecord) => Promise<QuoteKeyRead>
        submit?: (record: PendingQuoteLimitRecord, calls: Call[]) => Promise<void>
    },
): Promise<void> {
    const record = await readPendingQuoteLimit(keystorePath)

    if (!record) return
    const expiry = await keyExpiryRestoreDecision(record, options?.readQuoteKey)

    if (expiry.differences.length > 0) {
        await refuseChangedQuoteKey(keystorePath, expiry.differences)
    }

    const minuteLimits = options?.readMinuteLimits
        ? await options.readMinuteLimits(record)
        : await readMinuteLimits(record.account, record.keyHash, record.rpcUrl, record.chainId)

    const planned = restoreCallsForChain({ record, minuteLimits })

    if (planned.unexpected) {
        throw new Error(
            `Pending quote spend limit does not match the chain: ${planned.unexpected}`,
        )
    }

    const calls = [...releaseCalls(record, planned.calls), ...expiry.calls]

    if (calls.length > 0) {
        if (options?.submit) {
            await options.submit(record, calls)
        } else {
            const password = await resolveRecoveryPassword(options)
            await submitRootCalls({
                keystorePath,
                password,
                network: networkFromRecord(record),
                account: record.account,
                calls,
                failure: 'The pending quote spend limit could not be restored.',
            })
        }
    }

    await clearPendingQuoteLimit(keystorePath)
}

export type QuoteInstallIo = {
    /** Chain reads for install. Release still uses `readMinuteLimits` and `readQuoteKey`. */
    client?: PublicClient
    submit?: (calls: Call[]) => Promise<void>
    readMinuteLimits?: (record: PendingQuoteLimitRecord) => Promise<Map<string, bigint | null>>
    readQuoteKey?: (record: PendingQuoteLimitRecord) => Promise<QuoteKeyRead>
}

export async function installTrackedQuoteSpendLimit(
    input: {
        bound: QuoteSpendBound
        network: NetworkConfig
        password: string
        keystorePath: string
        sessionFile?: string
        /** Input-token canExecute rows to add for this quote and revoke afterwards. */
        callGrants?: readonly SwapCallGrant[]
    },
    io?: QuoteInstallIo,
): Promise<() => Promise<void>> {
    return withoutQuoteSpendRecovery(() => installTrackedQuoteSpendLimitNow(input, io))
}

async function installTrackedQuoteSpendLimitNow(
    input: {
        bound: QuoteSpendBound
        network: NetworkConfig
        password: string
        keystorePath: string
        sessionFile?: string
        callGrants?: readonly SwapCallGrant[]
    },
    io?: QuoteInstallIo,
): Promise<() => Promise<void>> {
    if (input.sessionFile) {
        throw new QuoteSpendError(
            'A swap needs the root key to set a per-quote spend limit. A session file alone cannot.',
        )
    }

    const client = io?.client ?? publicClient(input.network)
    let spendInfos: SpendInfoLike[]
    let balances: { token: Address; balance: bigint }[]

    try {
        spendInfos = await readSpendInfos(client, input.bound.account, input.bound.keyHash)
        balances = await readCandidateBalances(client, input.bound, input.network.chainId)
    } catch (error) {
        if (error instanceof QuoteSpendError) throw error
        throw new QuoteSpendError(
            'Could not read spend limits or token balances. Refusing to sign.',
        )
    }

    const slots = planQuoteSpendSlots({
        bound: input.bound,
        spendInfos,
        balances,
    })

    let key: QuoteKeyMaterial
    let permissions: QuoteKeyPermission[]
    let limits: QuoteKeyLimit[]

    try {
        const stored = await client.readContract({
            address: input.bound.account,
            abi: accountAbi,
            functionName: 'getKey',
            args: [input.bound.keyHash],
        })

        key = {
            expiry: BigInt(stored.expiry),
            keyType: Number(stored.keyType),
            isSuperAdmin: stored.isSuperAdmin,
            publicKey: stored.publicKey,
        }

        const packed = await client.readContract({
            address: input.bound.account,
            abi: accountAbi,
            functionName: 'canExecutePackedInfos',
            args: [input.bound.keyHash],
        })

        permissions = permissionsAfterInstall(
            packed.map(decodePackedCanExecute),
            input.callGrants ?? [],
        )
        limits = limitsAfterInstall(spendInfos, slots)
    } catch (error) {
        if (error instanceof QuoteSpendError) throw error
        throw new QuoteSpendError('Could not read the swap key. Refusing to sign.')
    }

    const expiryPlan = planQuoteKeyExpiry({
        now: BigInt(Math.floor(Date.now() / 1000)),
        currentExpiry: key.expiry,
    })

    const record = pendingRecordFromSlots({
        account: input.bound.account,
        keyHash: input.bound.keyHash,
        chainId: input.network.chainId,
        env: input.network.env,
        rpcUrl: input.network.rpcUrl,
        relayerUrl: input.network.relayerUrl,
        slots,
        callGrants: input.callGrants,
        keyExpiry: expiryPlan.changed
            ? {
                  previous: expiryPlan.previous.toString(),
                  installed: expiryPlan.installed.toString(),
                  keyType: key.keyType,
                  isSuperAdmin: key.isSuperAdmin,
                  publicKey: key.publicKey,
                  permissions: permissions.map((permission) => ({
                      target: permission.target,
                      selector: permission.selector,
                  })),
                  limits: limits.map((limit) => ({
                      token: limit.token,
                      period: limit.period,
                      limit: limit.limit.toString(),
                  })),
              }
            : undefined,
    })

    await writePendingQuoteLimit(input.keystorePath, record)

    try {
        await submitInstallCalls(io, {
            keystorePath: input.keystorePath,
            password: input.password,
            network: input.network,
            account: input.bound.account,
            calls: [
                ...quoteSpendSetCalls({
                    keyHash: input.bound.keyHash,
                    account: input.bound.account,
                    slots,
                }),
                ...canExecuteChangeCalls({
                    account: input.bound.account,
                    keyHash: input.bound.keyHash,
                    grants: input.callGrants ?? [],
                    allowed: true,
                }),
                ...(expiryPlan.changed
                    ? [
                          authorizeKeyExpiryCall({
                              account: input.bound.account,
                              key,
                              expiry: expiryPlan.installed,
                          }),
                      ]
                    : []),
            ],
            failure: 'The per-quote spend limit could not be set. Refusing to sign.',
        })
    } catch (error) {
        if (error instanceof QuoteSpendError) throw error
        throw new QuoteSpendError(
            error instanceof Error
                ? error.message
                : 'The per-quote spend limit could not be set. Refusing to sign.',
        )
    }

    return async () => {
        await withoutQuoteSpendRecovery(() => releaseInstalledQuoteSpendLimit(input, record, io))
    }
}

async function releaseInstalledQuoteSpendLimit(
    input: {
        bound: QuoteSpendBound
        network: NetworkConfig
        password: string
        keystorePath: string
    },
    record: PendingQuoteLimitRecord,
    io?: QuoteInstallIo,
): Promise<void> {
    const active = currentRecord(await readPendingQuoteLimit(input.keystorePath), record)

    const minuteLimits = io?.readMinuteLimits
        ? await io.readMinuteLimits(active)
        : await readMinuteLimits(
              input.bound.account,
              input.bound.keyHash,
              input.network.rpcUrl,
              input.network.chainId,
          )

    const planned = restoreCallsForChain({
        record: active,
        minuteLimits,
    })

    const expiry = await keyExpiryRestoreDecision(active, io?.readQuoteKey)

    if (expiry.differences.length > 0) {
        await refuseChangedQuoteKey(input.keystorePath, expiry.differences)
    }

    if (planned.unexpected) {
        throw new QuoteSpendError(
            `The per-quote spend limit could not be restored: ${planned.unexpected}`,
        )
    }

    const calls = [...releaseCalls(active, planned.calls), ...expiry.calls]

    if (calls.length > 0) {
        await submitInstallCalls(io, {
            keystorePath: input.keystorePath,
            password: input.password,
            network: input.network,
            account: input.bound.account,
            calls,
            failure: 'The per-quote spend limit could not be restored after the swap.',
        })
    }

    await clearPendingQuoteLimit(input.keystorePath)
}

function currentRecord(
    current: PendingQuoteLimitRecord | undefined,
    fallback: PendingQuoteLimitRecord,
): PendingQuoteLimitRecord {
    return current ?? fallback
}

async function submitInstallCalls(
    io: QuoteInstallIo | undefined,
    input: {
        keystorePath: string
        password: string
        network: NetworkConfig
        account: Address
        calls: Call[]
        failure: string
    },
): Promise<void> {
    if (io?.submit) {
        if (input.calls.length > 0) await io.submit(input.calls)

        return
    }

    await submitRootCalls(input)
}

function releaseCalls(record: PendingQuoteLimitRecord, spendCalls: Call[]): Call[] {
    return [
        ...spendCalls,
        ...canExecuteChangeCalls({
            account: record.account,
            keyHash: record.keyHash,
            grants: grantsFromPending(record),
            allowed: false,
        }),
    ]
}

export type QuoteKeyRead =
    | { status: 'missing' }
    | { status: 'live'; key: QuoteKeySnapshot }

/**
 * Previous expiry is restored only when the on-chain key still matches the
 * install snapshot. A missing key skips authorize. Any other read error keeps
 * the pending record and does not authorize.
 */
async function keyExpiryRestoreDecision(
    record: PendingQuoteLimitRecord,
    readQuoteKey?: (record: PendingQuoteLimitRecord) => Promise<QuoteKeyRead>,
): Promise<{ calls: Call[]; differences: string[] }> {
    if (!record.keyExpiry) return { calls: [], differences: [] }
    const read = await readQuoteKeyForRestore(record, readQuoteKey)

    if (read.status === 'missing') return { calls: [], differences: [] }

    const installed = expectedInstalledKey({
        installedExpiry: BigInt(record.keyExpiry.installed),
        keyType: record.keyExpiry.keyType,
        isSuperAdmin: record.keyExpiry.isSuperAdmin,
        publicKey: record.keyExpiry.publicKey,
        storedPermissions: record.keyExpiry.permissions,
        storedLimits: record.keyExpiry.limits?.map((limit) => ({
            token: limit.token,
            period: limit.period,
            limit: BigInt(limit.limit),
        })),
        callGrants: grantsFromPending(record),
        minuteSlots: record.slots.map((slot) => ({
            token: slot.token,
            installedLimit: BigInt(slot.installedLimit),
        })),
        live: read.key,
    })

    const differences = quoteKeyDifferences(installed, read.key)

    return {
        calls: restoreQuoteKeyExpiryCall({
            account: record.account,
            keyStillExists: true,
            previous: {
                expiry: BigInt(record.keyExpiry.previous),
                keyType: record.keyExpiry.keyType,
                isSuperAdmin: record.keyExpiry.isSuperAdmin,
                publicKey: record.keyExpiry.publicKey,
            },
            installed,
            live: read.key,
        }),
        differences,
    }
}

async function readQuoteKeyForRestore(
    record: PendingQuoteLimitRecord,
    readQuoteKey?: (record: PendingQuoteLimitRecord) => Promise<QuoteKeyRead>,
): Promise<QuoteKeyRead> {
    if (readQuoteKey) return readQuoteKey(record)
    const client = publicClient(networkFromRecord(record))

    try {
        const stored = await client.readContract({
            address: record.account,
            abi: accountAbi,
            functionName: 'getKey',
            args: [record.keyHash],
        })

        const packed = await client.readContract({
            address: record.account,
            abi: accountAbi,
            functionName: 'canExecutePackedInfos',
            args: [record.keyHash],
        })

        const spendInfos = await readSpendInfos(client, record.account, record.keyHash)

        return {
            status: 'live',
            key: {
                expiry: BigInt(stored.expiry),
                keyType: Number(stored.keyType),
                isSuperAdmin: stored.isSuperAdmin,
                publicKey: stored.publicKey,
                permissions: packed.map(decodePackedCanExecute),
                limits: spendInfos.map((info) => ({
                    token: info.token,
                    period: info.period,
                    limit: info.limit,
                })),
            },
        }
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error)

        if (text.includes('KeyDoesNotExist')) return { status: 'missing' }
        throw new QuoteSpendError(
            'Could not read the swap key expiry. The pending quote record was kept.',
        )
    }
}

async function refuseChangedQuoteKey(keystorePath: string, differences: string[]): Promise<never> {
    await clearPendingQuoteLimit(keystorePath)
    throw new QuoteSpendError(
        `Pending quote spend limit was not restored. The on-chain key no longer matches the quote install, so it was left unchanged and the pending record was cleared. ${differences.join('; ')}`,
    )
}

function decodePackedCanExecute(packed: Hex): QuoteKeyPermission {
    const value = BigInt(packed)

    return {
        target: getAddress(`0x${(value >> 96n).toString(16).padStart(40, '0')}`),
        selector: `0x${(value & 0xffffffffn).toString(16).padStart(8, '0')}` as Hex,
    }
}

function networkFromRecord(record: PendingQuoteLimitRecord): NetworkConfig {
    return {
        env: record.env,
        relayerUrl: record.relayerUrl,
        rpcUrl: record.rpcUrl,
        chainId: record.chainId,
    }
}

function publicClient(network: NetworkConfig): PublicClient {
    return createPublicClient({
        chain: getChain(network.chainId, network.rpcUrl),
        transport: http(network.rpcUrl),
    })
}

async function readSpendInfos(
    client: PublicClient,
    account: Address,
    keyHash: Hex,
): Promise<SpendInfoLike[]> {
    const rows = await client.readContract({
        address: account,
        abi: accountAbi,
        functionName: 'spendInfos',
        args: [keyHash],
    })

    return rows.map((row) => ({
        token: getAddress(row.token),
        period: Number(row.period),
        limit: row.limit,
    }))
}

async function readMinuteLimits(
    account: Address,
    keyHash: Hex,
    rpcUrl: string,
    chainId: number,
): Promise<Map<string, bigint | null>> {
    const client = createPublicClient({
        chain: getChain(chainId, rpcUrl),
        transport: http(rpcUrl),
    })

    const infos = await readSpendInfos(client, account, keyHash)
    const limits = new Map<string, bigint | null>()

    for (const info of infos) {
        const key = info.token.toLowerCase()

        if (!limits.has(key)) limits.set(key, null)

        if (info.period === 0) limits.set(key, info.limit)
    }

    return limits
}

function candidateTokens(bound: QuoteSpendBound, chainId: number): Address[] {
    const tokens = [zeroAddress, getAddress(bound.usdc), ...bound.frozenTokens]
    const weth = WETH_BY_CHAIN[chainId]

    if (weth) tokens.push(weth)
    const legacy = getUsdcAddressByChainId(chainId, true)

    if (legacy) tokens.push(legacy)
    const seen = new Set<string>()
    const unique: Address[] = []

    for (const token of tokens) {
        const address = getAddress(token)

        if (seen.has(address.toLowerCase())) continue
        seen.add(address.toLowerCase())
        unique.push(address)
    }

    return unique
}

async function readCandidateBalances(
    client: PublicClient,
    bound: QuoteSpendBound,
    chainId: number,
): Promise<{ token: Address; balance: bigint }[]> {
    const balances: { token: Address; balance: bigint }[] = []

    for (const token of candidateTokens(bound, chainId)) {
        if (token === zeroAddress) {
            balances.push({
                token,
                balance: await client.getBalance({ address: bound.account }),
            })
            continue
        }

        const balance = await client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [bound.account],
        })

        balances.push({ token, balance })
    }

    return balances
}

async function resolveRecoveryPassword(options?: {
    password?: string
    resolvePassword?: () => Promise<string>
}): Promise<string> {
    if (options?.password) return options.password

    if (options?.resolvePassword) return options.resolvePassword()
    const env = process.env.TW_PASSWORD?.trim() || process.env.RELAYER_CLI_PASSWORD?.trim()

    if (env) return env

    if (process.stdin.isTTY) {
        return readlineExistingPassword(
            'A quote spend limit is still installed. Enter the keystore password to restore it:',
        )
    }

    throw new Error(
        'A pending quote spend limit is still installed. Re-run with TW_PASSWORD so the root key can restore it.',
    )
}

async function submitRootCalls(input: {
    keystorePath: string
    password: string
    network: NetworkConfig
    account: Address
    calls: Call[]
    failure: string
}): Promise<void> {
    if (input.calls.length === 0) return
    const bundle = await readKeystoreBundle(input.keystorePath)
    const root = await decryptRootKeystore(bundle.root, input.password)

    const signedNetwork = {
        ...input.network,
        authSigner: createEthHttpSigner(root.rootPrivateKey, input.network.chainId),
    }

    const client = publicClient(signedNetwork)
    const nonce = await readAccountNonce(client, input.account)

    const result = await executeSignedCalls(
        {
            prepareCalls: async (call) => {
                const relayer = createCliRelayerClient(signedNetwork)

                return relayer.prepareCalls({
                    from: call.from,
                    chainId: signedNetwork.chainId,
                    calls: call.calls,
                    nonce: call.nonce,
                    expiry: call.expiry,
                    payer: call.payer,
                    paymentToken: call.paymentToken,
                    paymentMaxAmount: call.paymentMaxAmount,
                })
            },
            signTypedData: async (signed) => {
                const signer = privateKeyToAccount(signed.privateKey)

                return signer.signTypedData(signed.typedData)
            },
            sendPreparedCalls: async (prepared) => {
                const relayer = createCliRelayerClient(signedNetwork)

                return relayer.sendPreparedCalls(prepared)
            },
            waitForBundle: async (bundleStatus) => {
                const relayer = createCliRelayerClient(signedNetwork)

                return waitForBundleAction(relayer, {
                    id: bundleStatus.id,
                    chainId: signedNetwork.chainId,
                })
            },
        },
        {
            from: input.account,
            calls: input.calls,
            nonce,
            signerPrivateKey: root.rootPrivateKey,
            chainId: signedNetwork.chainId,
            env: signedNetwork.env,
            rpcUrl: signedNetwork.rpcUrl,
        },
    )

    if (!result.finalStatus.success) {
        throw new QuoteSpendError(input.failure)
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
