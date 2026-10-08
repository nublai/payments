import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { decodeFunctionData, encodeFunctionData, erc20Abi, zeroAddress, type Address, type Hex } from 'viem'
import { executeAccountSwap } from '../src/lib/account-swap'
import { PAID_FEE_CAP } from '../src/lib/intent-payment'
import { formatQuotedBuy, formatRelayQuoteCalls, reviewRelayQuote } from '../src/lib/relay-allowlist'
import { quoteSpendCalls } from '../src/lib/quote-spend'
import { accountAbi } from '@nubl/contracts/abis'
import { hashRelayOrder } from '../src/lib/relay-order'
import type { RelayQuoteResponse } from '../src/lib/relay-link'
import { simulateRelayQuote, type SimulateRelayQuoteInput } from '../src/lib/relay-simulate'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { relaySessionCallPermissions } from '../src/lib/swap-session'
import type { AccountSwapDeps } from '../src/lib/account-swap'
import { matchingPreparedCalls } from './helpers/matching-prepared'
import { installFormerProdDeployments } from './helpers/former-deployment-env'
import { parseAddr, parseHex, repeatedHex } from './helpers/hex'
import { testKeystoreBundle } from './helpers/keystore-bundle'
import { typedMock } from './helpers/typed-mock'
import { confirmedBundle } from './helpers/bundle-status'

let restoreFormerProdDeployments = () => {}

beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})

afterAll(() => {
    restoreFormerProdDeployments()
})

const USER = '0x1111111111111111111111111111111111111111'

const ATTACKER = '0x2222222222222222222222222222222222222222'

const SESSION_ADDRESS = '0x3333333333333333333333333333333333333333'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const ROUTER = '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f'

const APPROVAL_PROXY = '0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE'

const DEPOSITORY = '0x4cD00E387622C35bDDB9b4c962C136462338BC31'

const EXECUTION = {
    orchestrator: '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8',
    delegation: '0x3Be52867f8Dca2911f81076B37921c334dE29551',
    origin: '0x9999999999999999999999999999999999999999',
    keyHash: repeatedHex('ab', 32),
    nonce: 0n,
}

const SIGNATURE =
    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const

const CAP = 5_000000n

type RelayQuoteFixture = {
    requestId: string
    orderId: Hex
    orderData: {
        solver: string
        fees: unknown[]
        output: { payments: { recipient: string }[]; calls?: string[] }
        inputs: { refunds: { recipient: string }[] }[]
    }
    approve: { to: string; data: string; value: string }
    deposit: { to: string; data: string; value: string }
    currencyOutMinimum: string
}

// SAFETY: this file's checked-in quote fixture matches RelayQuoteFixture.
const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/relay-base-usdc-polygon-quote.json', import.meta.url), 'utf8'),
) as RelayQuoteFixture

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
    return parseHex(`0x49290c1c${word(depositor)}${id.slice(2).padStart(64, '0')}`)
}

function depositErc20(depositor: Address, token: Address, amount: bigint, id: Hex): Hex {
    const amountWord = amount.toString(16).padStart(64, '0')

    return parseHex(`0xe8017952${word(depositor)}${word(token)}${amountWord}${id.slice(2).padStart(64, '0')}`)
}

function approve(spender: Address, amount = CAP): Hex {
    return encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amount],
    })
}

function quoteWith(
    items: { to: Address; data: Hex; value?: string }[],
    extra?: Partial<RelayQuoteResponse>,
): RelayQuoteResponse {
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
                data: parseHex(fixture.approve.data),
            },
            {
                to: getAddressSafe(fixture.deposit.to),
                data: input?.depositData ?? parseHex(fixture.deposit.data),
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
    return parseAddr(value)
}

function patchedOrder(patch: (order: typeof fixture.orderData) => void) {
    const order = structuredClone(fixture.orderData)
    patch(order)

    return { order, hash: hashRelayOrder(order) }
}

