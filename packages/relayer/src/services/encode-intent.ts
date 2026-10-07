import { encodeAbiParameters, zeroAddress, type Address, type Hex } from 'viem'

import type { IntentStruct } from '../types/pool'

/**
 * ABI-encode one Intent the way Orchestrator.execute(bytes) expects it.
 * Payment recipient is whoever the caller has already written onto the intent.
 */
export function encodeIntentCalldata(intent: IntentStruct): Hex {
    const calls = intent.calls.map((call) => ({
        to: call.to as Address,
        value: call.value ? BigInt(call.value) : 0n,
        data: (call.data ?? '0x') as Hex,
    }))

    const executionData = encodeAbiParameters(
        [
            {
                type: 'tuple[]',
                components: [
                    { name: 'to', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'data', type: 'bytes' },
                ],
            },
        ],
        [calls],
    )

    const intentForContract = {
        eoa: intent.eoa as Address,
        executionData,
        nonce: BigInt(intent.nonce),
        payer: (intent.payer ?? zeroAddress) as Address,
        paymentToken: (intent.paymentToken ?? zeroAddress) as Address,
        paymentMaxAmount: BigInt(intent.paymentMaxAmount ?? '0'),
        combinedGas: BigInt(intent.combinedGas),
        encodedPreCalls: (intent.encodedPreCalls ?? []) as Hex[],
        encodedFundTransfers: (intent.encodedFundTransfers ?? []) as Hex[],
        settler: (intent.settler ?? zeroAddress) as Address,
        expiry: BigInt(intent.expiry ?? '0'),
        isMultichain: intent.isMultichain ?? false,
        funder: (intent.funder ?? zeroAddress) as Address,
        funderSignature: (intent.funderSignature ?? '0x') as Hex,
        settlerContext: (intent.settlerContext ?? '0x') as Hex,
        paymentAmount: BigInt(intent.paymentAmount ?? '0'),
        paymentRecipient: (intent.paymentRecipient ?? zeroAddress) as Address,
        signature: intent.signature as Hex,
        paymentSignature: (intent.paymentSignature ?? '0x') as Hex,
        supportedAccountImplementation: (intent.supportedAccountImplementation ??
            zeroAddress) as Address,
    }

    return encodeAbiParameters(
        [
            {
                type: 'tuple',
                components: [
                    { name: 'eoa', type: 'address' },
                    { name: 'executionData', type: 'bytes' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'payer', type: 'address' },
                    { name: 'paymentToken', type: 'address' },
                    { name: 'paymentMaxAmount', type: 'uint256' },
                    { name: 'combinedGas', type: 'uint256' },
                    { name: 'encodedPreCalls', type: 'bytes[]' },
                    { name: 'encodedFundTransfers', type: 'bytes[]' },
                    { name: 'settler', type: 'address' },
                    { name: 'expiry', type: 'uint256' },
                    { name: 'isMultichain', type: 'bool' },
                    { name: 'funder', type: 'address' },
                    { name: 'funderSignature', type: 'bytes' },
                    { name: 'settlerContext', type: 'bytes' },
                    { name: 'paymentAmount', type: 'uint256' },
                    { name: 'paymentRecipient', type: 'address' },
                    { name: 'signature', type: 'bytes' },
                    { name: 'paymentSignature', type: 'bytes' },
                    { name: 'supportedAccountImplementation', type: 'address' },
                ],
            },
        ],
        [intentForContract],
    )
}
