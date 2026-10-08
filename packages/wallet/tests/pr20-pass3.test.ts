import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    decodeFunctionData,
    encodeFunctionData,
    keccak256,
    toHex,
    zeroAddress,
    type Address,
    type Hex,
} from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import { executeAccountSwap, executeSignedCalls } from './helpers/stub-execute'
import { readKeystoreBundle } from '../src/lib/keystore'
import { simulateRelayQuote } from '../src/lib/relay-simulate'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { relaySessionCallPermissions } from '../src/lib/swap-session'
import { matchingPreparedCalls } from './helpers/matching-prepared'
import { installFormerProdDeployments } from './helpers/former-deployment-env'
import { repeatedHex } from './helpers/hex'

let restoreFormerProdDeployments = () => {}

beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})

afterAll(() => {
    restoreFormerProdDeployments()
})

const USER = '0x1111111111111111111111111111111111111111'

const SESSION_ADDRESS = '0x3333333333333333333333333333333333333333'

const SESSION_KEY_HASH = computeSessionKeyHash(SESSION_ADDRESS)

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const WETH = '0x4200000000000000000000000000000000000006'

const ATTACKER = '0x2222222222222222222222222222222222222222'

const APPROVAL_PROXY = '0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE'

const ANY_TARGET = '0x3232323232323232323232323232323232323232'

const ANY_FN = '0x32323232'

const KEY_HASH = repeatedHex('ab', 32)

const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'))

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

const EMPTY_MULTICALL = encodeFunctionData({
    abi: multicallAbi,
    functionName: 'multicall',
    args: [[], USER, zeroAddress, '0x'],
})

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function narrowKeys(role: 'normal' | 'admin' = 'normal', wildcard = false) {
    return {
        '0x2105': [
            {
                hash: SESSION_KEY_HASH,
                expiry: '0x0',
                type: 'secp256k1' as const,
                role,
                publicKey: '0x' as const,
                permissions: wildcard
                    ? [{ type: 'call' as const, to: ANY_TARGET, selector: ANY_FN }]
                    : relaySessionCallPermissions(8453),
            },
        ],
    }
}

function quoteFor(data: Hex, to: Address = '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f') {
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
                        data: { to, data, value: '0', chainId: 8453 },
                    },
                ],
            },
        ],
        details: {
            currencyIn: { amount: '5000000' },
            currencyOut: { amount: '1000', minimumAmount: '1000' },
        },
    }
}

function bundle() {
    return {
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
    }
}

function run(input: {
    keystorePath?: string
    quote?: ReturnType<typeof quoteFor>
    keys?: ReturnType<typeof narrowKeys>
    installQuoteSpendLimit?: () => Promise<() => Promise<void>>
    executeSignedCalls?: () => Promise<unknown>
}) {
    const signTypedData = mock(async () => '0x11')

    const result = executeAccountSwap(
        {
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '5',
            sourceChain: 'base',
            password: 'pw',
            keystorePath: input.keystorePath ?? '/tmp/alice.json',
            yes: true,
        },
        {
            readKeystoreBundle: mock(async () => bundle()),
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => 10_000000n),
            getQuote: mock(async () => input.quote ?? quoteFor(EMPTY_MULTICALL)),
            readNonce: mock(async () => 2n),
            confirmQuote: mock(async () => true),
            getKeys: mock(async () => input.keys ?? narrowKeys()),
            prepareCalls: mock(async (call: Parameters<typeof matchingPreparedCalls>[0]) =>
                matchingPreparedCalls(call),
            ),
            signTypedData: signTypedData,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            simulateQuoteCalls: async () => {},
            installQuoteSpendLimit: input.installQuoteSpendLimit ?? (async () => async () => {}),
            readAllowance: async () => 0n,
            readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
            readErc721ApprovedForAll: async () => false,
            readErc721GetApproved: async () => zeroAddress,
            readErc1155ApprovedForAll: async () => false,
            readErc4626ShareBalance: async () => 0n,
            readErc4626ShareAllowance: async () => 0n,
            readApprovedSignatureCheckers: async () => [],
            executeSignedCalls: (input.executeSignedCalls ??
                (async () => ({
                    id: 'bundle-1',
                    finalStatus: {
                        success: true,
                        id: 'bundle-1',
                        status: 'confirmed',
                        statusCode: 200,
                        receipt: {
                            transactionHash:
                                '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        },
                    },
                    feeCap: { token: zeroAddress, amount: 0n },
                }))),
            waitForBundle: mock(async () => ({
                success: true,
                id: 'bundle-1',
                status: 'confirmed',
                statusCode: 200,
            })),
        },
    )

    return { result, signTypedData }
}

