import { encodeAbiParameters, zeroAddress, type Hex } from 'viem'

import type { IntentStruct } from '../types/pool'

/**
 * ABI-encode one Intent the way Orchestrator.execute(bytes) expects it.
 * Payment recipient is whoever the caller has already written onto the intent.
 */
export function encodeIntentCalldata(intent: IntentStruct): Hex {
    const calls = intent.calls.map((call) => ({
        to: call.to,
        value: call.value ? BigInt(call.value) : 0n,
        data: call.data ?? '0x',
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
        eoa: intent.eoa,
        executionData,
        nonce: BigInt(intent.nonce),
        payer: intent.payer ?? zeroAddress,
        paymentToken: intent.paymentToken ?? zeroAddress,
        paymentMaxAmount: BigInt(intent.paymentMaxAmount ?? '0'),
        combinedGas: BigInt(intent.combinedGas),
        encodedPreCalls: intent.encodedPreCalls ?? [],
        encodedFundTransfers: intent.encodedFundTransfers ?? [],
        settler: intent.settler ?? zeroAddress,
        expiry: BigInt(intent.expiry ?? '0'),
        isMultichain: intent.isMultichain ?? false,
        funder: intent.funder ?? zeroAddress,
        funderSignature: intent.funderSignature ?? '0x',
        settlerContext: intent.settlerContext ?? '0x',
        paymentAmount: BigInt(intent.paymentAmount ?? '0'),
        paymentRecipient: intent.paymentRecipient ?? zeroAddress,
        signature: intent.signature,
        paymentSignature: intent.paymentSignature ?? '0x',
        supportedAccountImplementation: intent.supportedAccountImplementation ?? zeroAddress,
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