function scriptedBalances(input: { before: bigint[]; after: bigint[]; revert?: boolean }) {
    let reads = 0

    type SimulateBlock = {
        blockStateCalls: { calls: Array<{ to?: string; data?: string; value?: string }> }[]
    }

    return async (method: string, params: SimulateBlock[]) => {
        if (method === 'eth_getBalance' || method === 'eth_call') {
            const wordValue = input.before[reads]

            if (wordValue === undefined) {
                throw new Error(`unexpected balance read ${reads} via ${method}`)
            }

            reads += 1

            return `0x${wordValue.toString(16)}`
        }

        if (method === 'eth_simulateV1') {
            const block = params[0]
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
    slippage?: number
    fromToken?: string
    toToken?: string
    destinationChain?: 'polygon' | 'base'
    recipient?: string
    balance?: bigint
    confirmQuote?: () => Promise<boolean>
    simulateQuoteCalls?: (value: SimulateRelayQuoteInput) => Promise<void>
    getKeys?: () => Promise<unknown>
    readAllowance?: (value: {
        token: Address
        spender: Address
    }) => Promise<bigint>
    installQuoteSpendLimit?: (value: {
        bound: { nativeLimit: bigint; usdcLimit: bigint; frozenTokens: Address[] }
    }) => Promise<() => Promise<void>>
    events?: string[]
}) {
    const signTypedData = mock(async () => {
        input.events?.push('sign')

        return SIGNATURE
    })

    const prepareCalls = mock(async (input: Parameters<typeof matchingPreparedCalls>[0]) =>
        matchingPreparedCalls(input),
    )

    const confirmQuote = input.confirmQuote ? mock(input.confirmQuote) : mock(async () => true)

    const result = executeAccountSwap(
        {
            env: 'prod',
            fromToken: input.fromToken ?? 'USDC',
            toToken: input.toToken ?? 'ETH',
            amount: input.amount ?? '5',
            slippage: input.slippage,
            sourceChain: 'base',
            destinationChain: input.destinationChain,
            recipient: input.recipient,
            password: 'pw',
            keystorePath: '/tmp/alice.json',
            yes: input.yes ?? true,
        },
        {
            readKeystoreBundle: mock(async () => testKeystoreBundle(USER, SESSION_ADDRESS, 8453, 'prod')),
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => input.balance ?? 10_000000n),
            getQuote: typedMock<AccountSwapDeps['getQuote']>(
                input.getQuote ?? (async () => input.quote),
            ),
            readNonce: mock(async () => 2n),
            confirmQuote,
            prepareCalls: typedMock<AccountSwapDeps['prepareCalls']>(prepareCalls),
            signTypedData: typedMock<AccountSwapDeps['signTypedData']>(signTypedData),
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: typedMock<AccountSwapDeps['waitForBundle']>(async () =>
                confirmedBundle(),
            ),
            pollIntentStatus: typedMock<AccountSwapDeps['pollIntentStatus']>(async () => ({
                status: 'success',
                txHashes: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
            })),
            simulateQuoteCalls: input.simulateQuoteCalls ?? (async () => {}),
            installQuoteSpendLimit:
                input.installQuoteSpendLimit ??
                (async () => {
                    input.events?.push('install')

                    return async () => {
                        input.events?.push('release')
                    }
                }),
            readAllowance: input.readAllowance ?? (async () => 0n),
            readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
            readErc721ApprovedForAll: async () => false,
            readErc721GetApproved: async () => zeroAddress,
            readErc1155ApprovedForAll: async () => false,
            readErc4626ShareBalance: async () => 0n,
            readErc4626ShareAllowance: async () => 0n,
            readApprovedSignatureCheckers: async () => [],
            getKeys: typedMock<AccountSwapDeps['getKeys']>(
                input.getKeys ??
                    (async () => ({
                        '0x2105': [
                            {
                                hash: computeSessionKeyHash(SESSION_ADDRESS),
                                expiry: '0x0',
                                type: 'secp256k1',
                                role: 'normal',
                                publicKey: '0x',
                                permissions: relaySessionCallPermissions(8453),
                            },
                        ],
                    })),
            ),
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
        reviewRelayQuote(quote, {
            sourceChainId: 8453,
            destinationChainId: 8453,
            slippageBps: 50,
            inputAmount: CAP,
            inputIsNative: false,
            originCurrency: USDC,
            user: USER,
            recipient: USER,
        }),
    ).toThrow(/inner call is transfer/)

    const ran = run({ quote })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('inner call is transfer'),
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
            { to: DEPOSITORY, data: depositNative(ATTACKER, fixture.orderId) },
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
                data: depositErc20(ATTACKER, USDC, CAP, fixture.orderId),
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
    const short = parseHex(depositErc20(USER, USDC, CAP, fixture.orderId).slice(0, 2 + 8 + 64 * 3))
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
            depositData: depositErc20(USER, USDC, CAP, parseHex(fixture.requestId)),
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
    const text = formatRelayQuoteCalls(quote)
    expect(text).toContain(`depositor ${USER}`)
    expect(text).toContain(`Output recipient: ${USER}`)
    expect(text).toContain('depositErc20 (0xe8017952)')
    expect(hashRelayOrder(fixture.orderData)).toBe(fixture.orderId)

    const ran = run({
        quote,
        toToken: 'USDC',
        destinationChain: 'polygon',
        // The fixture minimum is about 2% under the shown amount.
        slippage: 2.5,
    })

    const result = await ran.result
    expect(ran.confirmQuote).toHaveBeenCalledTimes(1)
    expect(ran.signTypedData).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('account_bridge')
})

