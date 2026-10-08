import { createPublicClient, http, type Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { relayerActions } from '../../src'
import type { RelayerActions, RelayerPublicClient } from '../../src'
import { RELAYER_URL, TEST_ACCOUNTS } from '../setup'
import type { EthHttpSigner } from '../../src'

export type RelayerTestClient = RelayerPublicClient & RelayerActions

export function createRelayerTestAuthSigner(chainId: number): EthHttpSigner {
    const authAccount = privateKeyToAccount(TEST_ACCOUNTS.relayer.privateKey)

    return {
        address: authAccount.address,
        chainId,
        signMessage: (message: Uint8Array) =>
            authAccount.signMessage({ message: { raw: message } }),
    }
}

export function createRelayerTestClient(params: {
    chain: Chain
    rpcUrl: string
    relayerUrl?: string
}): RelayerTestClient {
    const { chain, rpcUrl, relayerUrl = RELAYER_URL } = params

    return createPublicClient({
        chain,
        transport: http(rpcUrl),
    }).extend(
        relayerActions({
            relayerUrl,
            authSigner: createRelayerTestAuthSigner(chain.id),
        }),
    ) as RelayerTestClient
}
