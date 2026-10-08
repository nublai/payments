import { getAddress, isAddress, parseUnits, type Address } from 'viem'
import { executeAccountAddress, type AccountAddressResult } from './account-address'
import {
    getChainConfig,
    getUsdcTokenConfig,
    normalizeChainName,
    type ChainName,
} from './network-config'

type EnvName = 'prod' | 'stage' | 'dev'

export type AddressErrorCode =
    | 'INVALID_NAME'
    | 'KEYSTORE_NOT_FOUND'
    | 'MISSING_ARGUMENT'
    | 'UNSUPPORTED_CHAIN'
    | 'UNKNOWN'

export class AddressError extends Error {
    code: AddressErrorCode
    cause?: unknown

    constructor(code: AddressErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'AddressError'
        this.code = code
        this.cause = options?.cause
    }
}

export type AddressResult = {
    type: 'address'
    status: 'complete'
    keystorePath: string
    address: Address
    token: {
        symbol?: 'USDC'
        address: Address
        decimals: number | null
    }
    chain: {
        name: ChainName
        chainId: number
    }
    funding?: {
        amount?: string
        amountAtomic?: string
        paymentUri?: string
        qrPayload?: string
    }
    warnings: string[]
}

type AddressDeps = {
    executeAccountAddress: (options: {
        env: EnvName
        name?: string
        keystorePath?: string
    }) => Promise<AccountAddressResult>
}

function getDefaultDeps(): AddressDeps {
    return {
        executeAccountAddress,
    }
}

function parseAmount(value?: string): string | undefined {
    if (!value) return undefined
    const normalized = value.trim()

    if (!/^\d+(\.\d+)?$/.test(normalized)) {
        throw new AddressError('MISSING_ARGUMENT', 'Invalid --amount. Expected a positive decimal.')
    }

    if (/^0+(\.0+)?$/.test(normalized)) {
        throw new AddressError('MISSING_ARGUMENT', 'Invalid --amount. Expected a positive decimal.')
    }

    return normalized
}

function resolveChain(value?: string): ChainName {
    try {
        return normalizeChainName(value ?? 'base')
    } catch (error) {
        throw new AddressError(
            'UNSUPPORTED_CHAIN',
            error instanceof Error ? error.message : String(error),
        )
    }
}

function resolveToken(input: { token: string; chain: ChainName }): {
    symbol?: 'USDC'
    address: Address
    decimals: number | null
} {
    if (input.token.toUpperCase() === 'USDC') {
        const usdc = getUsdcTokenConfig(input.chain)

        return { symbol: 'USDC', address: usdc.address, decimals: 6 }
    }

    if (!isAddress(input.token)) {
        throw new AddressError(
            'MISSING_ARGUMENT',
            `Invalid --token value: ${input.token}. Use USDC or a token address.`,
        )
    }

    return { address: getAddress(input.token), decimals: null }
}

function buildPaymentUri(input: {
    tokenAddress: Address
    chainId: number
    recipient: Address
    amountAtomic?: bigint
}): string {
    const base = `ethereum:${input.tokenAddress}@${input.chainId}/transfer?address=${input.recipient}`

    if (input.amountAtomic === undefined) return base

    return `${base}&uint256=${input.amountAtomic.toString()}`
}

export async function executeAddress(
    options: {
        env: EnvName
        name?: string
        keystorePath?: string
        chain?: ChainName
        token?: string
        amount?: string
        decimals?: number
        qr?: boolean
        link?: boolean
    },
    depsArg?: Partial<AddressDeps>,
): Promise<AddressResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const chain = resolveChain(options.chain)

    if (
        options.decimals !== undefined &&
        (!Number.isInteger(options.decimals) || options.decimals < 0 || options.decimals > 36)
    ) {
        throw new AddressError(
            'MISSING_ARGUMENT',
            'Invalid --decimals value. Expected an integer between 0 and 36.',
        )
    }

    const account = await deps.executeAccountAddress({
        env: options.env,
        name: options.name,
        keystorePath: options.keystorePath,
    })

    const recipient = getAddress(account.address)
    const token = resolveToken({ token: options.token ?? 'USDC', chain })

    let decimals = token.decimals

    if (!token.symbol && options.amount !== undefined) {
        if (options.decimals === undefined) {
            throw new AddressError(
                'MISSING_ARGUMENT',
                'Custom token amount requires --decimals <int>.',
            )
        }

        decimals = options.decimals
    } else if (!token.symbol && options.decimals !== undefined) {
        decimals = options.decimals
    }

    let amountAtomic: bigint | undefined

    if (options.amount !== undefined) {
        const amount = parseAmount(options.amount)

        if (!amount) {
            throw new AddressError(
                'MISSING_ARGUMENT',
                'Invalid --amount. Expected a positive decimal.',
            )
        }

        amountAtomic = parseUnits(amount, decimals ?? 0)

        if (amountAtomic <= 0n) {
            throw new AddressError(
                'MISSING_ARGUMENT',
                'Invalid --amount. Expected a positive decimal.',
            )
        }
    }

    const chainConfig = getChainConfig(chain)
    const shouldBuildPayload = Boolean(options.link || options.qr || options.amount)

    const payload = shouldBuildPayload
        ? buildPaymentUri({
              tokenAddress: token.address,
              chainId: chainConfig.chainId,
              recipient,
              amountAtomic,
          })
        : undefined

    return {
        type: 'address',
        status: 'complete',
        keystorePath: account.keystorePath,
        address: recipient,
        token: {
            symbol: token.symbol,
            address: token.address,
            decimals,
        },
        chain: {
            name: chain,
            chainId: chainConfig.chainId,
        },
        funding: shouldBuildPayload
            ? {
                  amount: options.amount,
                  amountAtomic: amountAtomic?.toString(),
                  paymentUri: options.link || options.amount ? payload : undefined,
                  qrPayload: options.qr ? payload : undefined,
              }
            : undefined,
        warnings: ['Send this token on this chain only.'],
    }
}
