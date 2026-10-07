import { expect, mock, test } from 'bun:test'
import { encodeFunctionData, erc20Abi, zeroAddress, type Address, type Hex } from 'viem'
import { executeAccountSwap } from '../src/lib/account-swap'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { relaySessionCallPermissions } from '../src/lib/swap-session'
import { formatRelayQuoteCalls } from '../src/lib/relay-allowlist'
import { matchingPreparedCalls } from './helpers/matching-prepared'

const SESSION_ADDRESS = '0x3333333333333333333333333333333333333333'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const ATTACKER = '0x2222222222222222222222222222222222222222' as Address
const ROUTER = '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f' as Address
const APPROVAL_PROXY = '0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE' as Address
const DEPOSITORY = '0x4cD00E387622C35bDDB9b4c962C136462338BC31' as Address
const MULTICALL = '0xcd6e13f7' as Hex
const USER = '0x1111111111111111111111111111111111111111' as Address
const multicallAbi = [
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
] as const
const EMPTY_MULTICALL = encodeFunctionData({
    abi: multicallAbi,
    functionName: 'multicall',
    args: [[], USER, zeroAddress, '0x'],
})
const SIGNATURE =
    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const

const increaseAllowanceAbi = [
    {
        name: 'increaseAllowance',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'spender', type: 'address' },
            { name: 'addedValue', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
    },
] as const

function makeKeystoreBundle(chainId = 8453) {
    return {
        format: 'split',
        rootPath: '/tmp/alice.json',
        sessionPath: '/tmp/sessions/default.json',
        root: {
            addresses: {
                root: '0x1111111111111111111111111111111111111111',
                delegated: '0x1111111111111111111111111111111111111111',
            },
            sessionRef: { dir: '/tmp/sessions' },
        },
        session: {
            network: {
                env: 'prod' as const,
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId,
            },
            addresses: {
                delegated: '0x1111111111111111111111111111111111111111',
                session: SESSION_ADDRESS,
            },
        },
    }
}

function quoteWithCall(input: {
    to: Address
    data: Hex
    value?: string
    chainId?: number
    kind?: string
    currencyInAmount?: string
}) {
    return {
        requestId: 'relay-request-1',
        steps: [
            {
                id: 'swap',
                kind: input.kind ?? 'transaction',
                requestId: 'relay-request-1',
                items: [
                    {
                        status: 'incomplete' as const,
                        data: {
                            to: input.to,
                            data: input.data,
                            value: input.value ?? '0',
                            chainId: input.chainId ?? 8453,
                        },
                    },
                ],
            },
        ],
        details: {
            currencyIn: { amount: input.currencyInAmount ?? '5000000' },
            currencyOut: { amount: '1000', minimumAmount: '1000' },
        },
    }
}

function attackTransferData(): Hex {
    return encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [ATTACKER, 5_000000n],
    })
}

function runQuote(input: {
    quote: ReturnType<typeof quoteWithCall> | Record<string, unknown>
    yes?: boolean
    amount?: string
    fromToken?: string
    toToken?: string
    sourceChain?: 'base' | 'anvil' | 'polygon'
    env?: 'prod' | 'dev'
    chainId?: number
    confirmQuote?: () => Promise<boolean>
    simulateQuoteCalls?: () => Promise<void>
}) {
    const signTypedData = mock(async () => SIGNATURE)
    const prepareCalls = mock(async (input: Parameters<typeof matchingPreparedCalls>[0]) =>
        matchingPreparedCalls(input),
    )
    const confirmQuote = input.confirmQuote ? mock(input.confirmQuote) : mock(async () => true)
    const result = executeAccountSwap(
        {
            env: input.env ?? 'prod',
            fromToken: input.fromToken ?? 'USDC',
            toToken: input.toToken ?? 'ETH',
            amount: input.amount ?? '5',
            sourceChain: input.sourceChain ?? 'base',
            password: 'pw',
            keystorePath: '/tmp/alice.json',
            yes: input.yes ?? true,
        },
        {
            readKeystoreBundle: mock(async () => makeKeystoreBundle(input.chainId ?? 8453)) as any,
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => 10_000000n),
            getQuote: mock(async () => input.quote) as any,
            readNonce: mock(async () => 2n),
            confirmQuote,
            prepareCalls: prepareCalls as any,
            signTypedData: signTypedData as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            simulateQuoteCalls: input.simulateQuoteCalls ?? (async () => {}),
            installQuoteSpendLimit: async () => async () => {},
            readAllowance: async () => 0n,
            readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
            readErc721ApprovedForAll: async () => false,
            readErc721GetApproved: async () => zeroAddress,
            readErc1155ApprovedForAll: async () => false,
            readErc4626ShareBalance: async () => 0n,
            readErc4626ShareAllowance: async () => 0n,
            readApprovedSignatureCheckers: async () => [],
            getKeys: async () => ({
                '0x2105': [
                    {
                        hash: computeSessionKeyHash(SESSION_ADDRESS as Address),
                        expiry: '0x0',
                        type: 'secp256k1' as const,
                        role: 'normal' as const,
                        publicKey: '0x' as const,
                        permissions: relaySessionCallPermissions(8453),
                    },
                ],
            }),
            waitForBundle: mock(async () => ({
                success: true,
                id: 'bundle-1',
                status: 'confirmed',
                statusCode: 200,
                receipt: {
                    transactionHash:
                        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    blockNumber: '1',
                    gasUsed: '1',
                    status: 'success',
                },
            })) as any,
        },
    )
    return { result, signTypedData, prepareCalls, confirmQuote }
}

