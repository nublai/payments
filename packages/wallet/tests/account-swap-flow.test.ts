import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { installFormerProdDeployments } from './helpers/former-deployment-env'

let restoreFormerProdDeployments = () => {}
beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})
afterAll(() => {
    restoreFormerProdDeployments()
})
import { JsonRpcClientError, type GetKeysResponse } from '@nubl/relayer-client'
import { encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem'
import { hashRelayOrder } from '../src/lib/relay-order'
import {
    executeAccountSwap as executeAccountSwapImpl,
    resolveAccountSwapPassword,
} from '../src/lib/account-swap'

const USER = '0x1111111111111111111111111111111111111111' as Address
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
    args: [[], USER, zeroAddress, '0x'],
})

function executeAccountSwap(
    options: Parameters<typeof executeAccountSwapImpl>[0],
    deps?: Parameters<typeof executeAccountSwapImpl>[1],
) {
    return executeAccountSwapImpl(options, {
        simulateQuoteCalls: async () => {},
        installQuoteSpendLimit: async () => async () => {},
        readAllowance: async () => 0n,
        readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
        readErc721ApprovedForAll: async () => false,
        readErc721GetApproved: async () => zeroAddress,
        readErc1155ApprovedForAll: async () => false,
        readErc4626ShareBalance: async () => 0n,
        readErc4626ShareAllowance: async () => 0n,
        readApprovedSignatureCheckers: async () => [],
        getKeys: async () => {
            const key = {
                hash: computeSessionKeyHash(
                    '0x3333333333333333333333333333333333333333' as Address,
                ),
                expiry: '0x0',
                type: 'secp256k1' as const,
                role: 'normal' as const,
                publicKey: '0x' as const,
                permissions: relaySessionCallPermissions(8453),
            }
            return { '0x2105': [key], '0x89': [key], '0x7a69': [key] }
        },
        // Confirmation now simulates, which needs a nonce before the user answers.
        readNonce: async () => 2n,
        ...deps,
    })
}
import { LoginProfileError } from '../src/lib/keystore'
import { PromptCancelledError } from '../src/lib/password-readline'
import { RelayLinkError } from '../src/lib/relay-link'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { relaySessionCallPermissions } from '../src/lib/swap-session'
import { matchingPreparedCalls } from './helpers/matching-prepared'

const SESSION_ADDRESS = '0x3333333333333333333333333333333333333333'
const SESSION_KEY_HASH = computeSessionKeyHash(SESSION_ADDRESS)

