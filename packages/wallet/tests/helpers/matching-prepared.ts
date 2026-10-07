import { zeroAddress, type Address, type Hex } from 'viem'
import { hashTypedData } from 'viem/utils'
import { INTENT_TYPES, type Call } from '@nubl/relayer-client'
import type { EnvName } from '../../src/lib/network-config'
import { resolveOrchestratorAddress } from '../../src/lib/orchestrator-address'

export function matchingPreparedCalls(input: {
    from: Address
    calls: Call[]
    nonce: bigint
    network: { env: EnvName; chainId: number }
}) {
    const verifyingContract = resolveOrchestratorAddress(input.network.env, input.network.chainId)
    const messageCalls = input.calls.map((call) => ({
        to: call.target,
        value: call.value,
        data: call.data,
    }))
    const message = {
        multichain: false,
        eoa: input.from,
        calls: messageCalls,
        nonce: input.nonce,
        payer: zeroAddress,
        paymentToken: zeroAddress,
        paymentMaxAmount: 0n,
        combinedGas: 50_000n,
        encodedPreCalls: [] as Hex[],
        encodedFundTransfers: [] as Hex[],
        settler: zeroAddress,
        expiry: 1_900_000_000n,
    }
    const domain = {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId: input.network.chainId,
        verifyingContract,
    }
    return {
        digest: hashTypedData({
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent',
            message,
        }),
        typedData: {
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent' as const,
            message,
        },
        context: {
            quote: {
                quotes: [
                    {
                        chainId: `0x${input.network.chainId.toString(16)}`,
                        orchestrator: verifyingContract,
                        intent: {
                            eoa: input.from,
                            calls: messageCalls.map((call) => ({
                                to: call.to,
                                value: call.value.toString(),
                                data: call.data,
                            })),
                            nonce: input.nonce.toString(),
                            combinedGas: message.combinedGas.toString(),
                            expiry: message.expiry.toString(),
                            payer: zeroAddress,
                            paymentToken: zeroAddress,
                            paymentMaxAmount: '0',
                            settler: zeroAddress,
                        },
                        extraPayment: '0x0',
                        ethPrice: '0x0',
                        paymentTokenDecimals: 6,
                        txGas: 1,
                        nativeFeeEstimate: { maxFeePerGas: 1, maxPriorityFeePerGas: 1 },
                        paymentAmount: '0',
                        feeTokenDeficit: '0x0',
                        assetDeficits: [],
                    },
                ],
                signature: '0x' as Hex,
                ttl: 2_000_000_000,
            },
        },
    }
}
