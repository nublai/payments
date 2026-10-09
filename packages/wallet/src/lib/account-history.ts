import { getAddress, type Address } from 'viem'
import {
    type ChainName,
    type EnvName,
    getChainConfig,
    getChainNameByChainId,
    normalizeChainName,
    resolveNetworkConfig,
    selectDefaultChain,
} from './network-config'
import { createCliRelayerClient } from './relayer-client-utils'
import { readKeystoreBundle } from './keystore'
import { AccountCreateError, resolveKeystorePath } from './account-create'

type AccountHistoryErrorCode =
    | 'INVALID_ARGUMENT'
    | 'KEYSTORE_NOT_FOUND'
    | 'RELAYER_ERROR'
    | 'UNKNOWN'

const DEFAULT_LIMIT = 20

const MAX_LIMIT = 100

const MAX_TARGET_SIZE = 1000

export class AccountHistoryError extends Error {
    code: AccountHistoryErrorCode
    cause?: unknown

    constructor(code: AccountHistoryErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AccountHistoryError'
        this.code = code
        this.cause = options?.cause
    }
}

export type AccountHistoryOptions = {
    env: EnvName
    name?: string
    keystorePath?: string
    address?: string
    chains?: string
    limit?: number
    offset?: number
}

export type AccountHistoryResult = {
    type: 'account_history'
    status: 'complete'
    address: Address
    keystorePath?: string
    networkScope: {
        env: EnvName
        chainIds?: number[]
    }
    page: {
        limit: number
        offset: number
        returned: number
        total: number
    }
    items: Array<{
        id: string
        chainId: number
        chain: ChainName | null
        createdAt: number
    }>
}

type AccountHistoryDeps = {
    readKeystoreBundle: typeof readKeystoreBundle
    getCallsHistory: (input: {
        env: EnvName
        address: Address
        chainIds?: number[]
        limit: number
        offset: number
    }) => Promise<
        | {
              success: true
              items: Array<{ id: string; chainId: number; createdAt: number }>
              total: number
          }
        | {
              success: false
              error: string
          }
    >
}

function parseChainList(value: string): ChainName[] {
    const names = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)

    if (names.length === 0) {
        throw new AccountHistoryError('INVALID_ARGUMENT', 'At least one chain must be provided.')
    }

    return [...new Set(names.map((name) => normalizeChainName(name)))]
}

function toChainIds(chains: ChainName[]): number[] {
    return chains.map((chain) => getChainConfig(chain).chainId)
}

function validatePaging(limit: number, offset: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new AccountHistoryError(
            'INVALID_ARGUMENT',
            `limit must be an integer between 1 and ${MAX_LIMIT}`,
        )
    }

    if (!Number.isInteger(offset) || offset < 0) {
        throw new AccountHistoryError('INVALID_ARGUMENT', 'offset must be a non-negative integer')
    }

    if (limit + offset > MAX_TARGET_SIZE) {
        throw new AccountHistoryError(
            'INVALID_ARGUMENT',
            `offset + limit must be less than or equal to ${MAX_TARGET_SIZE}`,
        )
    }
}

function getDefaultDeps(): AccountHistoryDeps {
    return {
        readKeystoreBundle,
        getCallsHistory: async ({ env, address, chainIds, limit, offset }) => {
            const network = resolveNetworkConfig(env, selectDefaultChain(env))
            const client = createCliRelayerClient(network)

            return client.getCallsHistory({
                address,
                chainIds,
                limit,
                offset,
            })
        },
    }
}

export async function executeAccountHistory(
    options: AccountHistoryOptions,
    depsArg?: Partial<AccountHistoryDeps>,
): Promise<AccountHistoryResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const limit = options.limit ?? DEFAULT_LIMIT
    const offset = options.offset ?? 0

    try {
        validatePaging(limit, offset)

        const chainIds = options.chains ? toChainIds(parseChainList(options.chains)) : undefined

        let address: Address
        let keystorePath: string | undefined

        if (options.address) {
            address = getAddress(options.address)
        } else {
            keystorePath = resolveKeystorePath({
                env: options.env,
                keystorePath: options.keystorePath,
                name: options.name,
            })
            const bundle = await deps.readKeystoreBundle(keystorePath)
            address = getAddress(bundle.root.addresses.root)
        }

        const result = await deps.getCallsHistory({
            env: options.env,
            address,
            chainIds,
            limit,
            offset,
        })

        if (!result.success) {
            throw new AccountHistoryError('RELAYER_ERROR', result.error)
        }

        const history: Pick<
            AccountHistoryResult,
            'type' | 'status' | 'address' | 'keystorePath'
        > = {
            type: 'account_history',
            status: 'complete',
            address,
        }

        if (keystorePath) {
            history.keystorePath = keystorePath
        }

        const networkScope: AccountHistoryResult['networkScope'] = {
            env: options.env,
        }

        if (chainIds) {
            networkScope.chainIds = chainIds
        }

        return {
            ...history,
            networkScope,
            page: {
                limit,
                offset,
                returned: result.items.length,
                total: result.total,
            },
            items: result.items.map((item) => ({
                id: item.id,
                chainId: item.chainId,
                chain: getChainNameByChainId(item.chainId) ?? null,
                createdAt: item.createdAt,
            })),
        }
    } catch (error) {
        throw toAccountHistoryError(error, { usedAddressOverride: Boolean(options.address) })
    }
}

function toAccountHistoryError(
    error: unknown,
    context: { usedAddressOverride: boolean },
): AccountHistoryError {
    if (error instanceof AccountHistoryError) {
        return error
    }

    if (error instanceof AccountCreateError && error.code === 'INVALID_NAME') {
        return new AccountHistoryError('INVALID_ARGUMENT', error.message, { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)

    if (message.toLowerCase().includes('unsupported chain')) {
        return new AccountHistoryError('INVALID_ARGUMENT', message, { cause: error })
    }

    if (!context.usedAddressOverride) {
        if (message.includes('ENOENT') || message.toLowerCase().includes('no such file')) {
            return new AccountHistoryError('KEYSTORE_NOT_FOUND', message, { cause: error })
        }
    }

    if (message.toLowerCase().includes('invalid address')) {
        return new AccountHistoryError('INVALID_ARGUMENT', message, { cause: error })
    }

    return new AccountHistoryError('UNKNOWN', message, { cause: error })
}
