import { zeroAddress, type Address } from 'viem'
import { hashTypedData } from 'viem/utils'
import { INTENT_TYPES, type Call, type PrepareCallsResponse } from '@nubl/relayer-client'
import type { EnvName } from '../../src/lib/network-config'
import { resolveOrchestratorAddress } from '../../src/lib/orchestrator-address'
import { emptyHex } from './hex'

export function matchingPreparedCalls(input: {
    from: Address
    calls: Call[]
    nonce: bigint
    network: { env: EnvName; chainId: number }
    expiry?: bigint
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: bigint
}): PrepareCallsResponse {
    const verifyingContract = resolveOrchestratorAddress(input.network.env, input.network.chainId)

    const messageCalls = input.calls.map((call) => ({
        to: call.target,
        value: call.value,
        data: call.data }))

    const message = {
        multichain: false,
        eoa: input.from,
        calls: messageCalls,
        nonce: input.nonce,
        payer: input.payer ?? zeroAddress,
        paymentToken: input.paymentToken ?? zeroAddress,
        paymentMaxAmount: input.paymentMaxAmount ?? 0n,
        combinedGas: 50_000n,
        encodedPreCalls: emptyHex(),
        encodedFundTransfers: emptyHex(),
        settler: zeroAddress,
        expiry: input.expiry ?? 1_900_000_000n }

    const domain = {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId: input.network.chainId,
        verifyingContract }

    return {
        digest: hashTypedData({
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent',
            message }),
        typedData: {
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent' as const,
            message },
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
                                data: call.data })),
                            nonce: input.nonce.toString(),
                            combinedGas: message.combinedGas.toString(),
                            expiry: message.expiry.toString(),
                            payer: message.payer,
                            paymentToken: message.paymentToken,
                            paymentMaxAmount: message.paymentMaxAmount.toString(),
                            settler: zeroAddress },
                        extraPayment: '0x0',
                        ethPrice: '0x0',
                        paymentTokenDecimals: 6,
                        txGas: 1,
                        nativeFeeEstimate: { maxFeePerGas: 1, maxPriorityFeePerGas: 1 },
                        paymentAmount: (input.paymentMaxAmount ?? 0n) > 0n ? '1' : '0',
                        feeTokenDeficit: '0x0',
                        assetDeficits: [] },
                ],
                signature: '0x' as const,
                ttl: 2_000_000_000 } } }
}
