import {
    createPublicClient,
    erc20Abi,
    formatUnits,
    getAddress,
    http,
    type Address,
    type Hex,
} from 'viem'
import {
    ANY_FUNCTION_SELECTOR,
    computeKeyHash,
    encodeSecp256k1Key,
    getChain,
    type GetKeysResponse,
} from '@agentic-payments/relayer-client'
import {
    AccountCreateError,
    getDefaultSessionPermissions,
    resolveKeystorePath,
} from './account-create'
import { readKeystoreBundle } from './keystore'
import {
    getChainConfig,
    getUsdcTokenConfig,
    resolveNetworkConfig,
    selectDefaultChain,
    type ChainName,
    type CliNetworkConfig,
    type EnvName,
    type UsdcSymbol,
} from './network-config'
import { createCliRelayerClient, readAccountNonce } from './relayer-client-utils'
type AccountStatusErrorCode =
    | 'INVALID_NAME'
    | 'KEYSTORE_NOT_FOUND'
    | 'UNSUPPORTED_CHAIN'
    | 'UNKNOWN'

type NetworkConfig = CliNetworkConfig

type PermissionLevel = 'pass' | 'warn' | 'fail'

type PermissionExpectation = {
    wildcardSelector: Hex
    spend?: {
        token: Address
        period: string
        limit: string
    }
}

type PermissionActual = {
    callSelectors: Hex[]
    spend: Array<{
        token: Address
        period: string
        limit: string
        spent?: string
    }>
}

export type AccountStatusCheck = {
    id: string
    level: PermissionLevel
    message: string
    expected?: unknown
    actual?: unknown
}

export class AccountStatusError extends Error {
    code: AccountStatusErrorCode
    cause?: unknown

    constructor(code: AccountStatusErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AccountStatusError'
        this.code = code
        this.cause = options?.cause
    }
}

export type AccountStatusOptions = {
    env: EnvName
    chain?: ChainName
    legacy?: boolean
    keystorePath?: string
    name?: string
}

export type AccountStatusResult = {
    type: 'account_status'
    status: 'complete'
    readiness: boolean
    keystorePath: string
    network: NetworkConfig & { chain: ChainName }
    addresses: {
        root: Address
        session: Address
    }
    checkpoint?: 'initialized' | 'delegated' | 'complete'
    usdc: {
        symbol: UsdcSymbol
        balance: string
        formattedBalance: string
        contractAddress: Address
    }
    nonce?: string
    permissions: {
        found: boolean
        warnings: number
        expected: PermissionExpectation
        actual?: PermissionActual
    }
    checks: AccountStatusCheck[]
}

type AccountStatusDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    getDelegatedCode: (input: {
        network: NetworkConfig
        address: Address
    }) => Promise<Hex | undefined>
    readNonce: (input: { network: NetworkConfig; address: Address }) => Promise<bigint>
    readUsdcBalance: (input: {
        chain: ChainName
        legacy?: boolean
        account: Address
    }) => Promise<bigint>
    getAuthorizedKeys: (input: {
        network: NetworkConfig
        address: Address
    }) => Promise<GetKeysResponse>
}

function normalizeChain(value?: string): ChainName {
    try {
        return selectDefaultChain('prod', value)
    } catch (error) {
        const message = error instanceof Error ? error.message : `Unsupported chain: ${value}`
        throw new AccountStatusError('UNSUPPORTED_CHAIN', message, { cause: error })
    }
}

function getDefaultDeps(): AccountStatusDeps {
    return {
        readKeystoreBundle,
        getDelegatedCode: async ({ network, address }) => {
            const client = createPublicClient({
                chain: getChain(network.chainId, network.rpcUrl),
                transport: http(network.rpcUrl),
            })
            return client.getCode({ address })
        },
        readNonce: async ({ network, address }) => {
            const client = createPublicClient({
                chain: getChain(network.chainId, network.rpcUrl),
                transport: http(network.rpcUrl),
            })
            return readAccountNonce(client, address)
        },
        readUsdcBalance: async ({ chain, account, legacy }) => {
            const config = getChainConfig(chain)
            const token = getUsdcTokenConfig(chain, { legacy })
            const client = createPublicClient({
                chain: config.viemChain,
                transport: http(config.rpcUrl),
            })
            return client.readContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [account],
            })
        },
        getAuthorizedKeys: async ({ network, address }) => {
            const client = createCliRelayerClient(network)
            return client.getKeys({ address, chainIds: [network.chainId] })
        },
    }
}

function addCheck(
    checks: AccountStatusCheck[],
    id: string,
    level: PermissionLevel,
    message: string,
    options?: { expected?: unknown; actual?: unknown },
): void {
    checks.push({
        id,
        level,
        message,
        expected: options?.expected,
        actual: options?.actual,
    })
}

