import { expect, mock, test } from 'bun:test'
import { zeroAddress, type Address, type Hex } from 'viem'
import { hashTypedData } from 'viem/utils'
import {
    INTENT_TYPES,
    paidUpgradeFeeNonce,
    verifyPaidUpgradeFeeTypedData,
    type Call,
} from '@nubl/relayer-client'
import { executeSignedCalls } from '../src/lib/execute-calls'

const EOA = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const FEE_RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const OTHER = '0x00000000000000000000000000000000000000ab' as Address
const QUOTE_SIGNATURE = `0x${'ab'.repeat(32)}` as Hex
const SIG =
    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as Hex
const NOW = 1_700_000_000n
const EXPIRY = NOW + 60n
const GAS_CEILING = 1_000_000n
const REQUESTED: Call[] = [{ target: TARGET, value: 1n, data: '0x1234' }]

function prepared(feeRecipient: Address, paymentMaxAmount = 2000n, ttl = Number(NOW + 300n)) {
    const message = {
        multichain: false,
        eoa: EOA,
        calls: [{ to: TARGET, value: 1n, data: '0x1234' as Hex }],
        nonce: 7n,
        payer: EOA,
        paymentToken: USDC,
        paymentMaxAmount,
        combinedGas: 50_000n,
        encodedPreCalls: [] as Hex[],
        encodedFundTransfers: [] as Hex[],
        settler: zeroAddress,
        expiry: EXPIRY,
    }
    const domain = {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId: 8453,
        verifyingContract: ORCHESTRATOR,
    }
    return {
        digest: hashTypedData({
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent',
            message,
        }),
        typedData: { domain, types: INTENT_TYPES, primaryType: 'Intent' as const, message },
        context: {
            quote: {
                quotes: [
                    {
                        chainId: '0x2105',
                        orchestrator: ORCHESTRATOR,
                        intent: {
                            eoa: EOA,
                            calls: [{ to: TARGET, value: '1', data: '0x1234' as Hex }],
                            nonce: '7',
                            combinedGas: '50000',
                            expiry: EXPIRY.toString(),
                            payer: EOA,
                            paymentToken: USDC,
                            paymentMaxAmount: paymentMaxAmount.toString(),
                            settler: zeroAddress,
                        },
                        extraPayment: '0x0',
                        ethPrice: '0x0',
                        paymentTokenDecimals: 6,
                        txGas: 1,
                        nativeFeeEstimate: { maxFeePerGas: 1, maxPriorityFeePerGas: 1 },
                        paymentAmount: '1000',
                        feeTokenDeficit: '0x0',
                        assetDeficits: [],
                        feeRecipient,
                        accountUpgrade: {
                            authorization: {
                                contractAddress: ORCHESTRATOR,
                                chainId: 8453,
                                nonce: 0,
                                signature: SIG,
                            },
                            preCall: {
                                eoa: EOA,
                                executionData: '0x' as Hex,
                                nonce: '0',
                                signature: SIG,
                            },
                        },
                    },
                ],
                signature: QUOTE_SIGNATURE,
                ttl,
            },
        },
    }
}

const params = {
    from: EOA,
    calls: REQUESTED,
    nonce: 7n,
    signerPrivateKey: `0x${'11'.repeat(32)}` as Hex,
    signerKeyHash: `0x${'22'.repeat(32)}` as Hex,
    chainId: 8453,
    env: 'prod' as const,
    verifyingContract: ORCHESTRATOR,
    payer: EOA,
    paymentToken: USDC,
    paymentMaxAmount: 2000n,
    expiry: EXPIRY,
    now: NOW,
    combinedGasCeiling: GAS_CEILING,
    expectedFeeRecipient: FEE_RECIPIENT,
}

