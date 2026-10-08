import { createPublicClient, formatUnits, http } from 'viem'
import {
    AccountAddressError,
    executeAccountAddress,
    type AccountAddressResult,
    type AccountAddressOptions,
} from './account-address'
import {
    getChainConfig,
    getUsdcTokenConfig,
    selectDefaultChain,
    type ChainName,
    type UsdcSymbol,
} from './network-config'

type AccountBalanceErrorCode = 'UNSUPPORTED_CHAIN' | 'ADDRESS_LOOKUP_FAILED' | 'UNKNOWN'

const erc20Abi = [
    {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
] as const

export class AccountBalanceError extends Error {
    code: AccountBalanceErrorCode
    cause?: unknown

    constructor(code: AccountBalanceErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AccountBalanceError'
        this.code = code
        this.cause = options?.cause
    }
}

export type AccountBalanceOptions = AccountAddressOptions & {
    chain?: ChainName
    legacy?: boolean
}

export type AccountBalanceResult = {
    type: 'account_balance'
    status: 'complete'
    keystorePath: string
    address: string
    chain: ChainName
    contractAddress: string
    symbol: UsdcSymbol
    balance: string
    formattedBalance: string
}

type AccountBalanceDeps = {
    executeAccountAddress: (options: AccountAddressOptions) => Promise<AccountAddressResult>
    readUsdcBalance: (input: {
        chain: ChainName
        legacy?: boolean
        account: `0x${string}`
    }) => Promise<bigint>
}

function normalizeChain(value?: string): ChainName {
    try {
        return selectDefaultChain('prod', value)
    } catch (error) {
        const message = error instanceof Error ? error.message : `Unsupported chain: ${value}`
        throw new AccountBalanceError('UNSUPPORTED_CHAIN', message, { cause: error })
    }
}

function getDefaultDeps(): AccountBalanceDeps {
    return {
        executeAccountAddress,
        readUsdcBalance: async (input) => {
            const token = getUsdcTokenConfig(input.chain, { legacy: input.legacy })
            const config = getChainConfig(input.chain)

            const client = createPublicClient({
                chain: config.viemChain,
                transport: http(config.rpcUrl),
            })

            const balance = await client.readContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [input.account],
            })

            return balance
        },
    }
}

export async function executeAccountBalance(
    options: AccountBalanceOptions,
    depsArg?: Partial<AccountBalanceDeps>,
): Promise<AccountBalanceResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const chain = options.chain ? normalizeChain(options.chain) : selectDefaultChain(options.env)
    const token = getUsdcTokenConfig(chain, { legacy: options.legacy })

    try {
        const addressResult = await deps.executeAccountAddress({
            env: options.env,
            name: options.name,
            keystorePath: options.keystorePath,
        })

        const balance = await deps.readUsdcBalance({
            chain,
            legacy: options.legacy,
            account: addressResult.address as `0x${string}`,
        })

        return {
            type: 'account_balance',
            status: 'complete',
            keystorePath: addressResult.keystorePath,
            address: addressResult.address,
            chain,
            contractAddress: token.address,
            symbol: token.symbol,
            balance: balance.toString(),
            formattedBalance: formatUnits(balance, 6),
        }
    } catch (error) {
        throw toAccountBalanceError(error)
    }
}

function toAccountBalanceError(error: unknown): AccountBalanceError {
    if (error instanceof AccountBalanceError) {
        return error
    }

    if (error instanceof AccountAddressError) {
        return new AccountBalanceError('ADDRESS_LOOKUP_FAILED', error.message, { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)

    if (message.includes('Unsupported chain')) {
        return new AccountBalanceError('UNSUPPORTED_CHAIN', message, { cause: error })
    }

    return new AccountBalanceError('UNKNOWN', message, { cause: error })
}