function makeKeystoreBundle() {
    return {
        format: 'split',
        rootPath: '/tmp/alice.json',
        sessionPath: '/tmp/sessions/default.json',
        root: {
            addresses: {
                root: '0x1111111111111111111111111111111111111111',
                delegated: '0x1111111111111111111111111111111111111111',
            },
            sessionRef: {
                dir: '/tmp/sessions',
            },
        },
        session: {
            network: {
                env: 'prod' as const,
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
            addresses: {
                delegated: '0x1111111111111111111111111111111111111111',
                session: SESSION_ADDRESS,
            },
        },
    }
}

function makeSessionKeystore(overrides?: Record<string, unknown>) {
    return {
        network: {
            env: 'prod' as const,
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'https://mainnet.base.org',
            chainId: 8453,
        },
        addresses: {
            delegated: '0x1111111111111111111111111111111111111111',
            session: SESSION_ADDRESS,
        },
        ...overrides,
    }
}

function makeQuote(overrides?: Record<string, unknown>) {
    return {
        requestId: 'relay-request-1',
        steps: [
            {
                id: 'swap',
                kind: 'transaction',
                requestId: 'relay-request-1',
                items: [
                    {
                        status: 'incomplete',
                        data: {
                            to: '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f',
                            data: EMPTY_ROUTER_CALL,
                            value: '0',
                            chainId: 8453,
                        },
                    },
                ],
            },
        ],
        details: {
            currencyOut: {
                amount: '28500000000000000',
                amountFormatted: '0.0285',
                minimumAmount: '28500000000000000',
                amountUsd: '100.10',
            },
            rate: '3508.77',
            timeEstimate: 2,
        },
        fees: {
            gas: { amountUsd: '0.10' },
            relayer: { amountUsd: '0.07' },
        },
        ...overrides,
    }
}

const bridgeOrderTemplate = JSON.parse(
    readFileSync(new URL('./fixtures/relay-base-usdc-polygon-quote.json', import.meta.url), 'utf8'),
).orderData as {
    output: { payments: { recipient: string }[] }
    inputs: { refunds: { recipient: string }[] }[]
    solver: string
    fees: unknown[]
}

function depositNative(depositor: Address, id: Hex): Hex {
    const padded = depositor.toLowerCase().slice(2).padStart(64, '0')
    return `0x49290c1c${padded}${id.slice(2).padStart(64, '0')}` as Hex
}

/** Signable ETH bridge: depositNative plus an order whose output pays `recipient`. */
function makeEthBridgeQuote(input?: { recipient?: Address; omitRequestId?: boolean }) {
    const recipient = input?.recipient ?? USER
    const order = structuredClone(bridgeOrderTemplate)
    order.output.payments[0]!.recipient = recipient
    const orderId = hashRelayOrder(order)
    const value = 10n ** 17n
    const requestId = input?.omitRequestId ? undefined : 'relay-request-1'
    return {
        requestId,
        steps: [
            {
                id: 'bridge',
                kind: 'transaction',
                requestId,
                items: [
                    {
                        status: 'incomplete' as const,
                        data: {
                            to: '0x4cD00E387622C35bDDB9b4c962C136462338BC31',
                            data: depositNative(USER, orderId),
                            value: value.toString(),
                            chainId: 8453,
                        },
                    },
                ],
            },
        ],
        details: {
            currencyIn: { amount: value.toString(), amountFormatted: '0.1' },
            currencyOut: {
                amount: value.toString(),
                minimumAmount: value.toString(),
                amountFormatted: '0.1',
                amountUsd: '100',
            },
            rate: '1',
            timeEstimate: 9,
        },
        protocol: { v2: { orderId, orderData: order } },
        fees: {
            gas: { amountUsd: '0.10' },
            relayer: { amountUsd: '0.07' },
        },
    }
}

function makePreparedCalls(input: Parameters<typeof matchingPreparedCalls>[0]) {
    return matchingPreparedCalls(input)
}

function makeFinalStatus(overrides?: Record<string, unknown>) {
    return {
        success: true,
        id: 'bundle-1',
        status: 'confirmed',
        statusCode: 200,
        receipt: {
            transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            blockNumber: '1',
            gasUsed: '1',
            status: 'success',
        },
        ...overrides,
    }
}

function makeKeys(input?: {
    nativeSpendLimit?: `0x${string}`
    nativeSpent?: `0x${string}`
}): GetKeysResponse {
    return {
        '0x2105': [
            {
                hash: SESSION_KEY_HASH,
                expiry: '0x0',
                type: 'secp256k1',
                role: 'normal',
                publicKey: '0x',
                permissions: input?.nativeSpendLimit
                    ? [
                          ...relaySessionCallPermissions(8453),
                          {
                              type: 'spend' as const,
                              token: zeroAddress,
                              limit: input.nativeSpendLimit,
                              spent: input.nativeSpent ?? '0x0',
                              period: 'forever' as const,
                          },
                      ]
                    : [],
            },
        ],
    }
}

test('resolveAccountSwapPassword prefers env password', async () => {
    const password = await resolveAccountSwapPassword(
        { env: 'prod', passwordStdin: true },
        {
            envPassword: 'from-env',
            readPasswordFromStdin: () => 'from-stdin',
            promptForExistingPassword: async () => 'from-prompt',
            isInteractive: true,
        },
    )

    expect(password).toBe('from-env')
})

test('resolveAccountSwapPassword reports the supported non-interactive password sources', async () => {
    await expect(
        resolveAccountSwapPassword(
            { env: 'prod', passwordStdin: false },
            {
                envPassword: undefined,
                readPasswordFromStdin: () => 'from-stdin',
                promptForExistingPassword: async () => 'from-prompt',
                isInteractive: false,
            },
        ),
    ).rejects.toMatchObject({
        code: 'PASSWORD_REQUIRED',
        message: 'Password required. Use --password-stdin, TW_PASSWORD, or run in interactive TTY.',
    })
})

test('resolveAccountSwapPassword reads from stdin when requested', async () => {
    const password = await resolveAccountSwapPassword(
        { env: 'prod', passwordStdin: true },
        {
            envPassword: undefined,
            readPasswordFromStdin: () => 'from-stdin',
            promptForExistingPassword: async () => 'from-prompt',
            isInteractive: false,
        },
    )

    expect(password).toBe('from-stdin')
})

test('resolveAccountSwapPassword uses interactive prompt when stdin is not requested', async () => {
    const password = await resolveAccountSwapPassword(
        { env: 'prod', passwordStdin: false },
        {
            envPassword: undefined,
            readPasswordFromStdin: () => 'from-stdin',
            promptForExistingPassword: async () => 'from-prompt',
            isInteractive: true,
        },
    )

    expect(password).toBe('from-prompt')
})

test('executeAccountSwap completes a same-chain USDC to ETH swap', async () => {
    const confirmQuote = mock(async () => true)
    const auditQuote = mock((_quote) => {})
    const prepareCalls = mock(async (input) => makePreparedCalls(input)) as unknown as any
    const sendPreparedCalls = mock(async () => ({ id: 'bundle-1' }))

    const result = await executeAccountSwap(
        {
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '100',
            sourceChain: 'base',
            password: 'pw',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => 200_000000n),
            getQuote: mock(async () => makeQuote()) as unknown as any,
            readNonce: mock(async () => 2n),
            confirmQuote,
            auditQuote,
            prepareCalls,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls,
            waitForBundle: mock(async () => makeFinalStatus()) as unknown as any,
        },
    )

    expect(result.type).toBe('account_swap')
    expect(result.fromToken.symbol).toBe('USDC')
    expect(result.toToken.symbol).toBe('ETH')
    expect(result.bundle.id).toBe('bundle-1')
    expect(result.txHash).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(confirmQuote).toHaveBeenCalledTimes(1)
    expect(auditQuote).toHaveBeenCalledTimes(1)
    const prepareInput = (prepareCalls as any).mock.calls[0]?.[0]
    expect(prepareInput.calls).toEqual([
        {
            target: '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f',
            value: 0n,
            data: EMPTY_ROUTER_CALL,
        },
    ])
    const sentSignature = (sendPreparedCalls as any).mock.calls[0]?.[0]?.signature as string
    expect(sentSignature.startsWith('0x11111111111111111111111111111111')).toBe(true)
})