test('executeSignedCalls refuses a fee payee that is not the relayer recipient', async () => {
    const signTypedData = mock(async () => SIG)
    await expect(
        executeSignedCalls(
            {
                prepareCalls: async () => prepared(OTHER),
                signTypedData,
                sendPreparedCalls: async () => ({ id: 'bundle-1' }),
                waitForBundle: async () => ({ id: 'bundle-1', status: 'confirmed' }) as never,
            },
            params,
        ),
    ).rejects.toThrow(/fee recipient does not match/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('executeSignedCalls refuses a fee authorization that outlives the quote', async () => {
    const signTypedData = mock(async () => SIG)
    // Cap matches the clamp of paymentAmount 1000 (5% with the 0.001 USDC floor → 2000),
    // so the existing intent binder accepts the quote. The quote TTL is already due,
    // so the EIP-3009 window cannot be signed.
    await expect(
        executeSignedCalls(
            {
                prepareCalls: async () => prepared(FEE_RECIPIENT, 2000n, Number(NOW)),
                signTypedData,
                sendPreparedCalls: async () => ({ id: 'bundle-1' }),
                waitForBundle: async () => ({ id: 'bundle-1', status: 'confirmed' }) as never,
            },
            params,
        ),
    ).rejects.toThrow(/fee authorization expired/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('verifyPaidUpgradeFeeTypedData refuses a mismatched nonce, payee, or amount', () => {
    const nonce = paidUpgradeFeeNonce({
        quoteSignature: QUOTE_SIGNATURE,
        chainId: 8453,
        from: EOA,
        to: FEE_RECIPIENT,
        value: 2000n,
    })
    const message = {
        from: EOA,
        to: FEE_RECIPIENT,
        value: 2000n,
        validAfter: 0n,
        validBefore: NOW + 120n,
        nonce,
    }
    const base = {
        account: EOA,
        chainId: 8453,
        quoteSignature: QUOTE_SIGNATURE,
        quoteTtl: NOW + 300n,
        clampedFee: 2000n,
        expectedFeeRecipient: FEE_RECIPIENT,
        now: NOW,
    }
    expect(() => verifyPaidUpgradeFeeTypedData({ ...base, message })).not.toThrow()
    expect(() =>
        verifyPaidUpgradeFeeTypedData({
            ...base,
            message: { ...message, nonce: `0x${'11'.repeat(32)}` },
        }),
    ).toThrow(/fee nonce does not match the quote/)
    expect(() =>
        verifyPaidUpgradeFeeTypedData({
            ...base,
            message: { ...message, to: OTHER },
        }),
    ).toThrow(/fee recipient does not match/)
    expect(() =>
        verifyPaidUpgradeFeeTypedData({
            ...base,
            message: { ...message, value: 2001n },
        }),
    ).toThrow(/fee amount does not match the quote/)
})

test('executeSignedCalls signs the fee authorization with the account key', async () => {
    const seen: Array<{ primaryType: string; message: { to: Address; value: bigint; nonce: Hex } }> = []
    const signTypedData = mock(async (input: { privateKey: Hex; typedData: { primaryType: string; message: { to: Address; value: bigint; nonce: Hex } } }) => {
        seen.push(input.typedData)
        expect(input.privateKey).toBe(params.signerPrivateKey)
        return SIG
    })
    let sent: { signature: Hex; feeAuthorization?: { nonce: Hex; signature: Hex } } | undefined
    await executeSignedCalls(
        {
            prepareCalls: async () => prepared(FEE_RECIPIENT),
            signTypedData,
            sendPreparedCalls: async (input) => {
                sent = input
                return { id: 'bundle-1' }
            },
            waitForBundle: async () => ({ id: 'bundle-1', status: 'confirmed' }) as never,
        },
        params,
    )
    expect(seen[0]?.primaryType).toBe('ReceiveWithAuthorization')
    expect(seen[0]?.message.to).toBe(FEE_RECIPIENT)
    expect(seen[0]?.message.value).toBe(2000n)
    expect(seen[0]?.message.nonce).toBe(
        paidUpgradeFeeNonce({
            quoteSignature: QUOTE_SIGNATURE,
            chainId: 8453,
            from: EOA,
            to: FEE_RECIPIENT,
            value: 2000n,
        }),
    )
    expect(sent?.feeAuthorization?.nonce).toBe(seen[0]?.message.nonce)
    expect(sent?.feeAuthorization?.signature).toBe(SIG)
    expect(sent?.signature).not.toBe(SIG)
})
