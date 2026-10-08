import { createPublicClient, http, type Address } from 'viem'
import {
    AccountAddressError,
    executeAccountAddress,
    type AccountAddressOptions,
} from './account-address'
import { readAccountNonce } from './nonce-utils'
import {
    getChainConfig,
    resolveNetworkConfig,
    selectDefaultChain,
    type ChainName,
} from './network-config'

type AccountNonceErrorCode =
    | 'INVALID_SEQ_KEY'
    | 'UNSUPPORTED_CHAIN'
    | 'ADDRESS_LOOKUP_FAILED'
    | 'UNKNOWN'

export class AccountNonceError extends Error {
    code: AccountNonceErrorCode
    cause?: unknown

    constructor(code: AccountNonceErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AccountNonceError'
        this.code = code
        this.cause = options?.cause
    }
}

export type AccountNonceOptions = AccountAddressOptions & {
    chain?: ChainName
    seqKey?: bigint
}

export type AccountNonceResult = {
    type: 'account_nonce'
    status: 'complete'
    keystorePath: string
    address: string
    chain: ChainName
    seqKey: string
    nonce: string
}

export type AccountNonceDeps = {
    executeAccountAddress: (options: AccountAddressOptions) => Promise<{
        keystorePath: string
        address: string
    }>
    readNonce: (input: {
        chain: ChainName
        rpcUrl: string
        account: Address
        seqKey: bigint
    }) => Promise<bigint>
}

function normalizeChain(value?: string): ChainName {
    try {
        return selectDefaultChain('prod', value)
    } catch (error) {
        const message = error instanceof Error ? error.message : `Unsupported chain: ${value}`
        throw new AccountNonceError('UNSUPPORTED_CHAIN', message, { cause: error })
    }
}

function getDefaultDeps(): AccountNonceDeps {
    return {
        executeAccountAddress,
        readNonce: async ({ chain, rpcUrl, account, seqKey }) => {
            const client = createPublicClient({
                chain: getChainConfig(chain).viemChain,
                transport: http(rpcUrl),
            })

            return readAccountNonce(client, account, seqKey)
        },
    }
}

export async function executeAccountNonce(
    options: AccountNonceOptions,
    depsArg?: Partial<AccountNonceDeps>,
): Promise<AccountNonceResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const chain = options.chain ? normalizeChain(options.chain) : selectDefaultChain(options.env)
    const seqKey = options.seqKey ?? 0n
    const network = resolveNetworkConfig(options.env, chain)

    try {
        const addressResult = await deps.executeAccountAddress({
            env: options.env,
            name: options.name,
            keystorePath: options.keystorePath,
        })

        const nonce = await deps.readNonce({
            chain,
            rpcUrl: network.rpcUrl,
            account: addressResult.address as Address,
            seqKey,
        })

        return {
            type: 'account_nonce',
            status: 'complete',
            keystorePath: addressResult.keystorePath,
            address: addressResult.address,
            chain,
            seqKey: seqKey.toString(),
            nonce: nonce.toString(),
        }
    } catch (error) {
        throw toAccountNonceError(error)
    }
}

function toAccountNonceError(error: unknown): AccountNonceError {
    if (error instanceof AccountNonceError) {
        return error
    }

    if (error instanceof AccountAddressError) {
        return new AccountNonceError('ADDRESS_LOOKUP_FAILED', error.message, { cause: error })
    }

    const message = error instanceof Error ? error.message : String(error)

    if (message.includes('Unsupported chain')) {
        return new AccountNonceError('UNSUPPORTED_CHAIN', message, { cause: error })
    }

    return new AccountNonceError('UNKNOWN', message, { cause: error })
}