test('confirmation text shows refundTo and the decoded inner calls', () => {
    const cleanup = '0x9bb43718'

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

    const text = formatRelayQuoteCalls(quote)
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
        // The fixture minimum is about 2% under the shown amount.
        slippage: 2.5,
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

    if (!ran.prepareCalls.mock.calls[0]?.[0].calls[0]) throw new Error('prepareCalls received no call')
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
            calls: [{ to: DEPOSITORY, data: parseHex(fixture.deposit.data), value: 0n }],
            watches: [
                { kind: 'erc20', token: USDC, role: 'origin' },
                { kind: 'native', role: 'other' },
            ],
            cap: CAP,
            sameChain: false,
            execution: EXECUTION,
            request,
        }),
    ).rejects.toThrow(/would lower ETH/)

    const ran = run({
        quote,
        toToken: 'USDC',
        destinationChain: 'polygon',
        // The fixture minimum is about 2% under the shown amount.
        slippage: 2.5,
        simulateQuoteCalls: (input) =>
            simulateRelayQuote({
                ...input,
                execution: {
                    ...input.execution,
                    origin: input.execution.origin ?? EXECUTION.origin,
                },
                request: scriptedBalances({
                    // Watches: quoted USDC, native, then WETH. The drop is WETH.
                    before: [10_000000n, 10n ** 18n, 10n ** 18n],
                    after: [CAP, 10n ** 18n, 10n ** 18n - 1n],
                }),
            }),
    })

    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('would lower 0x4200000000000000000000000000000000000006'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses when the simulation reverts', async () => {
    await expect(
        simulateRelayQuote({
            rpcUrl: 'http://127.0.0.1:1',
            chainId: 8453,
            user: USER,
            calls: [{ to: DEPOSITORY, data: parseHex(fixture.deposit.data), value: 0n }],
            watches: [{ kind: 'erc20', token: USDC, role: 'origin' }],
            cap: CAP,
            sameChain: false,
            execution: EXECUTION,
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
            calls: [{ to: DEPOSITORY, data: parseHex(fixture.deposit.data), value: 0n }],
            watches: [{ kind: 'erc20', token: USDC, role: 'origin' }],
            cap: CAP,
            sameChain: false,
            execution: EXECUTION,
            request: async (method) => {
                if (method === 'eth_call') return '0x989680'
                throw new Error('-32601 Method not found')
            },
        }),
    ).rejects.toThrow(/could not be simulated/)
})

