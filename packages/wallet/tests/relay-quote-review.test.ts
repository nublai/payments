import { expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { encodeFunctionData, erc20Abi, zeroAddress, type Address, type Hex } from 'viem'
import { executeAccountSwap } from '../src/lib/account-swap'
import { formatRelayQuoteCalls, reviewRelayQuote } from '../src/lib/relay-allowlist'
import { hashRelayOrder } from '../src/lib/relay-order'
import { simulateRelayQuote, type SimulateRelayQuoteInput } from '../src/lib/relay-simulate'
import { computeSessionKeyHash } from '../src/lib/session-common'

const USER = '0x1111111111111111111111111111111111111111' as Address
const ATTACKER = '0x2222222222222222222222222222222222222222' as Address
const SESSION_ADDRESS = '0x3333333333333333333333333333333333333333' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const ROUTER = '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f' as Address
const APPROVAL_PROXY = '0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE' as Address
const DEPOSITORY = '0x4cD00E387622C35bDDB9b4c962C136462338BC31' as Address
const SIGNATURE =
    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const
const CAP = 5_000000n

const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/relay-base-usdc-polygon-quote.json', import.meta.url), 'utf8'),
) as {
    requestId: string
    orderId: string
    orderData: {
        output: { payments: { recipient: string }[] }
        inputs: { refunds: { recipient: string }[] }[]
    }
    approve: { to: string; data: string; value: string }
    deposit: { to: string; data: string; value: string }
    currencyOutMinimum: string
}

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

const transferAndMulticallAbi = [
    {
        name: 'transferAndMulticall',
        type: 'function',
        stateMutability: 'payable',
        inputs: [
            { name: 'tokens', type: 'address[]' },
            { name: 'amounts', type: 'uint256[]' },
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

type Inner = { target: Address; allowFailure: boolean; value: bigint; callData: Hex }

function multicall(refundTo: Address, nftRecipient: Address, metadata: Hex = '0x'): Hex {
    return encodeFunctionData({
        abi: multicallAbi,
        functionName: 'multicall',
        args: [[], refundTo, nftRecipient, metadata],
    })
}

function transferAndMulticall(input: {
    token?: Address
    amount?: bigint
    refundTo?: Address
    nftRecipient?: Address
    calls?: Inner[]
}): Hex {
    return encodeFunctionData({
        abi: transferAndMulticallAbi,
        functionName: 'transferAndMulticall',
        args: [
            [input.token ?? USDC],
            [input.amount ?? CAP],
            input.calls ?? [],
            input.refundTo ?? USER,
            input.nftRecipient ?? zeroAddress,
            '0x',
        ],
    })
}

function word(address: Address): string {
    return address.toLowerCase().slice(2).padStart(64, '0')
}

function depositNative(depositor: Address, id: Hex): Hex {
    return `0x49290c1c${word(depositor)}${id.slice(2).padStart(64, '0')}` as Hex
}

function depositErc20(depositor: Address, token: Address, amount: bigint, id: Hex): Hex {
    const amountWord = amount.toString(16).padStart(64, '0')
    return `0xe8017952${word(depositor)}${word(token)}${amountWord}${id.slice(2).padStart(64, '0')}` as Hex
}

function approve(spender: Address, amount = CAP): Hex {
    return encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amount],
    })
}

function quoteWith(items: { to: Address; data: Hex; value?: string }[], extra?: Record<string, unknown>) {
    return {
        requestId: fixture.requestId,
        steps: [
            {
                id: 'swap',
                kind: 'transaction',
                items: items.map((item) => ({
                    status: 'incomplete' as const,
                    data: {
                        to: item.to,
                        data: item.data,
                        value: item.value ?? '0',
                        chainId: 8453,
                    },
                })),
            },
        ],
        details: {
            currencyIn: { amount: CAP.toString() },
            currencyOut: { amount: '1000', amountUsd: '1', minimumAmount: '1000' },
            rate: '1',
        },
        ...extra,
    }
}

function liveQuote(input?: { order?: unknown; orderId?: string; depositData?: Hex }) {
    const order = input?.order ?? fixture.orderData
    return quoteWith(
        [
            {
                to: getAddressSafe(fixture.approve.to),
                data: fixture.approve.data as Hex,
            },
            {
                to: getAddressSafe(fixture.deposit.to),
                data: input?.depositData ?? (fixture.deposit.data as Hex),
            },
        ],
        {
            requestId: fixture.requestId,
            protocol: {
                v2: { orderId: input?.orderId ?? fixture.orderId, orderData: order },
            },
            details: {
                currencyIn: { amount: '5000000', amountFormatted: '5.0' },
                currencyOut: {
                    amount: '4976586',
                    amountFormatted: '4.976586',
                    minimumAmount: fixture.currencyOutMinimum,
                    amountUsd: '4.97',
                },
                rate: '0.995',
                timeEstimate: 9,
            },
        },
    )
}

