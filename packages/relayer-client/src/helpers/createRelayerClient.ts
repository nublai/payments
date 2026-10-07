import { createPublicClient, http, type Chain } from 'viem'
import { getChain } from '../chains'
import { relayerActions, type RelayerActions } from '../decorators'
import type { RelayerClientConfig, RelayerPublicClient } from '../types'

export interface CreateRelayerClientParams extends Omit<
    RelayerClientConfig,
    'chainId' | 'authSigner'
> {
    /** Target EVM chain ID */
    chainId: number
    /** RPC URL used by the viem PublicClient transport */
    rpcUrl: string
    /** Required HTTP auth signer for request signing */
    authSigner: NonNullable<RelayerClientConfig['authSigner']>
    /** Optional explicit chain config (overrides getChain(chainId, rpcUrl)) */
    chain?: Chain
}

export type CreatedRelayerClient = RelayerPublicClient & RelayerActions

/**
 * Create a relayer-enabled viem public client with a typed, single-call setup.
 */
export function createRelayerClient(params: CreateRelayerClientParams): CreatedRelayerClient {
    if (!params.authSigner) {
        throw new Error('createRelayerClient requires authSigner so relayer requests are signed')
    }

    const chain = params.chain ?? getChain(params.chainId, params.rpcUrl)
    const config: RelayerClientConfig = {
        relayerUrl: params.relayerUrl,
        chainId: params.chainId,
        authToken: params.authToken,
        authTokenProvider: params.authTokenProvider,
        authSigner: params.authSigner,
        authSignOptions: params.authSignOptions,
        allowInsecureHttp: params.allowInsecureHttp,
    }

    return createPublicClient({
        chain,
        transport: http(params.rpcUrl),
    }).extend(relayerActions(config))
}
