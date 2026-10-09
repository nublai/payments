import { afterAll, beforeAll, expect, test } from 'bun:test'
import { encodeFunctionData, getAddress, zeroAddress, type Hex } from 'viem'
import { executeAccountSwap } from './helpers/stub-execute'
import { PAID_FEE_CAP, resolveIntentPayment } from '../src/lib/intent-payment'
import type { QuoteSpendBound } from '../src/lib/quote-spend'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { relaySessionCallPermissions } from '../src/lib/swap-session'
import { installFormerProdDeployments } from './helpers/former-deployment-env'
import { matchingPreparedCalls } from './helpers/matching-prepared'
import { confirmedBundle } from './helpers/bundle-status'
import { testKeystoreBundle } from './helpers/keystore-bundle'
import { typedMock } from './helpers/typed-mock'
import type { AccountSwapDeps } from '../src/lib/account-swap'

let restoreFormerProdDeployments = () => {}

beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})

afterAll(() => {
    restoreFormerProdDeployments()
})

const USER = '0x1111111111111111111111111111111111111111' as const

const SESSION_ADDRESS = '0x3333333333333333333333333333333333333333' as const

const ROUTER = '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f' as const

const BASE_USDC = getAddress(resolveIntentPayment('prod', 8453, USER).paymentToken)

const EMPTY_ROUTER_CALL: Hex = encodeFunctionData({
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
                    ] },
                { name: 'refundTo', type: 'address' },
                { name: 'nftRecipient', type: 'address' },
                { name: 'metadata', type: 'bytes' },
            ],
            outputs: [] },
    ],
    functionName: 'multicall',
    args: [[], USER, zeroAddress, '0x'] })

function quote(value: bigint) {
    return {
        requestId: 'relay-request-1',
        steps: [
            {
                id: 'swap',
                kind: 'transaction',
                requestId: 'relay-request-1',
                items: [
                    {
                        status: 'incomplete' as const,
                        data: { to: ROUTER, data: EMPTY_ROUTER_CALL, value: value.toString(), chainId: 8453 } },
                ] },
        ],
        details: {
            currencyOut: {
                amount: '28500000000000000',
                amountFormatted: '0.0285',
                minimumAmount: '28500000000000000',
                amountUsd: '100.10' },
            rate: '3508.77',
            timeEstimate: 2 },
        fees: { gas: { amount: '0', amountUsd: '0.10' }, relayer: { amount: '0', amountUsd: '0.07' } } }
}

async function installedBound(input: {
    fromToken: 'USDC' | 'ETH'
    toToken: 'USDC' | 'ETH'
    amount: string
    value: bigint
}): Promise<QuoteSpendBound> {
    let bound: QuoteSpendBound | undefined
    await executeAccountSwap(
        {
            env: 'prod',
            fromToken: input.fromToken,
            toToken: input.toToken,
            amount: input.amount,
            sourceChain: 'base',
            password: 'pw',
            keystorePath: '/tmp/alice.json',
            yes: true },
        {
            readKeystoreBundle: typedMock<AccountSwapDeps['readKeystoreBundle']>(async () =>
                testKeystoreBundle(USER, SESSION_ADDRESS, 8453, 'prod')),
            decryptSessionKeystore: typedMock<AccountSwapDeps['decryptSessionKeystore']>(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const })),
            readTokenBalance: typedMock<AccountSwapDeps['readTokenBalance']>(async () => 10n ** 18n),
            getQuote: typedMock<AccountSwapDeps['getQuote']>(async () => quote(input.value)),
            readNonce: typedMock<AccountSwapDeps['readNonce']>(async () => 2n),
            confirmQuote: typedMock<AccountSwapDeps['confirmQuote']>(async () => true),
            prepareCalls: typedMock<AccountSwapDeps['prepareCalls']>(async (prepared) => matchingPreparedCalls(prepared)),
            signTypedData: typedMock<AccountSwapDeps['signTypedData']>(async () => `0x${'11'.repeat(64)}1b` as const),
            sendPreparedCalls: typedMock<AccountSwapDeps['sendPreparedCalls']>(async () => ({ id: 'bundle-1' })),
            waitForBundle: typedMock<AccountSwapDeps['waitForBundle']>(async () => confirmedBundle()),
            simulateQuoteCalls: async () => {},
            installQuoteSpendLimit: async (value: { bound: typeof bound }) => {
                bound = value.bound

                return async () => {}
            },
            readAllowance: async () => 0n,
            readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
            readErc721ApprovedForAll: async () => false,
            readErc721GetApproved: async () => zeroAddress,
            readErc1155ApprovedForAll: async () => false,
            readErc4626ShareBalance: async () => 0n,
            readErc4626ShareAllowance: async () => 0n,
            readApprovedSignatureCheckers: async () => [],
            getKeys: (async () => ({
                '0x2105': [
                    {
                        hash: computeSessionKeyHash(SESSION_ADDRESS),
                        expiry: '0x0',
                        type: 'secp256k1',
                        role: 'normal',
                        publicKey: '0x',
                        permissions: [
                            ...relaySessionCallPermissions(8453),
                            {
                                type: 'spend',
                                token: zeroAddress,
                                limit: '0x16345785d8a0000',
                                spent: '0x0',
                                period: 'forever' },
                        ] },
                ] })) },
    )

    if (!bound) throw new Error('installQuoteSpendLimit was not called')

    return bound
}

test('a USDC-input swap leaves room for the USDC fee cap in the USDC minute slot', async () => {
    const bound = await installedBound({ fromToken: 'USDC', toToken: 'ETH', amount: '5', value: 0n })
    expect(getAddress(bound.usdc)).toBe(BASE_USDC)
    expect(bound.usdcLimit).toBe(5_000000n + PAID_FEE_CAP)
    expect(bound.nativeLimit).toBe(0n)
})

test('an ETH-input swap paying a USDC fee gets the fee cap in the USDC minute slot', async () => {
    const amount = 10n ** 15n

    const bound = await installedBound({
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '0.001',
        value: amount })

    expect(getAddress(bound.usdc)).toBe(BASE_USDC)
    expect(bound.usdcLimit).toBe(PAID_FEE_CAP)
    expect(bound.nativeLimit).toBe(amount)
})