function getAddressSafe(value: string): Address {
    return value as Address
}

function patchedOrder(patch: (order: typeof fixture.orderData) => void) {
    const order = structuredClone(fixture.orderData)
    patch(order)
    return { order, hash: hashRelayOrder(order) }
}

function scriptedBalances(input: { before: bigint[]; after: bigint[]; revert?: boolean }) {
    let reads = 0
    return async (method: string, params: unknown[]) => {
        if (method === 'eth_getBalance' || method === 'eth_call') {
            const wordValue = input.before[reads]
            if (wordValue === undefined) {
                throw new Error(`unexpected balance read ${reads} via ${method}`)
            }
            reads += 1
            return `0x${wordValue.toString(16)}`
        }
        if (method === 'eth_simulateV1') {
            const block = params[0] as { blockStateCalls: { calls: unknown[] }[] }
            const calls = block.blockStateCalls[0]?.calls ?? []
            const probeStart = calls.length - input.after.length
            return [
                {
                    calls: calls.map((_, index) => ({
                        status: input.revert ? '0x0' : '0x1',
                        returnData:
                            index < probeStart
                                ? '0x'
                                : `0x${(input.after[index - probeStart] ?? 0n).toString(16).padStart(64, '0')}`,
                    })),
                },
            ]
        }
        throw new Error(`unexpected rpc method ${method}`)
    }
}

function run(input: {
    quote?: unknown
    getQuote?: () => Promise<unknown>
    yes?: boolean
    amount?: string
    fromToken?: string
    toToken?: string
    destinationChain?: 'polygon' | 'base'
    recipient?: string
    balance?: bigint
    confirmQuote?: () => Promise<boolean>
    simulateQuoteCalls?: (value: SimulateRelayQuoteInput) => Promise<void>
    getKeys?: () => Promise<unknown>
}) {
    const signTypedData = mock(async () => SIGNATURE)
    const prepareCalls = mock(async () => ({
        context: { quote: { quotes: [] } },
        digest: '0xabc' as const,
        typedData: { domain: {}, types: {}, primaryType: 'Intent', message: {} },
    }))
    const confirmQuote = input.confirmQuote ? mock(input.confirmQuote) : mock(async () => true)
    const result = executeAccountSwap(
        {
            env: 'prod',
            fromToken: input.fromToken ?? 'USDC',
            toToken: input.toToken ?? 'ETH',
            amount: input.amount ?? '5',
            sourceChain: 'base',
            destinationChain: input.destinationChain,
            recipient: input.recipient,
            password: 'pw',
            keystorePath: '/tmp/alice.json',
            yes: input.yes ?? true,
        },
        {
            readKeystoreBundle: mock(async () => ({
                format: 'split',
                rootPath: '/tmp/alice.json',
                sessionPath: '/tmp/sessions/default.json',
                root: {
                    addresses: { root: USER, delegated: USER },
                    sessionRef: { dir: '/tmp/sessions' },
                },
                session: {
                    network: {
                        env: 'prod' as const,
                        relayerUrl: 'http://127.0.0.1:8787',
                        rpcUrl: 'https://mainnet.base.org',
                        chainId: 8453,
                    },
                    addresses: { delegated: USER, session: SESSION_ADDRESS },
                },
            })) as any,
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => input.balance ?? 10_000000n),
            getQuote: mock(input.getQuote ?? (async () => input.quote)) as any,
            readNonce: mock(async () => 2n),
            confirmQuote,
            prepareCalls: prepareCalls as any,
            signTypedData: signTypedData as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
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
            pollIntentStatus: mock(async () => ({
                status: 'success',
                txHashes: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
            })) as any,
            simulateQuoteCalls: input.simulateQuoteCalls ?? (async () => {}),
            ...(input.getKeys ? { getKeys: input.getKeys as any } : {}),
        },
    )
    return { result, signTypedData, prepareCalls, confirmQuote }
}