test('executeAccountSwap accepts successful bundles without a statusCode', async () => {
    const result = await executeAccountSwap(
        {
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '100',
            sourceChain: 'base',
            password: 'pw',
            keystorePath: '/tmp/alice.json',
            yes: true,
        },
        {
            readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => 200_000000n),
            getQuote: mock(async () => makeQuote()) as unknown as any,
            readNonce: mock(async () => 2n),
            prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () =>
                makeFinalStatus({ statusCode: undefined }),
            ) as unknown as any,
        },
    )

    expect(result.bundle.id).toBe('bundle-1')
    expect(result.bundle.status).toBe('confirmed')
    expect(result.bundle.statusCode).toBeUndefined()
    expect(result.txHash).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
})

test('executeAccountSwap completes a bridge and polls for destination fill', async () => {
    const pollIntentStatus = mock(async () => ({
        status: 'success',
        txHashes: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    }))
    const recipient = '0x2222222222222222222222222222222222222222' as Address
    const getQuote = mock(async () => makeEthBridgeQuote({ recipient })) as unknown as any

    const result = await executeAccountSwap(
        {
            env: 'prod',
            fromToken: 'ETH',
            toToken: 'ETH',
            amount: '0.1',
            sourceChain: 'base',
            destinationChain: 'polygon',
            recipient,
            password: 'pw',
            keystorePath: '/tmp/alice.json',
            yes: true,
        },
        {
            readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => 1_000000000000000000n),
            getKeys: mock(async () => makeKeys({ nativeSpendLimit: '0x16345785d8a0000' })),
            getQuote,
            readNonce: mock(async () => 2n),
            prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () => makeFinalStatus()) as unknown as any,
            pollIntentStatus: pollIntentStatus as unknown as any,
        },
    )

    expect(result.type).toBe('account_bridge')
    expect(result.relayRequestId).toBe('relay-request-1')
    expect(result.destinationTxHash).toBe(
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    )
    expect(result.recipient).toBe(recipient)
    expect(pollIntentStatus).toHaveBeenCalledTimes(1)
    expect((getQuote as any).mock.calls[0]?.[0]?.recipient).toBe(recipient)
})

