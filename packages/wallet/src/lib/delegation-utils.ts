import { createPublicClient, getAddress, http, type Address, type Hex } from 'viem'
import { encodeSecp256k1Key, getChain, type AuthorizeKey } from '@nubl/relayer-client'
import type { CliNetworkConfig } from './network-config'
import { resolveAccountProxyAddress, resolveOrchestratorAddress } from './orchestrator-address'
import { createCliRelayerClient, createEthHttpSigner } from './relayer-client-utils'

export const DELEGATION_CODE_PREFIX = '0xef0100'

export function hasDelegationCode(code: Hex | undefined): boolean {
    return (code ?? '').toLowerCase().startsWith(DELEGATION_CODE_PREFIX)
}

export async function readAccountCode(input: {
    network: CliNetworkConfig
    address: Address
}): Promise<Hex | undefined> {
    const client = createPublicClient({
        chain: getChain(input.network.chainId, input.network.rpcUrl),
        transport: http(input.network.rpcUrl),
    })
    return client.getCode({ address: input.address })
}

export async function delegateAccountWithAuthorizeKeys(input: {
    rootPrivateKey: Hex
    sessionAddress: Address
    network: CliNetworkConfig
    authorizeKeys: AuthorizeKey[]
}): Promise<{ accountAddress: Address; txHash?: Hex }> {
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(input.rootPrivateKey)
    const signedNetwork = {
        ...input.network,
        authSigner: createEthHttpSigner(input.rootPrivateKey, input.network.chainId),
    }
    const relayerClient = createCliRelayerClient(signedNetwork)

    const delegation = resolveAccountProxyAddress(input.network.env, input.network.chainId)
    const orchestrator = resolveOrchestratorAddress(input.network.env, input.network.chainId)
    const capabilities = await relayerClient.getCapabilities({ chainIds: [input.network.chainId] })
    if (capabilities.success === false) {
        throw new Error(capabilities.error ?? 'Relayer capabilities request failed')
    }
    const advertised = capabilities.contracts?.accountProxy
    if (!advertised || getAddress(advertised) !== delegation) {
        throw new Error(
            'Relayer capabilities delegation does not match the local account proxy',
        )
    }

    const result = await relayerClient.upgradeAccount({
        accountAddress: account.address,
        signerKey: input.rootPrivateKey,
        delegation,
        orchestrator,
        chainId: input.network.chainId,
        authorizeKeys:
            input.authorizeKeys.length > 0
                ? input.authorizeKeys
                : [
                      {
                          expiry: '0',
                          type: 'secp256k1',
                          role: 'normal',
                          publicKey: encodeSecp256k1Key(input.sessionAddress),
                          permissions: [],
                      },
                  ],
    })

    if (!result.success) {
        throw new Error(result.error ?? 'Delegation failed')
    }

    return {
        accountAddress: (result.accountAddress ?? account.address) as Address,
        txHash: result.txHash as Hex | undefined,
    }
}