function ethKeys() {
    return {
        '0x2105': [
            {
                hash: computeSessionKeyHash(SESSION_ADDRESS),
                expiry: '0x0',
                type: 'secp256k1',
                role: 'normal',
                publicKey: '0x',
                permissions: [
                    {
                        type: 'spend',
                        token: zeroAddress,
                        limit: '0x16345785d8a0000',
                        spent: '0x0',
                        period: 'forever',
                    },
                ],
            },
        ],
    }
}

const innerTransfer = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [ATTACKER, CAP],
})

test('refuses an inner USDC.transfer inside transferAndMulticall', async () => {
    const quote = quoteWith([
        { to: USDC, data: approve(APPROVAL_PROXY) },
        {
            to: APPROVAL_PROXY,
            data: transferAndMulticall({
                calls: [{ target: USDC, allowFailure: false, value: 0n, callData: innerTransfer }],
            }),
        },
    ])
    expect(() =>
        reviewRelayQuote(quote as any, {
            sourceChainId: 8453,
            inputAmount: CAP,
            inputIsNative: false,
            originCurrency: USDC,
            user: USER,
            recipient: USER,
        }),
    ).not.toThrow()

    const simulate = (input: SimulateRelayQuoteInput) =>
        simulateRelayQuote({
            ...input,
            request: scriptedBalances({
                before: [10_000000n, 10n ** 18n],
                after: [CAP, 10n ** 18n],
            }),
        })
    await expect(simulate({
        rpcUrl: 'http://127.0.0.1:1',
        chainId: 8453,
        user: USER,
        calls: [
            { to: USDC, data: approve(APPROVAL_PROXY), value: 0n },
            {
                to: APPROVAL_PROXY,
                data: transferAndMulticall({
                    calls: [{ target: USDC, allowFailure: false, value: 0n, callData: innerTransfer }],
                }),
                value: 0n,
            },
        ],
        watches: [
            { kind: 'erc20', token: USDC, role: 'origin' },
            { kind: 'native', role: 'output' },
        ],
        cap: CAP,
        sameChain: true,
        minimumOutput: 1000n,
    })).rejects.toThrow(/below the quoted minimum/)

    const ran = run({ quote, simulateQuoteCalls: simulate })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('below the quoted minimum'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses a hostile refundTo on multicall', async () => {
    const ran = run({
        quote: quoteWith([{ to: ROUTER, data: multicall(ATTACKER, zeroAddress) }]),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`refunds to ${ATTACKER}`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses a hostile nftRecipient on multicall', async () => {
    const ran = run({
        quote: quoteWith([{ to: ROUTER, data: multicall(USER, ATTACKER) }]),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`sends NFTs to ${ATTACKER}`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses a hostile refundTo on transferAndMulticall', async () => {
    const ran = run({
        quote: quoteWith([{ to: APPROVAL_PROXY, data: transferAndMulticall({ refundTo: ATTACKER }) }]),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`refunds to ${ATTACKER}`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses a hostile nftRecipient on transferAndMulticall', async () => {
    const ran = run({
        quote: quoteWith([
            { to: APPROVAL_PROXY, data: transferAndMulticall({ nftRecipient: ATTACKER }) },
        ]),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`sends NFTs to ${ATTACKER}`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('allows a zero refundTo and nftRecipient', async () => {
    const ran = run({
        quote: quoteWith([{ to: ROUTER, data: multicall(zeroAddress, zeroAddress) }]),
    })
    await ran.result
    expect(ran.signTypedData).toHaveBeenCalledTimes(1)
})

test('refuses a hostile depositor on depositNative', async () => {
    const ran = run({
        quote: quoteWith([
            { to: DEPOSITORY, data: depositNative(ATTACKER, fixture.orderId as Hex) },
        ]),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`deposits for ${ATTACKER}`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses a hostile depositor on depositErc20', async () => {
    const ran = run({
        quote: quoteWith([
            {
                to: DEPOSITORY,
                data: depositErc20(ATTACKER, USDC, CAP, fixture.orderId as Hex),
            },
        ]),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`deposits for ${ATTACKER}`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses depositErc20 calldata that omits the id word', async () => {
    const short = depositErc20(USER, USDC, CAP, fixture.orderId as Hex).slice(0, 2 + 8 + 64 * 3) as Hex
    const ran = run({ quote: quoteWith([{ to: DEPOSITORY, data: short }]) })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('depositErc20 calldata is incomplete'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses a deposit id that is the request id instead of the order hash', async () => {
    const ran = run({
        quote: liveQuote({
            depositData: depositErc20(USER, USDC, CAP, fixture.requestId as Hex),
        }),
        toToken: 'USDC',
        destinationChain: 'polygon',
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(
            `deposit id ${fixture.requestId} does not match the order hash ${fixture.orderId}`,
        ),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('signs the live quote whose deposit id is the order hash', async () => {
    const quote = liveQuote()
    const text = formatRelayQuoteCalls(quote as any)
    expect(text).toContain(`depositor ${USER}`)
    expect(text).toContain(`Output recipient: ${USER}`)
    expect(text).toContain('depositErc20 (0xe8017952)')
    expect(hashRelayOrder(fixture.orderData)).toBe(fixture.orderId)

    const ran = run({
        quote,
        toToken: 'USDC',
        destinationChain: 'polygon',
    })
    const result = await ran.result
    expect(ran.confirmQuote).toHaveBeenCalledTimes(1)
    expect(ran.signTypedData).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('account_bridge')
})

test('confirmation text shows refundTo and the decoded inner calls', () => {
    const cleanup = '0x9bb43718' as Hex
    const quote = quoteWith([
        {
            to: APPROVAL_PROXY,
            data: transferAndMulticall({
                calls: [
                    { target: USDC, allowFailure: false, value: 0n, callData: approve(ROUTER) },
                    { target: ROUTER, allowFailure: false, value: 0n, callData: cleanup },
                ],
            }),
        },
    ])
    const text = formatRelayQuoteCalls(quote as any)
    expect(text).toContain(`refundTo ${USER}`)
    expect(text).toContain(`nftRecipient ${zeroAddress}`)
    expect(text).toContain(`inner 1. ${USDC} approve (0x095ea7b3)`)
    expect(text).toContain(`inner 2. ${ROUTER} cleanupErc20s (0x9bb43718)`)
})

test('refuses a hostile output payment recipient', async () => {
    const patched = patchedOrder((order) => {
        order.output.payments[0]!.recipient = ATTACKER
    })
    const ran = run({
        quote: liveQuote({
            order: patched.order,
            orderId: patched.hash,
            depositData: depositErc20(USER, USDC, CAP, patched.hash),
        }),
        toToken: 'USDC',
        destinationChain: 'polygon',
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`pays ${ATTACKER}`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses a hostile order refund recipient', async () => {
    const patched = patchedOrder((order) => {
        order.inputs[0]!.refunds[0]!.recipient = ATTACKER
    })
    const ran = run({
        quote: liveQuote({
            order: patched.order,
            orderId: patched.hash,
            depositData: depositErc20(USER, USDC, CAP, patched.hash),
        }),
        toToken: 'USDC',
        destinationChain: 'polygon',
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`refunds the order to ${ATTACKER}`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('signs when the output recipient is the bridge recipient the user passed', async () => {
    const patched = patchedOrder((order) => {
        order.output.payments[0]!.recipient = ATTACKER
    })
    const ran = run({
        quote: liveQuote({
            order: patched.order,
            orderId: patched.hash,
            depositData: depositErc20(USER, USDC, CAP, patched.hash),
        }),
        toToken: 'USDC',
        destinationChain: 'polygon',
        recipient: ATTACKER,
    })
    await ran.result
    expect(ran.signTypedData).toHaveBeenCalledTimes(1)
})

test('refuses a USDC pull on an ETH quote', async () => {
    const ran = run({
        quote: quoteWith(
            [{ to: APPROVAL_PROXY, data: transferAndMulticall({ amount: 100_000000n }) }],
            {
                details: {
                    currencyOut: { amount: '1', amountUsd: '1', minimumAmount: '1' },
                    rate: '1',
                },
            },
        ),
        fromToken: 'ETH',
        toToken: 'USDC',
        amount: '0.001',
        balance: 10n ** 18n,
        getKeys: async () => ethKeys(),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`pulls ${USDC}, which is not the quoted input token`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses two transferAndMulticall pulls that each equal the cap', async () => {
    const pull = transferAndMulticall({ amount: CAP })
    const ran = run({
        quote: quoteWith([
            { to: APPROVAL_PROXY, data: pull },
            { to: APPROVAL_PROXY, data: pull },
        ]),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`pulls ${CAP * 2n} base units, above the quoted input`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses two approves that each equal the cap', async () => {
    const ran = run({
        quote: quoteWith([
            { to: USDC, data: approve(APPROVAL_PROXY, CAP) },
            { to: USDC, data: approve(DEPOSITORY, CAP) },
        ]),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(`approves ${CAP * 2n} base units, above the quoted input`),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('signs one approve and one pull that each equal the cap', async () => {
    const ran = run({
        quote: quoteWith([
            { to: USDC, data: approve(APPROVAL_PROXY, CAP) },
            { to: APPROVAL_PROXY, data: transferAndMulticall({ amount: CAP }) },
        ]),
    })
    await ran.result
    expect(ran.signTypedData).toHaveBeenCalledTimes(1)
})

test('re-prompts when calldata changes after confirmation', async () => {
    const first = quoteWith([{ to: ROUTER, data: multicall(USER, zeroAddress, '0x') }])
    const second = quoteWith([{ to: ROUTER, data: multicall(USER, zeroAddress, '0x01') }])
    let n = 0
    const nowValues = [0, 31_000, 31_000, 31_000]
    let nowIndex = 0
    const originalNow = Date.now
    Date.now = () => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? 31_000
    const ran = run({
        yes: false,
        getQuote: async () => {
            const quote = n === 0 ? first : second
            n += 1
            return quote
        },
    })
    try {
        await ran.result
    } finally {
        Date.now = originalNow
    }
    expect(ran.confirmQuote).toHaveBeenCalledTimes(2)
    expect(n).toBe(2)
    expect(ran.prepareCalls.mock.calls[0]?.[0].calls).toEqual([
        { target: ROUTER, value: 0n, data: multicall(USER, zeroAddress, '0x01') },
    ])
})

test('yes does not re-prompt when a later quote would change calldata', async () => {
    const first = quoteWith([{ to: ROUTER, data: multicall(USER, zeroAddress, '0x') }])
    const second = quoteWith([{ to: ROUTER, data: multicall(USER, zeroAddress, '0x01') }])
    let n = 0
    const ran = run({
        yes: true,
        getQuote: async () => {
            const quote = n === 0 ? first : second
            n += 1
            return quote
        },
    })
    await ran.result
    expect(ran.confirmQuote).toHaveBeenCalledTimes(1)
    expect(n).toBe(1)
    expect(ran.prepareCalls.mock.calls[0]?.[0].calls[0].data).toBe(multicall(USER, zeroAddress, '0x'))
})

test('refuses a simulation that drops an unspent balance', async () => {
    const quote = liveQuote()
    const request = scriptedBalances({
        before: [10_000000n, 10n ** 18n],
        after: [CAP, 10n ** 18n - 1n],
    })
    await expect(
        simulateRelayQuote({
            rpcUrl: 'http://127.0.0.1:1',
            chainId: 8453,
            user: USER,
            calls: [{ to: DEPOSITORY, data: fixture.deposit.data as Hex, value: 0n }],
            watches: [
                { kind: 'erc20', token: USDC, role: 'origin' },
                { kind: 'native', role: 'other' },
            ],
            cap: CAP,
            sameChain: false,
            request,
        }),
    ).rejects.toThrow(/would lower ETH/)

    const ran = run({
        quote,
        toToken: 'USDC',
        destinationChain: 'polygon',
        simulateQuoteCalls: (input) =>
            simulateRelayQuote({
                ...input,
                request: scriptedBalances({
                    before: [10_000000n, 10n ** 18n],
                    after: [CAP, 10n ** 18n - 1n],
                }),
            }),
    })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('would lower ETH'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses when the simulation reverts', async () => {
    await expect(
        simulateRelayQuote({
            rpcUrl: 'http://127.0.0.1:1',
            chainId: 8453,
            user: USER,
            calls: [{ to: DEPOSITORY, data: fixture.deposit.data as Hex, value: 0n }],
            watches: [{ kind: 'erc20', token: USDC, role: 'origin' }],
            cap: CAP,
            sameChain: false,
            request: scriptedBalances({
                before: [10_000000n],
                after: [CAP],
                revert: true,
            }),
        }),
    ).rejects.toThrow(/simulation reverted/)
})

test('refuses when the injected rpc cannot simulate', async () => {
    await expect(
        simulateRelayQuote({
            rpcUrl: 'http://127.0.0.1:1',
            chainId: 8453,
            user: USER,
            calls: [{ to: DEPOSITORY, data: fixture.deposit.data as Hex, value: 0n }],
            watches: [{ kind: 'erc20', token: USDC, role: 'origin' }],
            cap: CAP,
            sameChain: false,
            request: async (method) => {
                if (method === 'eth_call') return '0x989680'
                throw new Error('-32601 Method not found')
            },
        }),
    ).rejects.toThrow(/could not be simulated/)
})