test('executeAccountSwap does not treat source intent hashes as destination tx hashes', async () => {
    const pollIntentStatus = mock(async () => ({
        status: 'success',
        inTxHashes: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    }))

    const result = await executeAccountSwap(
        {
            operation: 'bridge',
            env: 'prod',
            fromToken: 'ETH',
            toToken: 'ETH',
            amount: '0.1',
            sourceChain: 'base',
            destinationChain: 'polygon',
            password: 'pw',
            keystorePath: '/tmp/alice.json',
            yes: true,
        },
        {
            readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => 1_000000000000000000n),
            getKeys: mock(async () => makeKeys({ nativeSpendLimit: '0x16345785d8a0000' })),
            getQuote: mock(async () => makeEthBridgeQuote()) as unknown as any,
            readNonce: mock(async () => 2n),
            prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () => makeFinalStatus()) as unknown as any,
            pollIntentStatus: pollIntentStatus as unknown as any,
        },
    )

    expect(result.txHash).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(result.destinationTxHash).toBeUndefined()
    expect(pollIntentStatus).toHaveBeenCalledTimes(1)
})

test('executeAccountSwap rejects same-token same-chain swaps', async () => {
    await expect(
        executeAccountSwap({
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'USDC',
            amount: '1',
            sourceChain: 'base',
            password: 'pw',
        }),
    ).rejects.toMatchObject({
        code: 'INVALID_TOKEN_PAIR',
    })
})

test('executeAccountSwap rejects when both sessionFile and sessionName are set', async () => {
    await expect(
        executeAccountSwap({
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '1',
            sourceChain: 'base',
            password: 'pw',
            sessionFile: '/tmp/session.json',
            sessionName: 'default',
            yes: true,
        }),
    ).rejects.toMatchObject({
        code: 'UNKNOWN',
        message: '--session and --session-file are mutually exclusive.',
    })
})

test('executeAccountSwap uses the provided session file when it matches the requested network', async () => {
    const readSessionKeystoreFile = mock(async () => makeSessionKeystore()) as unknown as any

    const result = await executeAccountSwap(
        {
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '1',
            sourceChain: 'base',
            password: 'pw',
            sessionFile: '/tmp/session.json',
            yes: true,
        },
        {
            readSessionKeystoreFile,
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => 2_000000n),
            getQuote: mock(async () => makeQuote()) as unknown as any,
            readNonce: mock(async () => 2n),
            prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () => makeFinalStatus()) as unknown as any,
        },
    )

    expect(result.keystorePath).toBe('/tmp/session.json')
    expect(readSessionKeystoreFile).toHaveBeenCalledWith('/tmp/session.json')
})

test('executeAccountSwap rejects unsupported raw token input at the library boundary', async () => {
    await expect(
        executeAccountSwap({
            env: 'prod',
            fromToken: 'DOGE',
            toToken: 'ETH',
            amount: '1',
            sourceChain: 'base',
            password: 'pw',
        }),
    ).rejects.toMatchObject({
        code: 'UNSUPPORTED_TOKEN',
        message: 'Unsupported token: DOGE',
    })
})

test('executeAccountSwap rejects ETH swaps when native spend permission is missing', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'ETH',
                toToken: 'USDC',
                amount: '0.1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 1_000000000000000000n),
                getKeys: mock(async () => makeKeys()),
            },
        ),
    ).rejects.toMatchObject({
        code: 'MISSING_NATIVE_SPEND_PERMISSION',
        message: expect.stringContaining('missing native ETH spend permission'),
    })
})

test('executeAccountSwap rejects same-chain bridges with typed error', async () => {
    await expect(
        executeAccountSwap({
            operation: 'bridge',
            env: 'prod',
            fromToken: 'ETH',
            toToken: 'ETH',
            amount: '1',
            sourceChain: 'base',
            destinationChain: 'base',
            password: 'pw',
        }),
    ).rejects.toMatchObject({
        code: 'SAME_CHAIN',
    })
})

test('executeAccountSwap rejects bridge when quote has no requestId before executing', async () => {
    const waitForBundle = mock(async () => makeFinalStatus()) as unknown as any
    const quoteWithoutRequestId = makeEthBridgeQuote({ omitRequestId: true })

    await expect(
        executeAccountSwap(
            {
                operation: 'bridge',
                env: 'prod',
                fromToken: 'ETH',
                toToken: 'ETH',
                amount: '0.1',
                sourceChain: 'base',
                destinationChain: 'polygon',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 1_000000000000000000n),
                getKeys: mock(async () => makeKeys({ nativeSpendLimit: '0x16345785d8a0000' })),
                getQuote: mock(async () => quoteWithoutRequestId) as unknown as any,
                readNonce: mock(async () => 2n),
                prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
                signTypedData: mock(
                    async () =>
                        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
                ) as unknown as any,
                sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
                waitForBundle,
            },
        ),
    ).rejects.toMatchObject({
        code: 'BRIDGE_QUOTE_INVALID',
        message: expect.stringContaining('requestId'),
    })

    expect(waitForBundle).not.toHaveBeenCalled()
})