test('a throw after the spend limit is installed still releases it', async () => {
    const events: string[] = []

    const ran = run({
        installQuoteSpendLimit: async () => {
            events.push('install')

            return async () => {
                events.push('release')
            }
        },
        executeSignedCalls: async () => {
            events.push('execute')
            throw new Error('send failed')
        },
    })

    await expect(ran.result).rejects.toThrow(/send failed/)
    expect(events).toEqual(['install', 'execute', 'release'])
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('success false still releases the spend limit', async () => {
    const events: string[] = []

    const ran = run({
        installQuoteSpendLimit: async () => {
            events.push('install')

            return async () => {
                events.push('release')
            }
        },
        executeSignedCalls: async () => ({
            id: 'bundle-1',
            finalStatus: { success: false, id: 'bundle-1', status: 'failed', error: 'reverted' },
            feeCap: { token: zeroAddress, amount: 0n },
        }),
    })

    await expect(ran.result).rejects.toThrow(/reverted/)
    expect(events).toEqual(['install', 'release'])
})

test('concurrent swaps serialize spend-limit installs for one account', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quote-lock-'))
    const keystorePath = join(dir, 'alice.json')
    await writeFile(keystorePath, '{}')
    let openGate: () => void = () => {}

    const gate = new Promise<void>((resolve) => {
        openGate = resolve
    })

    let active = 0
    let maxActive = 0
    const order: string[] = []

    const installQuoteSpendLimit = async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        order.push('install')

        if (order.length === 1) await gate
        active -= 1

        return async () => {
            order.push('release')
        }
    }

    const first = run({ keystorePath, installQuoteSpendLimit }).result

    for (let attempt = 0; attempt < 50 && order.length === 0; attempt += 1) {
        await sleep(10)
    }

    const second = run({ keystorePath, installQuoteSpendLimit }).result
    await sleep(150)
    expect(order).toEqual(['install'])
    openGate()
    await Promise.all([first, second])
    expect(maxActive).toBe(1)
    expect(order).toEqual(['install', 'release', 'install', 'release'])
})

test('a pre-existing minute period is restored instead of deleted', async () => {
    const { quoteSpendRestoreCalls } = await import('../src/lib/quote-spend')
    expect(typeof quoteSpendRestoreCalls).toBe('function')

    const calls = quoteSpendRestoreCalls({
        keyHash: KEY_HASH,
        account: USER,
        slots: [
            { token: USDC, previousLimit: 100n },
            { token: zeroAddress, previousLimit: null },
        ],
    })

    const decoded = calls.map((call) => decodeFunctionData({ abi: accountAbi, data: call.data }))
    expect(decoded[0]?.functionName).toBe('setSpendLimit')
    expect(decoded[0]?.args?.[3]).toBe(100n)
    expect(decoded[1]?.functionName).toBe('removeSpendLimit')
})

test('a held token with no period is frozen at 0 for the quote', async () => {
    const { planQuoteSpendSlots } = await import('../src/lib/quote-spend')
    expect(typeof planQuoteSpendSlots).toBe('function')

    const slots = planQuoteSpendSlots({
        bound: {
            keyHash: KEY_HASH,
            account: USER,
            nativeLimit: 0n,
            usdc: USDC,
            usdcLimit: 5n,
            frozenTokens: [],
        },
        spendInfos: [{ token: USDC, period: 0, limit: 100n }],
        balances: [{ token: WETH, balance: 7n }],
    })

    const usdc = slots.find((slot) => slot.token.toLowerCase() === USDC.toLowerCase())
    const weth = slots.find((slot) => slot.token.toLowerCase() === WETH.toLowerCase())
    expect(usdc?.installedLimit).toBe(5n)
    expect(usdc?.previousLimit).toBe(100n)
    expect(weth?.installedLimit).toBe(0n)
    expect(weth?.previousLimit).toBeNull()
})

