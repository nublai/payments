/**
 * HD signer address for the pool.
 *
 * The path matches SignerDO.deriveKey (`m/44'/60'/0'/0/${index}`). Paid-upgrade
 * simulation uses this address as `eth_call` `from` so the call is the
 * transaction that signer will broadcast.
 */

import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { bytesToHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export function deriveRelayerSignerAddress(mnemonic: string, index: number): Address {
    const seed = mnemonicToSeedSync(mnemonic)
    const hdKey = HDKey.fromMasterSeed(seed)
    const path = `m/44'/60'/0'/0/${index}`
    const derived = hdKey.derive(path)
    if (!derived.privateKey) {
        throw new Error(`Failed to derive key at path ${path}`)
    }
    const privateKey = bytesToHex(derived.privateKey) as Hex
    return privateKeyToAccount(privateKey).address
}