function normalizeHex(value: string): Hex {
    return `0x${value.slice(2).toLowerCase()}` as Hex
}

function normalizeAddress(value: string): Address {
    return getAddress(value)
}

function toDecimalStringFromHex(value: string): string | null {
    try {
        return BigInt(value).toString()
    } catch {
        return null
    }
}

function getExpectedPermissionConfig(chainId: number, legacy?: boolean): PermissionExpectation {
    const defaults = getDefaultSessionPermissions(chainId, { legacy })
    const callPermission = defaults.find((permission) => permission.type === 'call')
    const spendPermission = defaults.find((permission) => permission.type === 'spend')

    return {
        wildcardSelector: normalizeHex(callPermission?.selector ?? ANY_FUNCTION_SELECTOR),
        spend: spendPermission
            ? {
                  token: normalizeAddress(spendPermission.token),
                  period: spendPermission.period,
                  limit: spendPermission.limit,
              }
            : undefined,
    }
}

export async function executeAccountStatus(
    options: AccountStatusOptions,
    depsArg?: Partial<AccountStatusDeps>,
): Promise<AccountStatusResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const chain = options.chain ? normalizeChain(options.chain) : selectDefaultChain(options.env)
    const network = resolveNetworkConfig(options.env, chain)
    const usdcToken = getUsdcTokenConfig(chain, { legacy: options.legacy })

    let keystorePath = options.keystorePath ?? '<default>'

    try {
        keystorePath = resolveKeystorePath({
            env: options.env,
            keystorePath: options.keystorePath,
            name: options.name,
        })

        const bundle = await deps.readKeystoreBundle(keystorePath)
        const root = normalizeAddress(bundle.root.addresses.root)
        const session = normalizeAddress(bundle.session.addresses.session)

        const checks: AccountStatusCheck[] = []
        const expectedPermissions = getExpectedPermissionConfig(network.chainId, options.legacy)
        let nonce: bigint | undefined
        let usdcBalance = 0n

        addCheck(checks, 'keystore.load', 'pass', 'Keystore loaded successfully.')

        try {
            const code = await deps.getDelegatedCode({ network, address: root })
            if (!code || code === '0x') {
                addCheck(
                    checks,
                    'delegation.code',
                    'fail',
                    'Delegated account code not found on-chain.',
                )
            } else if (!code.startsWith('0xef0100')) {
                addCheck(
                    checks,
                    'delegation.code',
                    'fail',
                    'Account code is present but not an EIP-7702 delegation designator.',
                    { actual: code.slice(0, 10) },
                )
            } else {
                addCheck(checks, 'delegation.code', 'pass', 'Delegated account code is present.')
            }
        } catch (error) {
            addCheck(
                checks,
                'delegation.code',
                'fail',
                `Could not read delegated account code: ${error instanceof Error ? error.message : String(error)}`,
            )
        }

        try {
            nonce = await deps.readNonce({ network, address: root })
            addCheck(checks, 'nonce.read', 'pass', 'Account nonce read successfully.', {
                actual: nonce.toString(),
            })
        } catch (error) {
            addCheck(
                checks,
                'nonce.read',
                'fail',
                `Could not read account nonce: ${error instanceof Error ? error.message : String(error)}`,
            )
        }

        try {
            usdcBalance = await deps.readUsdcBalance({
                chain,
                legacy: options.legacy,
                account: root,
            })
            addCheck(checks, 'balance.usdc', 'pass', 'USDC balance read successfully.', {
                actual: usdcBalance.toString(),
            })
        } catch (error) {
            addCheck(
                checks,
                'balance.usdc',
                'fail',
                `Could not read USDC balance: ${error instanceof Error ? error.message : String(error)}`,
            )
        }

        let permissionFound = false
        let permissionActual: PermissionActual | undefined

        try {
            const keysByChain = await deps.getAuthorizedKeys({
                network,
                address: root,
            })
            const chainKey = `0x${network.chainId.toString(16)}`
            const chainKeys = keysByChain[chainKey] ?? []
            const sessionKeyHash = computeKeyHash('secp256k1', encodeSecp256k1Key(session))
            const sessionKey = chainKeys.find(
                (entry) => entry.hash.toLowerCase() === sessionKeyHash.toLowerCase(),
            )

            if (!sessionKey) {
                addCheck(
                    checks,
                    'session.permissions.found',
                    'warn',
                    'Session key is not present in relayer key registry for this chain.',
                )
            } else {
                permissionFound = true
                const callSelectors = sessionKey.permissions
                    .filter((permission) => permission.type === 'call')
                    .map((permission) => normalizeHex(permission.selector))
                const spendPermissions = sessionKey.permissions
                    .filter((permission) => permission.type === 'spend')
                    .map((permission) => ({
                        token: normalizeAddress(permission.token),
                        period: permission.period,
                        limit: permission.limit,
                        spent: permission.spent,
                    }))

                permissionActual = {
                    callSelectors,
                    spend: spendPermissions,
                }

                addCheck(
                    checks,
                    'session.permissions.found',
                    'pass',
                    'Session key permissions found.',
                )

                const hasWildcard = callSelectors.some(
                    (selector) =>
                        selector.toLowerCase() ===
                        expectedPermissions.wildcardSelector.toLowerCase(),
                )
                if (!hasWildcard) {
                    addCheck(
                        checks,
                        'session.permissions.callWildcard',
                        'warn',
                        'Session key wildcard call selector does not match expected policy.',
                        {
                            expected: expectedPermissions.wildcardSelector,
                            actual: callSelectors,
                        },
                    )
                } else {
                    addCheck(
                        checks,
                        'session.permissions.callWildcard',
                        'pass',
                        'Wildcard call selector matches expected policy.',
                    )
                }

                if (expectedPermissions.spend) {
                    const actualSpend = spendPermissions.find(
                        (permission) =>
                            permission.token.toLowerCase() ===
                            expectedPermissions.spend?.token.toLowerCase(),
                    )

                    if (!actualSpend) {
                        addCheck(
                            checks,
                            'session.permissions.spendToken',
                            'warn',
                            `Session key spend permission for expected USDC token is missing. Run tw session create without --full-access to grant default USDC spend permissions, or run tw permissions grant --type spend --token ${expectedPermissions.spend.token}.`,
                            {
                                expected: expectedPermissions.spend.token,
                                actual: spendPermissions.map((entry) => entry.token),
                            },
                        )
                    } else {
                        addCheck(
                            checks,
                            'session.permissions.spendToken',
                            'pass',
                            'Spend token permission matches expected policy.',
                        )

                        if (actualSpend.period !== expectedPermissions.spend.period) {
                            addCheck(
                                checks,
                                'session.permissions.spendPeriod',
                                'warn',
                                'Session key spend period differs from expected policy.',
                                {
                                    expected: expectedPermissions.spend.period,
                                    actual: actualSpend.period,
                                },
                            )
                        } else {
                            addCheck(
                                checks,
                                'session.permissions.spendPeriod',
                                'pass',
                                'Spend period matches expected policy.',
                            )
                        }

                        const actualLimit = toDecimalStringFromHex(actualSpend.limit)
                        if (actualLimit !== expectedPermissions.spend.limit) {
                            addCheck(
                                checks,
                                'session.permissions.spendLimit',
                                'warn',
                                'Session key spend limit differs from expected policy.',
                                {
                                    expected: expectedPermissions.spend.limit,
                                    actual: actualLimit ?? actualSpend.limit,
                                },
                            )
                        } else {
                            addCheck(
                                checks,
                                'session.permissions.spendLimit',
                                'pass',
                                'Spend limit matches expected policy.',
                            )
                        }
                    }
                }
            }
        } catch (error) {
            addCheck(
                checks,
                'session.permissions.lookup',
                'fail',
                `Could not fetch session permissions: ${error instanceof Error ? error.message : String(error)}`,
            )
        }

        const readiness = checks.every((check) => check.level !== 'fail')
        const permissionWarnings = checks.filter(
            (check) => check.id.startsWith('session.permissions') && check.level === 'warn',
        ).length

        return {
            type: 'account_status',
            status: 'complete',
            readiness,
            keystorePath,
            network: {
                ...network,
                chain,
            },
            addresses: {
                root,
                session,
            },
            checkpoint: bundle.root.checkpoint,
            nonce: nonce?.toString(),
            usdc: {
                symbol: usdcToken.symbol,
                balance: usdcBalance.toString(),
                formattedBalance: formatUnits(usdcBalance, 6),
                contractAddress: usdcToken.address,
            },
            permissions: {
                found: permissionFound,
                warnings: permissionWarnings,
                expected: expectedPermissions,
                actual: permissionActual,
            },
            checks,
        }
    } catch (error) {
        throw toAccountStatusError(error, { keystorePath })
    }
}

function toAccountStatusError(
    error: unknown,
    context: { keystorePath: string },
): AccountStatusError {
    if (error instanceof AccountStatusError) {
        return error
    }

    if (error instanceof AccountCreateError && error.code === 'INVALID_NAME') {
        return new AccountStatusError('INVALID_NAME', error.message, { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('ENOENT') || message.toLowerCase().includes('no such file')) {
        return new AccountStatusError(
            'KEYSTORE_NOT_FOUND',
            `Keystore not found at ${context.keystorePath}`,
            { cause: error },
        )
    }

    if (message.includes('Unsupported chain')) {
        return new AccountStatusError('UNSUPPORTED_CHAIN', message, { cause: error })
    }

    return new AccountStatusError('UNKNOWN', message, { cause: error })
}
