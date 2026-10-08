import { describe, expect, it, vi } from 'vitest';
import { zeroAddress, type Address, type Hex } from 'viem';
import { hashTypedData } from 'viem/utils';
import { INTENT_TYPES, type Call } from '../../src/types.js';
import type { PrepareCallsResponse } from '../../src/actions/prepareCalls.js';
import { executePreparedCalls } from '../../src/helpers/executePreparedCalls.js';
import { signedPaymentMaxForQuote } from '../../src/helpers/bindPreparedCalls.js';

const EOA = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8' as Address;
const SIG = `0x${'11'.repeat(65)}` as Hex;
const CALLS: Call[] = [{ target: EOA, value: 0n, data: '0x' }];
const PAID_FEE_CAP = 5_000_000n;

function echoPrepared(input: {
    from: Address;
    calls: Call[];
    nonce?: bigint;
    expiry?: bigint;
    payer?: Address;
    paymentToken?: Address;
    paymentMaxAmount?: bigint;
    chainId?: number;
}, paymentAmount: string) {
    const chainId = input.chainId ?? 8453;
    const cap = input.paymentMaxAmount ?? 0n;
    const payer = input.payer ?? zeroAddress;
    const paymentToken = input.paymentToken ?? zeroAddress;
    const expiry = input.expiry ?? 1_900_000_000n;
    const nonce = input.nonce ?? 1n;
    const messageCalls = input.calls.map((call) => ({
        to: call.target,
        value: call.value,
        data: call.data ?? '0x',
    }));
    const message = {
        multichain: false,
        eoa: input.from,
        calls: messageCalls,
        nonce,
        payer,
        paymentToken,
        paymentMaxAmount: cap,
        combinedGas: 50_000n,
        encodedPreCalls: [] as Hex[],
        encodedFundTransfers: [] as Hex[],
        settler: zeroAddress,
        expiry,
    };
    return {
        digest: hashTypedData({
            domain: {
                name: 'Orchestrator',
                version: '0.5.5',
                chainId,
                verifyingContract: ORCHESTRATOR,
            },
            types: INTENT_TYPES,
            primaryType: 'Intent' as const,
            message,
        }),
        typedData: {
            domain: {
                name: 'Orchestrator',
                version: '0.5.5',
                chainId,
                verifyingContract: ORCHESTRATOR,
            },
            types: INTENT_TYPES,
            primaryType: 'Intent' as const,
            message,
        },
        context: {
            quote: {
                quotes: [
                    {
                        chainId: `0x${chainId.toString(16)}`,
                        orchestrator: ORCHESTRATOR,
                        intent: {
                            eoa: input.from,
                            calls: messageCalls.map((call) => ({
                                to: call.to,
                                value: call.value.toString(),
                                data: call.data,
                            })),
                            nonce: nonce.toString(),
                            combinedGas: '50000',
                            expiry: expiry.toString(),
                            payer,
                            paymentToken,
                            paymentMaxAmount: cap.toString(),
                            settler: zeroAddress,
                        },
                        paymentAmount,
                    },
                ],
                signature: '0x' as Hex,
                ttl: 2_000_000_000,
            },
        },
    };
}

function client(paymentAmount: string) {
    const prepareCalls = vi.fn(async (input: Parameters<typeof echoPrepared>[0]) =>
        echoPrepared(input, paymentAmount),
    );
    return {
        prepareCalls,
        relayer: {
            chain: { id: 8453 },
            relayerConfig: { chainId: 8453 },
            prepareCalls,
            sendPreparedCalls: vi.fn(async () => ({ id: 'bundle-1' })),
        },
    };
}

const signer = {
    type: 'typedData' as const,
    signTypedData: vi.fn(async () => SIG),
};

