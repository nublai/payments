import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem'
import { mainnet } from 'viem/chains'
import type { ChainName } from './network-config'

export type RecipientResolutionErrorCode = 'INVALID_RECIPIENT' | 'RECIPIENT_UNRESOLVED'

export class RecipientResolutionError extends Error {
    code: RecipientResolutionErrorCode
    details?: unknown

    constructor(code: RecipientResolutionErrorCode, message: string, details?: unknown) {
        super(message)
        this.name = 'RecipientResolutionError'
        this.code = code
        this.details = details
    }
}

type ResolverDeps = {
    resolveEnsAddress: (input: {
        recipient: `${string}.eth`
        chain: ChainName
    }) => Promise<Address | null>
}

function getDefaultDeps(): ResolverDeps {
    return {
        resolveEnsAddress: async ({ recipient }) => {
            const client = createPublicClient({
                chain: mainnet,
                transport: http('https://eth.llamarpc.com'),
            })
            const resolved = await client.getEnsAddress({ name: recipient })
            return resolved ? getAddress(resolved) : null
        },
    }
}

export async function resolveAddressOrEnsInput(
    input: string,
    chain: ChainName,
    depsArg?: Partial<ResolverDeps>,
): Promise<{ address: Address; ens: `${string}.eth` | null }> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    const normalized = input.trim()

    if (isAddress(normalized)) {
        return {
            address: getAddress(normalized),
            ens: null,
        }
    }

    const maybeEns = normalized.toLowerCase()
    if (!maybeEns.endsWith('.eth')) {
        throw new RecipientResolutionError(
            'INVALID_RECIPIENT',
            'Recipient must be a valid address or .eth ENS name.',
        )
    }

    const resolved = await deps.resolveEnsAddress({ recipient: maybeEns as `${string}.eth`, chain })
    if (!resolved) {
        throw new RecipientResolutionError(
            'RECIPIENT_UNRESOLVED',
            `Could not resolve ENS name: ${maybeEns}`,
        )
    }

    return {
        address: getAddress(resolved),
        ens: maybeEns as `${string}.eth`,
    }
}
