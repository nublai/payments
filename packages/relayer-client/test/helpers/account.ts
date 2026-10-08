import { type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { RelayerTestClient } from './client'

export async function upgradeDelegatedAccount(params: {
    client: RelayerTestClient
    accountAddress: Address
    signerKey: Hex
    delegation: Address
    chainId: number
}) {
    const { client, accountAddress, signerKey, delegation, chainId } = params

    const result = await client.upgradeAccount({
        accountAddress,
        signerKey,
        delegation,
        chainId,
    })

    if (!result.success) {
        throw new Error(result.error ?? 'upgradeAccount failed')
    }

    return result
}

export function createEphemeralAccount() {
    const privateKey = generatePrivateKey()
    const account = privateKeyToAccount(privateKey)

    return { account, privateKey }
}
