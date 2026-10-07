import { afterAll, beforeAll, expect, test } from 'bun:test'
import { encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem'
import { INTENT_TYPES } from '@nubl/relayer-client'
import { PAID_FEE_CAP } from '../src/lib/intent-payment'
import { reviewRelayQuote } from '../src/lib/relay-allowlist'
import type { RelayQuoteResponse } from '../src/lib/relay-link'
import { reviewSwapSessionSignature } from '../src/lib/session-daemon-policy'
import { installFormerProdDeployments } from './helpers/former-deployment-env'

let restoreFormerProdDeployments = () => {}
beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})
afterAll(() => {
    restoreFormerProdDeployments()
})

const USER = '0x1111111111111111111111111111111111111111' as Address
const EXPECTED = '0x4444444444444444444444444444444444444444' as Address
const WRONG = '0x6666666666666666666666666666666666666666' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const OTHER = '0x5555555555555555555555555555555555555555' as Address
const ROUTER = '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f' as Address
const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8' as Address
const FEE = 1_000_000n

function routerMulticall(user: Address): Hex {
    return encodeFunctionData({
        abi: [
            {
                name: 'multicall',
                type: 'function',
                stateMutability: 'payable',
                inputs: [
                    {
                        name: 'calls',
                        type: 'tuple[]',
                        components: [
                            { name: 'target', type: 'address' },
                            { name: 'allowFailure', type: 'bool' },
                            { name: 'value', type: 'uint256' },
                            { name: 'callData', type: 'bytes' },
                        ],
                    },
                    { name: 'refundTo', type: 'address' },
                    { name: 'nftRecipient', type: 'address' },
                    { name: 'metadata', type: 'bytes' },
                ],
                outputs: [],
            },
        ],
        functionName: 'multicall',
        args: [
            [{ target: ROUTER, allowFailure: false, value: 0n, callData: '0x9bb43718' }],
            user,
            user,
            '0x',
        ],
    })
}

function intent(input: { token: Address; amount: bigint; recipient: Address }) {
    return {
        domain: {
            name: 'Orchestrator',
            version: '0.5.5',
            chainId: 8453,
            verifyingContract: ORCHESTRATOR,
        },
        types: INTENT_TYPES,
        primaryType: 'Intent' as const,
        message: {
            multichain: false,
            eoa: USER,
            calls: [{ to: ROUTER, value: 0n, data: routerMulticall(USER) }],
            nonce: 1n,
            payer: zeroAddress,
            paymentToken: input.token,
            paymentMaxAmount: input.amount,
            paymentAmount: input.amount,
            paymentRecipient: input.recipient,
            combinedGas: 0n,
            encodedPreCalls: [],
            encodedFundTransfers: [],
            settler: zeroAddress,
            expiry: 0n,
        },
    }
}

function quote(): RelayQuoteResponse {
    return {
        steps: [
            {
                id: 'swap',
                kind: 'transaction',
                items: [
                    {
                        status: 'incomplete',
                        data: {
                            to: ROUTER,
                            data: routerMulticall(USER),
                            value: '0',
                            chainId: 8453,
                        },
                    },
                ],
            },
        ],
        details: {
            currencyIn: { amount: '1' },
            currencyOut: { amount: '100', minimumAmount: '100' },
        },
    }
}

function reviewTw(input: { token: Address; amount: bigint; recipient: Address; feeAmount: bigint }) {
    reviewRelayQuote(quote(), {
        sourceChainId: 8453,
        destinationChainId: 8453,
        slippageBps: 50,
        inputAmount: 1n,
        inputIsNative: true,
        originCurrency: zeroAddress,
        user: USER,
        recipient: USER,
        payment: {
            token: input.token,
            amount: input.amount,
            recipient: input.recipient,
            feeAmount: input.feeAmount,
            expectedRecipient: EXPECTED,
        },
    })
}

test('swap daemon refuses a payment token other than the quote fee', () => {
    expect(() =>
        reviewSwapSessionSignature(intent({ token: OTHER, amount: FEE, recipient: EXPECTED }), {
            feeAmount: FEE,
            recipient: EXPECTED,
        }),
    ).toThrow(/Payment token/)
})

test('swap daemon refuses a payment amount over the quote fee', () => {
    expect(() =>
        reviewSwapSessionSignature(
            intent({ token: USDC, amount: FEE + 1n, recipient: EXPECTED }),
            { feeAmount: FEE, recipient: EXPECTED },
        ),
    ).toThrow(/over the quote fee/)
})

test('swap daemon refuses a payment amount over 5 USDC', () => {
    const over = PAID_FEE_CAP + 1n
    expect(() =>
        reviewSwapSessionSignature(intent({ token: USDC, amount: over, recipient: EXPECTED }), {
            feeAmount: over,
            recipient: EXPECTED,
        }),
    ).toThrow(/5 USDC/)
})

test('swap daemon refuses a payment recipient other than the expected one', () => {
    expect(() =>
        reviewSwapSessionSignature(intent({ token: USDC, amount: FEE, recipient: WRONG }), {
            feeAmount: FEE,
            recipient: EXPECTED,
        }),
    ).toThrow(/Payment recipient/)
})

test('tw quote reviewer refuses a payment token other than the quote fee', () => {
    expect(() => reviewTw({ token: OTHER, amount: FEE, recipient: EXPECTED, feeAmount: FEE })).toThrow(
        /Payment token/,
    )
})

test('tw quote reviewer refuses a payment amount over the quote fee', () => {
    expect(() =>
        reviewTw({ token: USDC, amount: FEE + 1n, recipient: EXPECTED, feeAmount: FEE }),
    ).toThrow(/over the quote fee/)
})

test('tw quote reviewer refuses a payment amount over 5 USDC', () => {
    const over = PAID_FEE_CAP + 1n
    expect(() => reviewTw({ token: USDC, amount: over, recipient: EXPECTED, feeAmount: over })).toThrow(
        /5 USDC/,
    )
})

test('tw quote reviewer refuses a payment recipient other than the expected one', () => {
    expect(() => reviewTw({ token: USDC, amount: FEE, recipient: WRONG, feeAmount: FEE })).toThrow(
        /Payment recipient/,
    )
})

test('a payment equal to the quote fee and the expected recipient is signed', () => {
    expect(() =>
        reviewSwapSessionSignature(intent({ token: USDC, amount: FEE, recipient: EXPECTED }), {
            feeAmount: FEE,
            recipient: EXPECTED,
        }),
    ).not.toThrow()
    expect(() => reviewTw({ token: USDC, amount: FEE, recipient: EXPECTED, feeAmount: FEE })).not.toThrow()
})