test('executeAccountSwap refuses a USDC.transfer quote on chain 31337 before signing', async () => {
    const signTypedData = mock(async () => SIGNATURE)
    await expect(
        executeAccountSwap(
            {
                env: 'dev',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '5',
                sourceChain: 'anvil',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle(31337)) as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 10_000000n),
                getQuote: mock(async () =>
                    quoteWithCall({
                        to: USDC,
                        data: attackTransferData(),
                        chainId: 31337,
                    }),
                ) as any,
                readNonce: mock(async () => 2n),
                getKeys: async () => ({
                    '0x7a69': [
                        {
                            hash: computeSessionKeyHash(SESSION_ADDRESS as Address),
                            expiry: '0x0',
                            type: 'secp256k1' as const,
                            role: 'normal' as const,
                            publicKey: '0x' as const,
                            permissions: [],
                        },
                    ],
                }),
                prepareCalls: mock(async () => {
                    throw new Error('prepareCalls must not run')
                }) as any,
                signTypedData: signTypedData as any,
                sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            },
        ),
    ).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('transfer (0xa9059cbb)'),
    })
    expect(signTypedData).not.toHaveBeenCalled()
    expect(attackTransferData().startsWith('0xa9059cbb')).toBe(true)
})

test('executeAccountSwap refuses an unknown relay target before signing', async () => {
    const ran = runQuote({
        quote: quoteWithCall({ to: ATTACKER, data: MULTICALL }),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(ATTACKER),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('executeAccountSwap refuses an allowlisted target with an unknown selector', async () => {
    const ran = runQuote({
        quote: quoteWithCall({ to: ROUTER, data: '0xdeadbeef' }),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('0xdeadbeef'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('executeAccountSwap refuses approve to a spender that is not allowlisted', async () => {
    const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [ATTACKER, 5_000000n],
    })
    const ran = runQuote({
        quote: quoteWithCall({ to: USDC, data }),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(ATTACKER),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('executeAccountSwap refuses approve above the quoted input amount', async () => {
    const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [APPROVAL_PROXY, 5_000001n],
    })
    const ran = runQuote({
        quote: quoteWithCall({ to: USDC, data, currencyInAmount: '5000000' }),
        amount: '5',
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('above the quoted input'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('executeAccountSwap refuses increaseAllowance before signing', async () => {
    const data = encodeFunctionData({
        abi: increaseAllowanceAbi,
        functionName: 'increaseAllowance',
        args: [APPROVAL_PROXY, 1n],
    })
    const ran = runQuote({
        quote: quoteWithCall({ to: USDC, data }),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('increaseAllowance (0x39509351)'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('executeAccountSwap refuses a signature step before signing', async () => {
    const ran = runQuote({
        quote: quoteWithCall({ to: ROUTER, data: MULTICALL, kind: 'signature' }),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('signature steps'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('executeAccountSwap refuses a chain mismatch before signing', async () => {
    const ran = runQuote({
        quote: quoteWithCall({ to: ROUTER, data: MULTICALL, chainId: 137 }),
        sourceChain: 'base',
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('expected source chain base (8453)'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('executeAccountSwap refuses native value on a token quote', async () => {
    const ran = runQuote({
        quote: quoteWithCall({ to: ROUTER, data: MULTICALL, value: '1' }),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('native value'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('executeAccountSwap signs an allowlisted quote and still confirms when yes is set', async () => {
    const ran = runQuote({
        quote: quoteWithCall({ to: ROUTER, data: EMPTY_MULTICALL }),
        yes: true,
    })
    const result = await ran.result
    const { signTypedData, prepareCalls, confirmQuote } = ran
    expect(confirmQuote).toHaveBeenCalledTimes(1)
    expect(signTypedData).toHaveBeenCalledTimes(1)
    expect(prepareCalls.mock.calls[0]?.[0].calls).toEqual([
        { target: ROUTER, value: 0n, data: EMPTY_MULTICALL },
    ])
    expect(result.type).toBe('account_swap')
})

test('formatRelayQuoteCalls names the target, selector, approve spender, and value', () => {
    const approve = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [DEPOSITORY, 5_000000n],
    })
    const text = formatRelayQuoteCalls(
        quoteWithCall({
            to: USDC,
            data: approve,
            value: '0',
        }) as any,
    )
    expect(text).toContain('approve (0x095ea7b3)')
    expect(text).toContain('Relay Depository')
    expect(text).toContain(DEPOSITORY)
    expect(text).toContain('amount 5000000')
    expect(text).toContain('value 0')
})

test('executeAccountSwap refuses transferFrom before signing', async () => {
    const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transferFrom',
        args: [ATTACKER, ATTACKER, 1n],
    })
    const ran = runQuote({
        quote: quoteWithCall({ to: USDC, data }),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('transferFrom (0x23b872dd)'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})