test('executeAccountSwap rejects invalid raw recipient input at the library boundary', async () => {
    await expect(
        executeAccountSwap({
            operation: 'bridge',
            env: 'prod',
            fromToken: 'ETH',
            toToken: 'ETH',
            amount: '1',
            sourceChain: 'base',
            destinationChain: 'polygon',
            recipient: 'not-an-address',
            password: 'pw',
        }),
    ).rejects.toMatchObject({
        code: 'UNKNOWN',
        message: 'Recipient must be a valid address, got not-an-address.',
    })
})

test('executeAccountSwap surfaces relay quote failures', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () => {
                    throw new RelayLinkError('API_ERROR', 'solver unavailable', {
                        statusCode: 503,
                    })
                }) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: 'Failed to get swap quote: solver unavailable',
    })
})

test('executeAccountSwap rejects relay quotes with no executable steps', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () => makeQuote({ steps: [] })) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: 'relay.link returned no executable steps.',
    })
})

test('executeAccountSwap rejects relay quotes with signature steps', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () =>
                    makeQuote({
                        steps: [
                            {
                                id: 'sig',
                                kind: 'signature',
                                items: [],
                            },
                        ],
                    }),
                ) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('signature steps'),
    })
})

test('executeAccountSwap does not misclassify unrelated amount strings as INVALID_AMOUNT', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () => {
                    throw new Error('Token Amount exceeds protocol maximum')
                }) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'UNKNOWN',
        message: 'Token Amount exceeds protocol maximum',
    })
})

test('executeAccountSwap maps missing keystore files to KEYSTORE_NOT_FOUND', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/missing.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => {
                    throw new Error('ENOENT: no such file or directory, open /tmp/missing.json')
                }) as unknown as any,
                readSessionKeystoreFile: mock(async () => {
                    throw new Error('ENOENT: no such file or directory, open /tmp/session.json')
                }) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'KEYSTORE_NOT_FOUND',
        message: 'Keystore not found at /tmp/missing.json',
    })
})

test('executeAccountSwap rejects zero amounts with INVALID_AMOUNT', async () => {
    await expect(
        executeAccountSwap({
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '0',
            sourceChain: 'base',
            password: 'pw',
        }),
    ).rejects.toMatchObject({
        code: 'INVALID_AMOUNT',
        message: 'Amount must be greater than zero.',
    })
})

test('executeAccountSwap rejects excessive token precision with INVALID_AMOUNT', async () => {
    await expect(
        executeAccountSwap({
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '1.1234567',
            sourceChain: 'base',
            password: 'pw',
        }),
    ).rejects.toMatchObject({
        code: 'INVALID_AMOUNT',
        message: 'Amount supports at most 6 decimal places for USDC.',
    })
})

test('executeAccountSwap rejects malformed amounts with INVALID_AMOUNT', async () => {
    await expect(
        executeAccountSwap({
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '1.0.0',
            sourceChain: 'base',
            password: 'pw',
        }),
    ).rejects.toMatchObject({
        code: 'INVALID_AMOUNT',
        message: 'Amount must be a positive decimal number.',
    })
})

test('executeAccountSwap fails fast on insufficient balance', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '100',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 1n),
            },
        ),
    ).rejects.toMatchObject({
        code: 'SWAP_FAILED',
        message: expect.stringContaining('Insufficient USDC balance'),
    })
})

test('executeAccountSwap still confirms the quote when yes is set', async () => {
    const confirmQuote = mock(async () => true)

    await executeAccountSwap(
        {
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '1',
            sourceChain: 'base',
            password: 'pw',
            keystorePath: '/tmp/alice.json',
            yes: true,
        },
        {
            readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => 2_000000n),
            getQuote: mock(async () => makeQuote()) as unknown as any,
            readNonce: mock(async () => 2n),
            confirmQuote,
            prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () => makeFinalStatus()) as unknown as any,
        },
    )

    expect(confirmQuote).toHaveBeenCalledTimes(1)
})

