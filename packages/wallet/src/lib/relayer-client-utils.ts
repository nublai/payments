import { createPublicClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getChain, relayerActions, type EthHttpSigner } from '@nubl/relayer-client'
import type { CliNetworkConfig } from './network-config'
export { readAccountNonce } from './nonce-utils'

export function createCliRelayerClient(network: CliNetworkConfig) {
    const chain = getChain(network.chainId, network.rpcUrl)
    return createPublicClient({
        chain,
        transport: http(network.rpcUrl),
    }).extend(
        relayerActions({
            relayerUrl: network.relayerUrl,
            authSigner: network.authSigner,
            allowInsecureHttp: network.env === 'dev',
        }),
    )
}

export function createEthHttpSigner(privateKey: Hex, chainId: number): EthHttpSigner {
    const account = privateKeyToAccount(privateKey)
    return {
        address: account.address,
        chainId,
        signMessage: (message: Uint8Array) => account.signMessage({ message: { raw: message } }),
    }
}
