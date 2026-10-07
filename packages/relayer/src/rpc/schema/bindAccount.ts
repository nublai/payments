import type { Address, Hex } from 'viem'

import type { WalletBindScheme } from '../../auth/wallet-bind'

export interface IssueBindNonceParams {
    address: Address
    /** Hex chain id, same shape as the upgrade methods. */
    chainId?: string
}

export interface BindAccountParams {
    address: Address
    chainId?: string
    nonce: string
    expiry: number
    signature: Hex
    /** Defaults to eip712. eip191 signs the personal message returned by issue. */
    scheme?: WalletBindScheme
}