test('executeAccountSwap rejects relay quotes with mismatched source-chain calls', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () =>
                    makeQuote({
                        steps: [
                            {
                                id: 'swap',
                                kind: 'transaction',
                                items: [
                                    {
                                        status: 'incomplete',
                                        data: {
                                            to: '0x4444444444444444444444444444444444444444',
                                            data: '0xdeadbeef',
                                            value: '0',
                                            chainId: 137,
                                        },
                                    },
                                ],
                            },
                        ],
                    }),
                ) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('expected source chain base (8453)'),
    })
})

test('executeAccountSwap stops after repeated quote drift during confirmation', async () => {
    const confirmQuote = mock(async () => true)
    const getQuote = mock(async () => {
        const callCount = getQuote.mock.calls.length
        return makeQuote({
            details: {
                currencyOut: {
                    amount: '28500000000000000',
                    amountFormatted: '0.0285',
                    minimumAmount: '28500000000000000',
                    amountUsd: String(100 + callCount * 2),
                },
                rate: String(3500 + callCount * 25),
                timeEstimate: 2,
            },
        })
    })
    const nowValues = [0, 31_000, 32_000, 63_500, 64_000, 95_500]
    let nowIndex = 0
    const originalNow = Date.now
    Date.now = () => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? 95_500

    let caught: unknown
    try {
        await executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: getQuote as unknown as any,
                confirmQuote,
            },
        )
    } catch (error) {
        caught = error
    } finally {
        Date.now = originalNow
    }

    expect(caught).toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('Quote changed materially too many times'),
    })
    const driftMessage = String((caught as { message?: unknown }).message ?? '')
    expect(driftMessage.includes('--yes')).toBe(false)

    expect(confirmQuote).toHaveBeenCalledTimes(3)
    expect(getQuote).toHaveBeenCalledTimes(4)
})

test('executeAccountSwap does not force reconfirmation when refreshed quotes are too sparse to compare', async () => {
    const confirmQuote = mock(async () => true)
    const getQuote = mock(async () =>
        makeQuote({
            details: {
                currencyOut: {
                    amount: '28500000000000000',
                    amountFormatted: '0.0285',
                    minimumAmount: '28500000000000000',
                },
                timeEstimate: 2,
            },
        }),
    )
    const nowValues = [0, 31_000]
    let nowIndex = 0
    const originalNow = Date.now
    Date.now = () => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? 31_000

    try {
        await executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: getQuote as unknown as any,
                confirmQuote,
                readNonce: mock(async () => 2n),
                prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
                signTypedData: mock(
                    async () =>
                        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
                ) as unknown as any,
                sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
                waitForBundle: mock(async () => makeFinalStatus()) as unknown as any,
            },
        )
    } finally {
        Date.now = originalNow
    }

    expect(confirmQuote).toHaveBeenCalledTimes(1)
    expect(getQuote).toHaveBeenCalledTimes(2)
})

test('executeAccountSwap maps bridge polling timeouts to typed errors', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'ETH',
                toToken: 'ETH',
                amount: '0.1',
                sourceChain: 'base',
                destinationChain: 'polygon',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 1_000000000000000000n),
                getKeys: mock(async () => makeKeys({ nativeSpendLimit: '0x16345785d8a0000' })),
                getQuote: mock(async () => makeEthBridgeQuote()) as unknown as any,
                readNonce: mock(async () => 2n),
                prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
                signTypedData: mock(
                    async () =>
                        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
                ) as unknown as any,
                sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
                waitForBundle: mock(async () => makeFinalStatus()) as unknown as any,
                pollIntentStatus: mock(async () => {
                    throw new RelayLinkError(
                        'TIMEOUT',
                        'relay.link intent relay-request-1 did not reach a terminal state before timeout.',
                    )
                }) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'BRIDGE_FILL_TIMEOUT',
        message:
            'Bridge fill did not complete within 5 minutes. Check relay.link status: https://api.relay.link/intents/status/v3?requestId=relay-request-1',
    })
})

test('executeAccountSwap surfaces relayer auth codes from sendPreparedCalls', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () => makeQuote()) as unknown as any,
                readNonce: mock(async () => 2n),
                prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
                signTypedData: mock(
                    async () =>
                        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
                ) as unknown as any,
                sendPreparedCalls: mock(async () => {
                    throw new JsonRpcClientError(-32001, 'Unauthorized', {
                        auth_code: 'BAD_SIGNATURE',
                    })
                }),
            },
        ),
    ).rejects.toMatchObject({
        code: 'UNKNOWN',
        message: 'Unauthorized (BAD_SIGNATURE)',
    })
})