test('refuses minimumAmount 0 even when the outer call is allowlisted', async () => {
    const quote = quoteWith([{ to: ROUTER, data: multicall(USER, zeroAddress) }], {
        details: {
            currencyIn: { amount: CAP.toString() },
            currencyOut: { amount: '2500000', amountFormatted: '2.5', minimumAmount: '0' },
        },
    })

    const ran = run({ quote })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('minimum output is 0'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses a bridge-shaped quote with no order', async () => {
    const ran = run({
        quote: quoteWith([{ to: APPROVAL_PROXY, data: transferAndMulticall({}) }]),
        toToken: 'USDC',
        destinationChain: 'polygon',
    })

    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('missing an order'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('refuses an order fee, a foreign solver, and output calls', async () => {
    const fee = patchedOrder((order) => {
        order.fees = [
            {
                recipientChainId: 'base',
                recipient: ATTACKER,
                currencyChainId: 'base',
                currency: USDC,
                amount: '5000000',
            },
        ]
    })

    const solver = patchedOrder((order) => {
        order.solver = ATTACKER
    })

    const calls = patchedOrder((order) => {
        const output: { payments: { recipient: string }[]; calls?: string[] } = order.output
        output.calls = ['0xdeadbeef']
    })

    for (const [patched, message] of [
        [fee, `fee pays ${ATTACKER}`],
        [solver, `solver ${ATTACKER}`],
        [calls, 'output calls'],
    ] as const) {
        const ran = run({
            quote: liveQuote({
                order: patched.order,
                orderId: patched.hash,
                depositData: depositErc20(USER, USDC, CAP, patched.hash),
            }),
            toToken: 'USDC',
            destinationChain: 'polygon',
            slippage: 2.5,
        })

        await expect(ran.result).rejects.toMatchObject({
            code: 'QUOTE_FAILED',
            message: expect.stringContaining(message),
        })
        expect(ran.signTypedData).not.toHaveBeenCalled()
    }
})

test('refuses a standing WETH allowance to the router', async () => {
    const weth = '0x4200000000000000000000000000000000000006'

    const ran = run({
        quote: quoteWith([{ to: ROUTER, data: multicall(USER, zeroAddress) }]),
        readAllowance: async ({ token, spender }) =>
            token.toLowerCase() === weth && spender.toLowerCase() === ROUTER.toLowerCase() ? 1n : 0n,
    })

    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('standing allowance'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('installs the quoted spend limit before signing and simulates twice', async () => {
    const events: string[] = []
    let simulations = 0

    const ran = run({
        quote: quoteWith([{ to: ROUTER, data: multicall(USER, zeroAddress) }]),
        events,
        simulateQuoteCalls: async () => {
            simulations += 1
        },
        installQuoteSpendLimit: async (value) => {
            events.push('install')
            expect(value.bound.usdcLimit).toBe(CAP + PAID_FEE_CAP)
            expect(value.bound.nativeLimit).toBe(0n)
            expect(value.bound.usdcLimit).not.toBe(2n ** 256n - 1n)
            expect(value.bound.nativeLimit).not.toBe(2n ** 256n - 1n)

            return async () => {
                events.push('release')
            }
        },
    })

    await ran.result
    expect(simulations).toBe(2)
    expect(events).toEqual(['install', 'sign', 'release'])
})

test('quote spend calldata is a minute limit equal to the input, never uint256 max', () => {
    const weth = '0x4200000000000000000000000000000000000006'

    const calls = quoteSpendCalls(
        {
            keyHash: EXECUTION.keyHash,
            account: USER,
            nativeLimit: 10n ** 15n,
            usdc: USDC,
            usdcLimit: 0n,
            frozenTokens: [weth],
        },
        'set',
    )

    const decoded = calls.map((call) => decodeFunctionData({ abi: accountAbi, data: call.data }))
    expect(calls.every((call) => call.target === USER)).toBe(true)
    expect(decoded.every((row) => row.functionName === 'setSpendLimit')).toBe(true)
    expect(decoded[0]?.args?.[2]).toBe(0)
    expect(decoded[0]?.args?.[3]).toBe(10n ** 15n)
    expect(decoded[1]?.args?.[3]).toBe(0n)
    expect(decoded[2]?.args?.[3]).toBe(0n)
    expect(decoded[2]?.args?.[1]).toBe(weth)

    for (const call of calls) {
        expect(call.data.toLowerCase().includes('f'.repeat(64))).toBe(false)
    }

    expect(formatQuotedBuy({ amountFormatted: '2.5', amount: '2500000', minimumAmount: '0' })).toBe(
        'minimum unavailable',
    )
    expect(
        formatQuotedBuy({
            amountFormatted: '2.5',
            amount: '2500000',
            minimumAmount: '2487500',
            currency: { decimals: 6 },
        }),
    ).toBe('minimum 2.4875')
})