test('the next keystore read cleans up a pending quote limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quote-pending-'))
    const keystorePath = join(dir, 'alice.json')
    await writeFile(keystorePath, '{}')
    await writeFile(
        `${keystorePath}.pending-quote-limit.json`,
        `${JSON.stringify({
            version: 2,
            account: USER,
            keyHash: KEY_HASH,
            chainId: 8453,
            env: 'prod',
            rpcUrl: 'http://127.0.0.1:9',
            relayerUrl: 'http://127.0.0.1:9',
            slots: [{ token: USDC, previousLimit: '100', installedLimit: '5' }],
        })}\n`,
    )
    await expect(readKeystoreBundle(keystorePath)).rejects.toThrow(/pending quote spend limit/i)
})

test('recovering a pending limit puts the previous minute limit back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quote-recover-'))
    const keystorePath = join(dir, 'alice.json')
    await writeFile(keystorePath, '{}')

    const { writePendingQuoteLimit, pendingQuoteLimitPath } = await import(
        '../src/lib/quote-spend-pending'
    )

    const { recoverPendingQuoteSpend } = await import('../src/lib/quote-spend-lifecycle')
    expect(typeof recoverPendingQuoteSpend).toBe('function')
    await writePendingQuoteLimit(keystorePath, {
        version: 1,
        account: USER,
        keyHash: KEY_HASH,
        chainId: 8453,
        env: 'prod',
        rpcUrl: 'http://127.0.0.1:9',
        relayerUrl: 'http://127.0.0.1:9',
        slots: [
            { token: USDC, previousLimit: '100', installedLimit: '5' },
            { token: zeroAddress, previousLimit: null, installedLimit: '0' },
        ],
    })
    const submitted: Hex[] = []
    await recoverPendingQuoteSpend(keystorePath, {
        readMinuteLimits: async () =>
            new Map<string, bigint | null>([
                [USDC.toLowerCase(), 5n],
                [zeroAddress.toLowerCase(), 0n],
            ]),
        submit: async (_record, calls) => {
            submitted.push(...calls.map((call) => call.data))
        },
    })
    const decoded = submitted.map((data) => decodeFunctionData({ abi: accountAbi, data }))
    expect(decoded[0]?.functionName).toBe('setSpendLimit')
    expect(decoded[0]?.args?.[3]).toBe(100n)
    expect(decoded[1]?.functionName).toBe('removeSpendLimit')
    await expect(readFile(pendingQuoteLimitPath(keystorePath), 'utf8')).rejects.toThrow()
})

