/**
 * Canonical EIP-712 type definitions for intent signing/hashing.
 *
 * Must match Orchestrator contract's INTENT_TYPEHASH and CALL_TYPEHASH:
 * "Intent(bool multichain,address eoa,Call[] calls,uint256 nonce,address payer,address paymentToken,uint256 paymentMaxAmount,uint256 combinedGas,bytes[] encodedPreCalls,bytes[] encodedFundTransfers,address settler,uint256 expiry)Call(address to,uint256 value,bytes data)"
 */
export const INTENT_TYPES = {
    Intent: [
        { name: 'multichain', type: 'bool' },
        { name: 'eoa', type: 'address' },
        { name: 'calls', type: 'Call[]' },
        { name: 'nonce', type: 'uint256' },
        { name: 'payer', type: 'address' },
        { name: 'paymentToken', type: 'address' },
        { name: 'paymentMaxAmount', type: 'uint256' },
        { name: 'combinedGas', type: 'uint256' },
        { name: 'encodedPreCalls', type: 'bytes[]' },
        { name: 'encodedFundTransfers', type: 'bytes[]' },
        { name: 'settler', type: 'address' },
        { name: 'expiry', type: 'uint256' },
    ],
    Call: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
    ],
} as const

export type IntentTypes = typeof INTENT_TYPES
