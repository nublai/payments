import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'

const SETTLEMENT_WRITE_TYPES = {
    SettlementWrite: [
        { name: 'sender', type: 'address' },
        { name: 'settlementId', type: 'bytes32' },
        { name: 'chainId', type: 'uint256' },
    ],
} as const

/**
 * Signs an EIP-712 SettlementWrite message using the oracle's private key.
 * The signature can be broadcast by anyone to SimpleSettler.write().
 *
 * Domain matches SimpleSettler._domainNameAndVersion(): "SimpleSettler" v0.1.2
 */
export async function signSettlement(params: {
    settlementId: Hex
    oracleAddress: Address
    chainId: number
    simpleSettlerAddress: Address
    oraclePrivateKey: Hex
}): Promise<Hex> {
    const { settlementId, oracleAddress, chainId, simpleSettlerAddress, oraclePrivateKey } = params

    const account = privateKeyToAccount(oraclePrivateKey)

    return account.signTypedData({
        domain: {
            name: 'SimpleSettler',
            version: '0.1.2',
            chainId,
            verifyingContract: simpleSettlerAddress,
        },
        types: SETTLEMENT_WRITE_TYPES,
        primaryType: 'SettlementWrite',
        message: {
            sender: oracleAddress,
            settlementId,
            chainId: BigInt(chainId),
        },
    })
}
