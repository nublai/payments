import type { Chain, WalletClient, Account, PrivateKeyAccount } from 'viem'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { RelayerPublicClient } from '../types'

export function getClientChain(client: RelayerPublicClient): Chain {
    const chain = client.chain

    if (!chain) {
        throw new Error('Client must have a chain configured')
    }

    return chain
}

type WalletFromPrivateKey = { account: PrivateKeyAccount; walletClient: WalletClient }

export function createWalletFromPrivateKey(
    privateKey: `0x${string}`,
    chain: Chain,
): WalletFromPrivateKey {
    const account = privateKeyToAccount(privateKey)

    const walletClient = createWalletClient({
        account,
        chain,
        transport: http(chain.rpcUrls.default.http[0]),
    })

    return { account, walletClient }
}

export function getWalletAccount(walletClient: WalletClient): Account {
    if (!walletClient.account) {
        throw new Error('WalletClient must have an account configured')
    }

    return walletClient.account as Account
}