describe('executePreparedCalls fee cap', () => {
    it('clamps a caller cap above 5 USDC', async () => {
        const { prepareCalls, relayer } = client('1');
        const signTypedData = vi.fn(async (_typedData: PrepareCallsResponse['typedData']) => SIG);
        await executePreparedCalls({
            client: relayer as never,
            from: EOA,
            calls: CALLS,
            chainId: 8453,
            nonce: 1n,
            verifyingContract: ORCHESTRATOR,
            payer: EOA,
            paymentToken: TOKEN,
            paymentMaxAmount: 100_000_000n,
            signer: { type: 'typedData', signTypedData },
            skipWait: true,
        });
        expect(prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP);
        const typed = signTypedData.mock.calls.at(-1)?.[0] as {
            message: { paymentMaxAmount: bigint };
        };
        expect(typed.message.paymentMaxAmount).toBe(signedPaymentMaxForQuote(1n));
    });

    it('refuses a 50 USDC quote when the caller cap is above 5 USDC', async () => {
        const { relayer } = client('50000000');
        await expect(
            executePreparedCalls({
                client: relayer as never,
                from: EOA,
                calls: CALLS,
                chainId: 8453,
                nonce: 1n,
                verifyingContract: ORCHESTRATOR,
                payer: EOA,
                paymentToken: TOKEN,
                paymentMaxAmount: 100_000_000n,
                signer,
                skipWait: true,
            }),
        ).rejects.toThrow(/payment amount exceeds fee cap/);
    });

    it('refuses a cap without payer or paymentToken', async () => {
        const { relayer } = client('1');
        await expect(
            executePreparedCalls({
                client: relayer as never,
                from: EOA,
                calls: CALLS,
                chainId: 8453,
                nonce: 1n,
                verifyingContract: ORCHESTRATOR,
                paymentMaxAmount: 1001n,
                signer,
                skipWait: true,
            }),
        ).rejects.toThrow(/payer and paymentToken/);
        await expect(
            executePreparedCalls({
                client: relayer as never,
                from: EOA,
                calls: CALLS,
                chainId: 8453,
                nonce: 1n,
                verifyingContract: ORCHESTRATOR,
                payer: EOA,
                paymentMaxAmount: 1001n,
                signer,
                skipWait: true,
            }),
        ).rejects.toThrow(/payer and paymentToken/);
        await expect(
            executePreparedCalls({
                client: relayer as never,
                from: EOA,
                calls: CALLS,
                chainId: 8453,
                nonce: 1n,
                verifyingContract: ORCHESTRATOR,
                paymentToken: TOKEN,
                paymentMaxAmount: 1001n,
                signer,
                skipWait: true,
            }),
        ).rejects.toThrow(/payer and paymentToken/);
    });

    it('refuses a zero payer and token off local', async () => {
        const { relayer } = client('1');
        await expect(
            executePreparedCalls({
                client: relayer as never,
                from: EOA,
                calls: CALLS,
                chainId: 8453,
                nonce: 1n,
                verifyingContract: ORCHESTRATOR,
                payer: zeroAddress,
                paymentToken: zeroAddress,
                paymentMaxAmount: 100_000_000n,
                signer,
                skipWait: true,
            }),
        ).rejects.toThrow(/zero address/);
    });

    it('refuses a fee token that is not native USDC for the chain', async () => {
        const wbtc = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as Address;
        const { relayer } = client('1');
        await expect(
            executePreparedCalls({
                client: relayer as never,
                from: EOA,
                calls: CALLS,
                chainId: 8453,
                nonce: 1n,
                verifyingContract: ORCHESTRATOR,
                payer: EOA,
                paymentToken: wbtc,
                paymentMaxAmount: 1001n,
                signer,
                skipWait: true,
            }),
        ).rejects.toThrow(/native USDC/);
        const usdce = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as Address;
        await expect(
            executePreparedCalls({
                client: relayer as never,
                from: EOA,
                calls: CALLS,
                chainId: 137,
                nonce: 1n,
                verifyingContract: ORCHESTRATOR,
                payer: EOA,
                paymentToken: usdce,
                paymentMaxAmount: 1001n,
                signer,
                skipWait: true,
            }),
        ).rejects.toThrow(/native USDC/);
    });
});