test('executeAccountSwap does not fall back to session.json for unrelated keystore errors', async () => {
    const readSessionKeystoreFile = mock(async () => {
        throw new Error('should not be called')
    })

    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => {
                    throw new Error('permission denied')
                }) as unknown as any,
                readSessionKeystoreFile,
            },
        ),
    ).rejects.toMatchObject({
        code: 'UNKNOWN',
        message: 'permission denied',
    })

    expect(readSessionKeystoreFile).toHaveBeenCalledTimes(0)
})

test('executeAccountSwap falls back to session.json when the root keystore is missing', async () => {
    const originalConsoleError = console.error
    const consoleError = mock(() => {})
    console.error = consoleError as typeof console.error

    try {
        const readSessionKeystoreFile = mock(async () =>
            makeSessionKeystore({
                network: {
                    env: 'prod',
                    relayerUrl: 'http://127.0.0.1:8787',
                    rpcUrl: 'https://mainnet.base.org',
                    chainId: 8453,
                },
            }),
        ) as unknown as any

        const result = await executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => {
                    throw new Error('ENOENT: no such file or directory, open /tmp/alice.json')
                }) as unknown as any,
                readSessionKeystoreFile,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () => makeQuote()) as unknown as any,
                readNonce: mock(async () => 2n),
                prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
                signTypedData: mock(
                    async () =>
                        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
                ) as unknown as any,
                sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
                waitForBundle: mock(async () => makeFinalStatus()) as unknown as any,
            },
        )

        expect(result.keystorePath).toBe('/tmp/alice.json')
        expect(readSessionKeystoreFile).toHaveBeenCalledWith('/tmp/session.json')
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining('falling back to session profile'),
        )
    } finally {
        console.error = originalConsoleError
    }
})

test('executeAccountSwap falls back to session.json for login-profile root-key errors', async () => {
    const readSessionKeystoreFile = mock(async () =>
        makeSessionKeystore({
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
        }),
    ) as unknown as any

    const result = await executeAccountSwap(
        {
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '1',
            sourceChain: 'base',
            password: 'pw',
            keystorePath: '/tmp/alice.json',
            yes: true,
        },
        {
            readKeystoreBundle: mock(async () => {
                throw new LoginProfileError()
            }) as unknown as any,
            readSessionKeystoreFile,
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: mock(async () => 2_000000n),
            getQuote: mock(async () => makeQuote()) as unknown as any,
            readNonce: mock(async () => 2n),
            prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () => makeFinalStatus()) as unknown as any,
        },
    )

    expect(result.keystorePath).toBe('/tmp/alice.json')
    expect(readSessionKeystoreFile).toHaveBeenCalledWith('/tmp/session.json')
})

test('executeAccountSwap validates named session network against requested env and chain', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                sessionName: 'default',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => ({
                    ...makeKeystoreBundle(),
                    root: {
                        ...makeKeystoreBundle().root,
                        sessionRef: {
                            dir: 'sessions',
                        },
                    },
                })) as unknown as any,
                readSessionKeystoreFile: mock(async () =>
                    makeSessionKeystore({
                        network: {
                            env: 'stage',
                            relayerUrl: 'http://127.0.0.1:8787',
                            rpcUrl: 'https://mainnet.base.org',
                            chainId: 8453,
                        },
                    }),
                ) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'UNSUPPORTED_CHAIN',
        message: 'Session file env mismatch: expected prod, got stage.',
    })
})

test('executeAccountSwap rejects session files with a mismatched chainId', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                sessionFile: '/tmp/session.json',
                yes: true,
            },
            {
                readSessionKeystoreFile: mock(async () =>
                    makeSessionKeystore({
                        network: {
                            env: 'prod',
                            relayerUrl: 'http://127.0.0.1:8787',
                            rpcUrl: 'https://polygon-rpc.com',
                            chainId: 137,
                        },
                    }),
                ) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'UNSUPPORTED_CHAIN',
        message: 'Session file chain mismatch: expected 8453, got 137.',
    })
})

