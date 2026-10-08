import { createTestClient, http, type Address, type Chain } from 'viem'
import type { Hex } from 'viem'
import type { RelayerTestClient } from './client'
import { upgradeDelegatedAccount } from './account'

export async function setBalanceOnChain(params: {
    address: Address
    amount: bigint
    rpcUrl: string
    chain: Chain
}) {
    const { address, amount, rpcUrl, chain } = params

    const client = createTestClient({
        chain,
        mode: 'anvil',
        transport: http(rpcUrl),
    })

    await client.setBalance({ address, value: amount })
}

export async function delegateOnBothChains(params: {
    accountAddress: Address
    privateKey: Hex
    primaryClient: RelayerTestClient
    secondaryClient: RelayerTestClient
    primaryDelegation: Address
    secondaryDelegation: Address
    primaryChainId: number
    secondaryChainId: number
}) {
    const {
        accountAddress,
        privateKey,
        primaryClient,
        secondaryClient,
        primaryDelegation,
        secondaryDelegation,
        primaryChainId,
        secondaryChainId,
    } = params

    const primaryResult = await upgradeDelegatedAccount({
        client: primaryClient,
        accountAddress,
        signerKey: privateKey,
        delegation: primaryDelegation,
        chainId: primaryChainId,
    })

    const secondaryResult = await upgradeDelegatedAccount({
        client: secondaryClient,
        accountAddress,
        signerKey: privateKey,
        delegation: secondaryDelegation,
        chainId: secondaryChainId,
    })

    return { primaryResult, secondaryResult }
}
