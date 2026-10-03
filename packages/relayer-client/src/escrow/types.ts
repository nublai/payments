import type { Address, Hex } from 'viem'

export interface CreateEscrowParams {
    buyer: Address
    seller: Address
    usdcAmount: bigint
    /** Unix timestamp (seconds) after which permissionless refunds become available */
    deadline: bigint
    /** bytes32 order identifier — used as settlementId */
    orderId: Hex
    /** EOA address of the centralized oracle that will call SimpleSettler.write() */
    oracleAddress: Address
    usdcAddress: Address
    escrowAddress: Address
    simpleSettlerAddress: Address
    chainId: number
    /** Optional salt to make escrow IDs unique for repeated orders */
    salt?: Hex
}

export interface EscrowStatus {
    status: 'null' | 'created' | 'refund_deposit' | 'refund_recipient' | 'finalized'
    escrow: {
        depositor: Address
        recipient: Address
        token: Address
        escrowAmount: bigint
        refundAmount: bigint
        refundTimestamp: bigint
        settler: Address
        sender: Address
        settlementId: Hex
        senderChainId: bigint
    } | null
}