test('executeAccountSwap maps bundle status 400 to INTENT_REVERTED', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () => makeQuote()) as unknown as any,
                readNonce: mock(async () => 2n),
                prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
                signTypedData: mock(
                    async () =>
                        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
                ) as unknown as any,
                sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
                waitForBundle: mock(async () =>
                    makeFinalStatus({
                        statusCode: 400,
                        receipt: {
                            ...makeFinalStatus().receipt,
                            intentError:
                                '0x08c379a000000000000000000000000000000000000000000000000000000000000020',
                        },
                    }),
                ) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'INTENT_REVERTED',
        details: expect.objectContaining({
            statusCode: 400,
            intentError: '0x08c379a000000000000000000000000000000000000000000000000000000000000020',
        }),
    })
})

test('executeAccountSwap maps bridge fill non-success to BRIDGE_FILL_FAILED', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'ETH',
                toToken: 'ETH',
                amount: '0.1',
                sourceChain: 'base',
                destinationChain: 'polygon',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 1_000000000000000000n),
                getKeys: mock(async () => makeKeys({ nativeSpendLimit: '0x16345785d8a0000' })),
                getQuote: mock(async () => makeEthBridgeQuote()) as unknown as any,
                readNonce: mock(async () => 2n),
                prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
                signTypedData: mock(
                    async () =>
                        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
                ) as unknown as any,
                sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
                waitForBundle: mock(async () => makeFinalStatus()) as unknown as any,
                pollIntentStatus: mock(async () => ({ status: 'failure' })) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'BRIDGE_FILL_FAILED',
        message: expect.stringContaining(
            'https://api.relay.link/intents/status/v3?requestId=relay-request-1',
        ),
    })
})

test('executeAccountSwap maps simulation failure JsonRpcClientError to SIMULATION_FAILED', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () => makeQuote()) as unknown as any,
                readNonce: mock(async () => 2n),
                prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
                signTypedData: mock(
                    async () =>
                        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
                ) as unknown as any,
                sendPreparedCalls: mock(async () => {
                    throw new JsonRpcClientError(-32004, 'Simulation failed', {
                        cause: 'Custom revert reason',
                    })
                }),
            },
        ),
    ).rejects.toMatchObject({
        code: 'SIMULATION_FAILED',
        message: 'Simulation failed: Custom revert reason',
    })
})

test('executeAccountSwap maps bundle wait timeouts to BUNDLE_TIMEOUT', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () => makeQuote()) as unknown as any,
                readNonce: mock(async () => 2n),
                prepareCalls: mock(async (input) => makePreparedCalls(input)) as unknown as any,
                signTypedData: mock(
                    async () =>
                        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
                ) as unknown as any,
                sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
                waitForBundle: mock(async () => {
                    throw new Error('timeout waiting for bundle')
                }) as unknown as any,
            },
        ),
    ).rejects.toMatchObject({
        code: 'BUNDLE_TIMEOUT',
        message: 'timeout waiting for bundle',
    })
})

test('executeAccountSwap returns QUOTE_FAILED when user declines confirmation', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () => makeQuote()) as unknown as any,
                confirmQuote: mock(async () => false),
            },
        ),
    ).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: 'Swap cancelled.',
    })
})

test('executeAccountSwap rejects ETH swap when native spend remaining limit is insufficient', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'ETH',
                toToken: 'USDC',
                amount: '0.1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
                yes: true,
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 1_000000000000000000n),
                getKeys: mock(async () =>
                    makeKeys({
                        nativeSpendLimit: '0x016345785d8a0000',
                        nativeSpent: '0x015af1d78b58c400',
                    }),
                ),
            },
        ),
    ).rejects.toMatchObject({
        code: 'MISSING_NATIVE_SPEND_PERMISSION',
        message: expect.stringContaining('insufficient remaining limit'),
    })
})

test('executeAccountSwap preserves prompt cancellation for CLI handling', async () => {
    await expect(
        executeAccountSwap(
            {
                env: 'prod',
                fromToken: 'USDC',
                toToken: 'ETH',
                amount: '1',
                sourceChain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
            },
            {
                readKeystoreBundle: mock(async () => makeKeystoreBundle()) as unknown as any,
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readTokenBalance: mock(async () => 2_000000n),
                getQuote: mock(async () => makeQuote()) as unknown as any,
                readNonce: mock(async () => 2n),
                confirmQuote: mock(async () => {
                    throw new PromptCancelledError()
                }),
                auditQuote: mock((_quote) => {}),
            },
        ),
    ).rejects.toBeInstanceOf(PromptCancelledError)
})