test('executeAccountSwap refuses a wildcard session', async () => {
    const ran = run({ keys: narrowKeys('normal', true) })
    await expect(ran.result).rejects.toThrow(/wildcard/)
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('executeAccountSwap refuses a super-admin session', async () => {
    const ran = run({ keys: narrowKeys('admin') })
    await expect(ran.result).rejects.toThrow(/super-admin/)
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('an inner selector outside the relay entrypoints is refused', async () => {
    const data = encodeFunctionData({
        abi: transferAndMulticallAbi,
        functionName: 'transferAndMulticall',
        args: [
            [USDC],
            [5_000000n],
            [{ target: ATTACKER, allowFailure: false, value: 0n, callData: '0x12345678' }],
            USER,
            zeroAddress,
            '0x',
        ],
    })

    const ran = run({ quote: quoteFor(data, APPROVAL_PROXY) })
    await expect(ran.result).rejects.toThrow(/0x12345678/)
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('simulation refuses when output logs do not match the balance diff', async () => {
    const output = USDC
    const origin = WETH
    const pad = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`
    const userTopic = `0x${USER.slice(2).toLowerCase().padStart(64, '0')}`

    type SimulateBlock = {
        blockStateCalls: { calls: Array<{ to?: string; data?: string; value?: string }> }[]
    }

    const request = async (method: string, params: unknown[]) => {
        if (method === 'eth_getBalance' || method === 'eth_call') return pad(100n)

        if (method === 'eth_simulateV1') {
            const block = params[0]
            // SAFETY: this stub only reads blockStateCalls from eth_simulateV1 params it invented.
            const calls = (block as SimulateBlock | undefined)?.blockStateCalls[0]?.calls ?? []

            return [
                {
                    calls: calls.map((_, index) => ({
                        status: '0x1',
                        returnData: index === 0 ? '0x' : pad(index === 1 ? 100n : 100n + 10n ** 18n),
                        logs:
                            index === 0
                                ? [
                                      {
                                          address: output,
                                          topics: [TRANSFER_TOPIC, userTopic, userTopic],
                                          data: pad(1n),
                                      },
                                  ]
                                : [],
                    })),
                },
            ]
        }

        throw new Error(method)
    }

    await expect(
        simulateRelayQuote({
            rpcUrl: 'http://127.0.0.1:1',
            chainId: 8453,
            user: USER,
            calls: [{ to: origin, data: '0x12345678', value: 0n }],
            watches: [
                { kind: 'erc20', token: origin, role: 'origin' },
                { kind: 'erc20', token: output, role: 'output' },
            ],
            cap: 5n,
            sameChain: true,
            minimumOutput: 1n,
            execution: {
                orchestrator: '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8',
                delegation: '0x3Be52867f8Dca2911f81076B37921c334dE29551',
                origin: '0x277b7440CE050d9e9e428d1f349E51D468c7eB7E',
                keyHash: KEY_HASH,
                nonce: 0n,
            },
            request,
        }),
    ).rejects.toThrow(/logs and balance differ/)
})

test('the second simulation runs on the calls about to be signed, after prepare and before signTypedData', async () => {
    const order: string[] = []
    let simulated: Hex | undefined

    const signature =
        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const

    await executeAccountSwap(
        {
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '5',
            sourceChain: 'base',
            password: 'pw',
            keystorePath: '/tmp/alice-pass3-before-sign.json',
            yes: true,
        },
        {
            readKeystoreBundle: mock(async () => bundle()),
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => 10_000000n),
            getQuote: mock(async () => quoteFor(EMPTY_MULTICALL)),
            readNonce: mock(async () => 2n),
            confirmQuote: mock(async () => true),
            getKeys: mock(async () => narrowKeys()),
            prepareCalls: mock(async (call: Parameters<typeof matchingPreparedCalls>[0]) => {
                order.push('prepare')

                return matchingPreparedCalls(call)
            }),
            signTypedData: mock(async () => {
                order.push('sign')

                return signature
            }),
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            simulateQuoteCalls: async (input: { calls: Array<{ data?: Hex }> }) => {
                order.push('sim')
                simulated = input.calls[0]?.data
            },
            installQuoteSpendLimit: async () => async () => {},
            readAllowance: async () => 0n,
            readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
            readErc721ApprovedForAll: async () => false,
            readErc721GetApproved: async () => zeroAddress,
            readErc1155ApprovedForAll: async () => false,
            readErc4626ShareBalance: async () => 0n,
            readErc4626ShareAllowance: async () => 0n,
            readApprovedSignatureCheckers: async () => [],
            waitForBundle: mock(async () => ({
                success: true,
                id: 'bundle-1',
                status: 'confirmed',
                statusCode: 200,
                receipt: {
                    transactionHash:
                        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                },
            })),
        },
    )
    expect(simulated).toBe(EMPTY_MULTICALL)
    expect(order.at(-1)).toBe('sign')
    expect(order.at(-2)).toBe('sim')
    expect(order.includes('prepare')).toBe(true)
    expect(order.lastIndexOf('prepare')).toBeLessThan(order.lastIndexOf('sim'))
    expect(executeSignedCalls).toBeTypeOf('function')
})
