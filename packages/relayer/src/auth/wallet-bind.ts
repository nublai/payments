import {
    getAddress,
    keccak256,
    toBytes,
    verifyMessage,
    verifyTypedData,
    type Address,
    type Hex,
} from 'viem'

export const WALLET_BIND_DOMAIN_NAME = 'Nubl Relayer'

export const WALLET_BIND_DOMAIN_VERSION = '1'

export const WALLET_BIND_PRIMARY_TYPE = 'WalletBind' as const

export const BIND_NONCE_TTL_SECONDS = 10 * 60

export const WALLET_BIND_TYPES = {
    WalletBind: [
        { name: 'account', type: 'address' },
        { name: 'issuer', type: 'string' },
        { name: 'sub', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'expiry', type: 'uint256' },
    ],
} as const

export type WalletBindScheme = 'eip712' | 'eip191'

export interface WalletBindFields {
    account: Address
    issuer: string
    sub: string
    nonce: string
    chainId: number
    expiry: number
    /** Trimmed `CONTEXT`. Unset or blank is refused before a nonce is issued. */
    environment: string
}

export function walletBindEnvironment(env: { CONTEXT?: string }): string | undefined {
    const context = env.CONTEXT?.trim().toLowerCase()

    return context ? context : undefined
}

export function walletBindDomain(chainId: number, environment: string) {
    return {
        name: WALLET_BIND_DOMAIN_NAME,
        version: WALLET_BIND_DOMAIN_VERSION,
        chainId,
        salt: keccak256(toBytes(environment)),
    }
}

/** EIP-191 text. The first line is the bind sentence; the rest are the nonce binding. */
export function walletBindPersonalMessage(fields: WalletBindFields): string {
    return [
        `Bind address ${fields.account} to sub ${fields.sub}`,
        `Issuer: ${fields.issuer}`,
        `Nonce: ${fields.nonce}`,
        `Chain ID: ${fields.chainId}`,
        `Expiry: ${fields.expiry}`,
        `Environment: ${fields.environment}`,
    ].join('\n')
}

export function walletBindTypedData(fields: WalletBindFields) {
    return {
        domain: walletBindDomain(fields.chainId, fields.environment),
        types: WALLET_BIND_TYPES,
        primaryType: WALLET_BIND_PRIMARY_TYPE,
        message: {
            account: fields.account,
            issuer: fields.issuer,
            sub: fields.sub,
            nonce: fields.nonce,
            expiry: fields.expiry.toString(),
        },
    }
}

export function parseWalletBindScheme(value: unknown): WalletBindScheme | undefined {
    if (value === undefined || value === 'eip712') return 'eip712'

    if (value === 'eip191') return 'eip191'

    return undefined
}

export async function verifyWalletBindSignature(input: {
    fields: WalletBindFields
    signature: Hex
    scheme: WalletBindScheme
}): Promise<boolean> {
    const account = getAddress(input.fields.account)
    const fields = { ...input.fields, account }

    try {
        if (input.scheme === 'eip191') {
            return await verifyMessage({
                address: account,
                message: walletBindPersonalMessage(fields),
                signature: input.signature,
            })
        }

        return await verifyTypedData({
            address: account,
            domain: walletBindDomain(fields.chainId, fields.environment),
            types: WALLET_BIND_TYPES,
            primaryType: WALLET_BIND_PRIMARY_TYPE,
            message: {
                account,
                issuer: fields.issuer,
                sub: fields.sub,
                nonce: fields.nonce,
                expiry: BigInt(fields.expiry),
            },
            signature: input.signature,
        })
    } catch {
        return false
    }
}
