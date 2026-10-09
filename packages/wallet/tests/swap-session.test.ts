import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData, encodeFunctionData, erc20Abi, zeroAddress, type Address, type Hex } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import type { AuthorizedKeyInfo, GetKeysResponse } from '@nubl/relayer-client'
import { executeAccountSwap } from './helpers/stub-execute'
import { hex, parseAddr } from './helpers/hex'
import type {
    ExecuteSignedCallsDeps,
    ExecuteSignedCallsParams,
    ExecuteSignedCallsResult,
} from '../src/lib/execute-calls'
import type {
    AnySessionKeystore,
    createSessionKeystore,
    KeystoreBundle,
    LoginSessionKeystoreV2,
    RelayerRootKeystoreV2,
    RelayerSessionKeystoreV2,
} from '../src/lib/keystore'
import {
    grantsFromPending,
    pendingQuoteLimitPath,
    pendingRecordFromSlots,
    writePendingQuoteLimit,
} from '../src/lib/quote-spend-pending'
import { recoverPendingQuoteSpend } from '../src/lib/quote-spend-lifecycle'
import { relayEntryPoints } from '../src/lib/relay-allowlist'
import { executeSessionCreate, type SessionCreateDeps } from '../src/lib/session-create'
import { computeSessionKeyHash } from '../src/lib/session-common'
import {
    canExecuteChangeCalls,
    isExactRelaySession,
    planSwapSessionUse,
    relaySessionCallPermissions,
    swapSessionSpendTokens,
    type SwapCallGrant,
} from '../src/lib/swap-session'
import { assertNoStandingRights, knownErc20Tokens, PERMIT2 } from '../src/lib/standing-rights'
import { matchingPreparedCalls } from './helpers/matching-prepared'
import { installFormerProdDeployments } from './helpers/former-deployment-env'
import { testBaseKeys } from './helpers/authorized-key'
import { confirmedBundle } from './helpers/bundle-status'
import { testKeystoreBundle } from './helpers/keystore-bundle'
import { signedCallsResult } from './helpers/signed-calls'
import { typedMock } from './helpers/typed-mock'
import type { AccountSwapDeps } from '../src/lib/account-swap'

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

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const

const ROUTER = '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f'

const APPROVAL_PROXY = '0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE'

const ANY_TARGET = '0x3232323232323232323232323232323232323232'

const TRANSFER = '0xa9059cbb' as const

const APPROVE = '0x095ea7b3'

const ESCROW = '0x05f9597eed844410b7c0746A1C584188d0644730' as const

const ESCROW_SEL = '0x657061bf' as const

const VAULT = '0x4444444444444444444444444444444444444444'

const EMPTY_MULTICALL = encodeFunctionData({
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

function quote(items: { to: Address; data: Hex; value?: string }[]) {
    return {
        requestId: 'relay-request-1',
        steps: [
            {
                id: 'swap',
                kind: 'transaction',
                requestId: 'relay-request-1',
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
            currencyOut: { amount: '1000', minimumAmount: '1000', amountUsd: '1' },
            rate: '1',
        },
    }
}

function keys(permissions: AuthorizedKeyInfo['permissions']): GetKeysResponse {
    return testBaseKeys(SESSION_KEY_HASH, { permissions: [...permissions] })
}

const TEST_KDF = {
    name: 'argon2id',
    params: { memoryCost: 1, timeCost: 1, parallelism: 1, hashLength: 32, salt: 's' },
} as const

const TEST_SECRET = { nonce: 'n', ciphertext: 'c', tag: 't' }

const BASE_NETWORK = {
    env: 'prod',
    relayerUrl: 'http://127.0.0.1:8787',
    rpcUrl: 'https://mainnet.base.org',
    chainId: 8453,
}

function swapSessionKeystore(session: Address): RelayerSessionKeystoreV2 {
    return {
        version: 2,
        createdAt: new Date().toISOString(),
        name: 'swap',
        checkpoint: 'initialized',
        network: BASE_NETWORK,
        kdf: TEST_KDF,
        crypto: { algorithm: 'aes-256-gcm' },
        addresses: { session, delegated: USER },
        secrets: { sessionPrivateKey: TEST_SECRET },
    }
}

function swapRootBundle(): KeystoreBundle {
    const root: RelayerRootKeystoreV2 = {
        version: 2,
        createdAt: new Date().toISOString(),
        network: BASE_NETWORK,
        addresses: { root: USER, delegated: USER },
        sessionRef: { active: 'default', dir: 'sessions' },
        kdf: TEST_KDF,
        crypto: { algorithm: 'aes-256-gcm' },
        secrets: { rootPrivateKey: TEST_SECRET },
    }

    return {
        rootPath: '/tmp/default.keystore.json',
        sessionPath: '/tmp/sessions/default.json',
        root,
        session: swapSessionKeystore(SESSION_ADDRESS),
    }
}

function createSessionKeystoreReturning(
    keystore: RelayerSessionKeystoreV2,
): typeof createSessionKeystore {
    function create(input: { kind?: undefined }): Promise<RelayerSessionKeystoreV2>
    function create(input: { kind: 'login' }): Promise<LoginSessionKeystoreV2>
    async function create(input: { kind?: 'login' }): Promise<AnySessionKeystore> {
        if (input.kind === 'login') throw new Error('a login session keystore is not expected')

        return keystore
    }

    return create
}

function paymentPermissions() {
    return [
        { type: 'call' as const, to: USDC, selector: TRANSFER },
        { type: 'call' as const, to: ESCROW, selector: ESCROW_SEL },
        {
            type: 'spend' as const,
            token: USDC,
            limit: '0x989680' as const,
            spent: '0x0' as const,
            period: 'day' as const,
        },
    ]
}

function runSwap(input: {
    permissions: AuthorizedKeyInfo['permissions']
    quote?: ReturnType<typeof quote>
    readAllowance?: (value: { token: Address; spender: Address }) => Promise<bigint>
    readPermit2Allowance?: (value: {
        token: Address
        spender: Address
    }) => Promise<{ amount: bigint; expiration: bigint; nonce: bigint }>
    standingRightsRegistry?: {
        erc4626?: { vault: Address }[]
    }
    readErc4626ShareBalance?: (vault: Address) => Promise<bigint>
    readErc4626ShareAllowance?: (vault: Address, spender: Address) => Promise<bigint>
    readApprovedSignatureCheckers?: (keyHash: Hex) => Promise<readonly Address[]>
    installQuoteSpendLimit?: (value: { callGrants?: readonly SwapCallGrant[] }) => Promise<
        () => Promise<void>
    >
}) {
    const signTypedData = typedMock<AccountSwapDeps['signTypedData']>(async () => hex('0x11'))

    const executeSignedCalls = typedMock<AccountSwapDeps['executeSignedCalls']>(async () =>
        signedCallsResult(),
    )

    const result = executeAccountSwap(
        {
            env: 'prod',
            fromToken: 'USDC',
            toToken: 'ETH',
            amount: '5',
            sourceChain: 'base',
            password: 'pw',
            keystorePath: '/tmp/alice-swap-session.json',
            yes: true,
        },
        {
            readKeystoreBundle: typedMock<AccountSwapDeps['readKeystoreBundle']>(async () =>
                testKeystoreBundle(USER, SESSION_ADDRESS, 8453, 'prod'),
            ),
            decryptSessionKeystore: typedMock<AccountSwapDeps['decryptSessionKeystore']>(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            readTokenBalance: typedMock<AccountSwapDeps['readTokenBalance']>(async () => 10_000000n),
            getQuote: typedMock<AccountSwapDeps['getQuote']>(async () => input.quote ?? quote([{ to: ROUTER, data: EMPTY_MULTICALL }])),
            readNonce: typedMock<AccountSwapDeps['readNonce']>(async () => 2n),
            confirmQuote: typedMock<AccountSwapDeps['confirmQuote']>(async () => true),
            getKeys: typedMock<AccountSwapDeps['getKeys']>(async () => keys(input.permissions)),
            prepareCalls: typedMock<AccountSwapDeps['prepareCalls']>(async (call: Parameters<typeof matchingPreparedCalls>[0]) =>
                matchingPreparedCalls(call),
            ),
            signTypedData: typedMock<AccountSwapDeps['signTypedData']>(signTypedData),
            sendPreparedCalls: typedMock<AccountSwapDeps['sendPreparedCalls']>(async () => ({ id: 'bundle-1' })),
            simulateQuoteCalls: async () => {},
            installQuoteSpendLimit: input.installQuoteSpendLimit ?? (async () => async () => {}),
            readAllowance: input.readAllowance ?? (async () => 0n),
            readPermit2Allowance:
                input.readPermit2Allowance ??
                (async () => ({ amount: 0n, expiration: 0n, nonce: 0n })),
            readErc721ApprovedForAll: async () => false,
            readErc721GetApproved: async () => zeroAddress,
            readErc1155ApprovedForAll: async () => false,
            readErc4626ShareBalance: input.readErc4626ShareBalance ?? (async () => 0n),
            readErc4626ShareAllowance: input.readErc4626ShareAllowance ?? (async () => 0n),
            readApprovedSignatureCheckers:
                input.readApprovedSignatureCheckers ?? (async () => []),
            standingRightsRegistry: input.standingRightsRegistry,
            executeSignedCalls: typedMock<AccountSwapDeps['executeSignedCalls']>(executeSignedCalls),
            waitForBundle: typedMock<AccountSwapDeps['waitForBundle']>(async () => confirmedBundle()),
        },
    )

    return { result, signTypedData, executeSignedCalls }
}

test('a payment session cannot sign a relay quote', async () => {
    const ran = runSwap({ permissions: paymentPermissions() })
    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('--swap'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('an extra call permission is refused even when the relay entrypoints are present', async () => {
    const ran = runSwap({
        permissions: [
            ...relaySessionCallPermissions(8453),
            { type: 'call', to: USDC, selector: TRANSFER },
        ],
    })

    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining(TRANSFER),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('a Permit2 allowance to a relay target is refused before signing', async () => {
    const ran = runSwap({
        permissions: relaySessionCallPermissions(8453),
        readPermit2Allowance: async ({ token, spender }) =>
            token.toLowerCase() === USDC.toLowerCase() &&
            spender.toLowerCase() === ROUTER.toLowerCase()
                ? { amount: 5n, expiration: 4_000_000_000n, nonce: 0n }
                : { amount: 0n, expiration: 0n, nonce: 0n },
    })

    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('standing Permit2 allowance'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('a known vault share allowance to a relay target is refused', async () => {
    const ran = runSwap({
        permissions: relaySessionCallPermissions(8453),
        standingRightsRegistry: { erc4626: [{ vault: VAULT }] },
        readErc4626ShareAllowance: async () => 1n,
    })

    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('standing share allowance'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('a standing-rights read error refuses the quote', async () => {
    const ran = runSwap({
        permissions: relaySessionCallPermissions(8453),
        readPermit2Allowance: async () => {
            throw new Error('rpc down')
        },
    })

    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('Could not read standing rights'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('the quoted input approve is granted only when the key does not already have it', async () => {
    const approve = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [APPROVAL_PROXY, 5_000000n],
    })

    const transfer = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [USER, 1n],
    })

    const missing = planSwapSessionUse({
        chainId: 8453,
        permissions: relaySessionCallPermissions(8453),
        inputToken: USDC,
        quoteCalls: [{ target: USDC, data: approve }],
        chainLabel: 'base',
    })

    expect(missing).toEqual([{ target: USDC, selector: APPROVE }])

    const already = planSwapSessionUse({
        chainId: 8453,
        permissions: [
            ...relaySessionCallPermissions(8453),
            { type: 'call', to: USDC, selector: APPROVE },
        ],
        inputToken: USDC,
        quoteCalls: [{ target: USDC, data: approve }],
        chainLabel: 'base',
    })

    expect(already).toEqual([])

    const withTransfer = planSwapSessionUse({
        chainId: 8453,
        permissions: relaySessionCallPermissions(8453),
        inputToken: USDC,
        quoteCalls: [
            { target: USDC, data: approve },
            { target: USDC, data: transfer },
        ],
        chainLabel: 'base',
    })

    expect(withTransfer).toEqual([
        { target: USDC, selector: APPROVE },
        { target: USDC, selector: TRANSFER },
    ])

    const noTransfer = planSwapSessionUse({
        chainId: 8453,
        permissions: relaySessionCallPermissions(8453),
        inputToken: USDC,
        quoteCalls: [{ target: ROUTER, data: EMPTY_MULTICALL }],
        chainLabel: 'base',
    })

    expect(noTransfer).toEqual([])
    expect(isExactRelaySession(relaySessionCallPermissions(8453), 8453)).toBe(true)
    expect(isExactRelaySession(paymentPermissions(), 8453)).toBe(false)
})

test('executeAccountSwap asks the root to grant the missing input approve for this quote', async () => {
    const approve = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [APPROVAL_PROXY, 5_000000n],
    })

    let grants: readonly SwapCallGrant[] | undefined

    const ran = runSwap({
        permissions: relaySessionCallPermissions(8453),
        quote: quote([
            { to: USDC, data: approve },
            { to: ROUTER, data: EMPTY_MULTICALL },
        ]),
        installQuoteSpendLimit: async (value) => {
            grants = value.callGrants

            return async () => {}
        },
    })

    await ran.result
    expect(grants).toEqual([{ target: USDC, selector: APPROVE }])
})

test('creating a swap session without the phrase is refused', async () => {
    await expect(
        executeSessionCreate({
            env: 'prod',
            chain: 'base',
            sessionName: 'swap',
            password: 'pw',
            keystorePath: '/tmp/does-not-matter.json',
            swap: true,
        }),
    ).rejects.toThrow(/Creating a swap session/)
})

test('swap session create submits only the relay entrypoints and minute-zero spends', async () => {
    const sessionPrivateKey =
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const

    const { privateKeyToAccount } = await import('viem/accounts')
    const sessionAddress = privateKeyToAccount(sessionPrivateKey).address
    const sessionKeyHash = computeSessionKeyHash(sessionAddress)

    const executeSignedCalls = mock(async (_deps: ExecuteSignedCallsDeps, params: ExecuteSignedCallsParams): Promise<ExecuteSignedCallsResult> => {
        const decoded = params.calls.map((call) =>
            decodeFunctionData({ abi: accountAbi, data: call.data }),
        )

        expect(decoded[0]?.functionName).toBe('authorize')
        expect(decoded[0]?.args?.[0]).toMatchObject({ isSuperAdmin: false })
        const canExecute = decoded.filter((call) => call.functionName === 'setCanExecute')
        const spends = decoded.filter((call) => call.functionName === 'setSpendLimit')
        expect(canExecute).toHaveLength(relayEntryPoints(8453).length)

        const pairs = canExecute.map((call) => ({
            target: parseAddr(String(call.args?.[1])),
            selector: String(call.args?.[2]).toLowerCase(),
            allowed: call.args?.[3],
        }))

        for (const entry of relayEntryPoints(8453)) {
            expect(pairs).toContainEqual({
                target: entry.target,
                selector: entry.selector.toLowerCase(),
                allowed: true,
            })
        }

        expect(pairs.some((pair) => pair.selector === TRANSFER)).toBe(false)
        expect(pairs.some((pair) => pair.target.toLowerCase() === ANY_TARGET.toLowerCase())).toBe(
            false,
        )
        expect(spends.map((call) => call.args?.[1])).toEqual(swapSessionSpendTokens(8453))

        for (const spend of spends) {
            expect(spend.args?.[2]).toBe(0)
            expect(spend.args?.[3]).toBe(0n)
        }

        expect(params.calls).toHaveLength(1 + canExecute.length + spends.length)

        return {
            id: 'bundle-1',
            finalStatus: {
                success: true,
                status: 'confirmed',
                statusCode: 200,
                receipt: {
                    transactionHash:
                        '0x1111111111111111111111111111111111111111111111111111111111111111',
                    blockNumber: '0x1',
                    gasUsed: '0x0',
                    status: 'success',
                },
            },
            feeCap: { token: zeroAddress, symbol: 'none', amountUsdc: '0', expiresIn: '1h' },
        }
    })

    const writeRoot = mock(async () => {})

    const result = await executeSessionCreate(
        {
            env: 'prod',
            chain: 'base',
            keystorePath: '/tmp/default.keystore.json',
            sessionName: 'swap',
            password: 'pw',
            swap: true,
            swapPhraseConfirmed: true,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readKeystoreBundle: typedMock<AccountSwapDeps['readKeystoreBundle']>(async (_rootPath: string) => swapRootBundle()),
            fileExists: typedMock<SessionCreateDeps['fileExists']>(async () => false),
            generatePrivateKey: typedMock<SessionCreateDeps['generatePrivateKey']>(() => sessionPrivateKey),
            createSessionKeystore: createSessionKeystoreReturning(swapSessionKeystore(sessionAddress)),
            writeSessionKeystoreFile: typedMock<SessionCreateDeps['writeSessionKeystoreFile']>(async () => {}),
            writeRootKeystoreFile: writeRoot,
            decryptRootKeystore: typedMock<SessionCreateDeps['decryptRootKeystore']>(async () => ({
                rootPrivateKey:
                    '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const,
            })),
            readNonce: typedMock<AccountSwapDeps['readNonce']>(async () => 1n),
            executeSignedCalls,
            getKeys: typedMock<AccountSwapDeps['getKeys']>(
                async (): Promise<GetKeysResponse> => ({
                    '0x2105': [
                        {
                            hash: sessionKeyHash,
                            expiry: '0x0',
                            type: 'secp256k1',
                            role: 'normal',
                            publicKey: '0x',
                            permissions: [],
                        },
                    ],
                }),
            ),
            sleep: mock(async () => {}),
            readErc20Allowance: async () => 0n,
            readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
            readApprovedSignatureCheckers: async () => [],
        },
    )

    expect(result.activeSession).toBe('default')
    expect(result.permissions).toBeUndefined()
    expect(result.swap?.calls).toHaveLength(4)
    expect(writeRoot).not.toHaveBeenCalled()
})

test('swap session create on a chain with no relay contracts is refused', async () => {
    await expect(
        executeSessionCreate({
            env: 'dev',
            chain: 'anvil',
            sessionName: 'swap',
            password: 'pw',
            keystorePath: '/tmp/does-not-matter.json',
            swap: true,
            swapPhraseConfirmed: true,
        }),
    ).rejects.toThrow(/no relay\.link contracts/)
})

test('swap session create refuses a standing Permit2 allowance before authorize', async () => {
    const executeSignedCalls = mock(async () => {
        throw new Error('authorize should not be sent')
    })

    await expect(
        executeSessionCreate(
            {
                env: 'prod',
                chain: 'base',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'swap',
                password: 'pw',
                swap: true,
                swapPhraseConfirmed: true,
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: typedMock<AccountSwapDeps['readKeystoreBundle']>(async (_rootPath: string) => swapRootBundle()),
                fileExists: typedMock<SessionCreateDeps['fileExists']>(async () => false),
                generatePrivateKey: typedMock<SessionCreateDeps['generatePrivateKey']>(
                    () =>
                        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const,
                ),
                createSessionKeystore: createSessionKeystoreReturning(swapSessionKeystore(SESSION_ADDRESS)),
                writeSessionKeystoreFile: typedMock<SessionCreateDeps['writeSessionKeystoreFile']>(async () => {}),
                decryptRootKeystore: typedMock<SessionCreateDeps['decryptRootKeystore']>(async () => ({
                    rootPrivateKey:
                        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const,
                })),
                readNonce: typedMock<AccountSwapDeps['readNonce']>(async () => 1n),
                executeSignedCalls,
                readErc20Allowance: async () => 0n,
                readPermit2Allowance: async () => ({
                    amount: 9n,
                    expiration: 4_000_000_000n,
                    nonce: 0n,
                }),
                readApprovedSignatureCheckers: async () => [],
            },
        ),
    ).rejects.toThrow(/standing Permit2 allowance/)
    expect(executeSignedCalls).not.toHaveBeenCalled()
})

test('swap session create fails closed when a standing-rights read errors', async () => {
    const executeSignedCalls = mock(async () => {
        throw new Error('authorize should not be sent')
    })

    await expect(
        executeSessionCreate(
            {
                env: 'prod',
                chain: 'base',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'swap',
                password: 'pw',
                swap: true,
                swapPhraseConfirmed: true,
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: typedMock<AccountSwapDeps['readKeystoreBundle']>(async (_rootPath: string) => swapRootBundle()),
                fileExists: typedMock<SessionCreateDeps['fileExists']>(async () => false),
                generatePrivateKey: typedMock<SessionCreateDeps['generatePrivateKey']>(
                    () =>
                        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const,
                ),
                createSessionKeystore: createSessionKeystoreReturning(swapSessionKeystore(SESSION_ADDRESS)),
                writeSessionKeystoreFile: typedMock<SessionCreateDeps['writeSessionKeystoreFile']>(async () => {}),
                decryptRootKeystore: typedMock<SessionCreateDeps['decryptRootKeystore']>(async () => ({
                    rootPrivateKey:
                        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const,
                })),
                readNonce: typedMock<AccountSwapDeps['readNonce']>(async () => 1n),
                executeSignedCalls,
                readErc20Allowance: async () => {
                    throw new Error('allowance rpc down')
                },
                readApprovedSignatureCheckers: async () => [],
                readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
            },
        ),
    ).rejects.toThrow(/Could not read standing rights/)
    expect(executeSignedCalls).not.toHaveBeenCalled()
})

test('a quote grant is revoked when the pending limit is recovered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swap-grant-'))
    const keystorePath = join(dir, 'alice.json')

    const record = pendingRecordFromSlots({
        account: USER,
        keyHash: SESSION_KEY_HASH,
        chainId: 8453,
        env: 'prod',
        rpcUrl: 'http://127.0.0.1:9',
        relayerUrl: 'http://127.0.0.1:9',
        slots: [],
        callGrants: [{ target: USDC, selector: APPROVE }],
    })

    expect(grantsFromPending(record)).toEqual([{ target: USDC, selector: APPROVE }])
    await writePendingQuoteLimit(keystorePath, record)
    const submitted: Hex[] = []
    await recoverPendingQuoteSpend(keystorePath, {
        readMinuteLimits: async () => new Map(),
        submit: async (_record, calls) => {
            submitted.push(...calls.map((call) => call.data))
        },
    })
    const decoded = submitted.map((data) => decodeFunctionData({ abi: accountAbi, data }))
    expect(decoded.map((call) => call.functionName)).toEqual(['setCanExecute'])
    expect(decoded[0]?.args?.[1]).toBe(USDC)
    expect(String(decoded[0]?.args?.[2]).toLowerCase()).toBe(APPROVE)
    expect(decoded[0]?.args?.[3]).toBe(false)
    await expect(readFile(pendingQuoteLimitPath(keystorePath), 'utf8')).rejects.toThrow()
})

test('canExecute grant calls encode the allowed flag', () => {
    const calls = canExecuteChangeCalls({
        account: USER,
        keyHash: SESSION_KEY_HASH,
        grants: [{ target: USDC, selector: APPROVE }],
        allowed: true,
    })

    const decoded = decodeFunctionData({ abi: accountAbi, data: calls[0]!.data })
    expect(decoded.functionName).toBe('setCanExecute')
    expect(decoded.args?.[3]).toBe(true)
})

test('standing rights include the quoted input and fail closed on a read error', async () => {
    const tokens = knownErc20Tokens(8453, USDC)
    expect(tokens.some((token) => token.toLowerCase() === USDC.toLowerCase())).toBe(true)
    await expect(
        assertNoStandingRights({
            chainId: 8453,
            owner: USER,
            keyHash: SESSION_KEY_HASH,
            targets: [ROUTER],
            tokens: [USDC],
            readers: {
                readErc20Allowance: async () => {
                    throw new Error('down')
                },
                readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
                readErc721ApprovedForAll: async () => false,
                readErc721GetApproved: async () => zeroAddress,
                readErc1155ApprovedForAll: async () => false,
                readErc4626ShareBalance: async () => 0n,
                readErc4626ShareAllowance: async () => 0n,
                readApprovedSignatureCheckers: async () => [],
            },
        }),
    ).rejects.toThrow(/Could not read standing rights/)
    await expect(
        assertNoStandingRights({
            chainId: 8453,
            owner: USER,
            keyHash: SESSION_KEY_HASH,
            targets: [ROUTER],
            tokens: [USDC],
            readers: {
                readErc20Allowance: async (_token, spender) =>
                    spender.toLowerCase() === PERMIT2.toLowerCase() ? 1n : 0n,
                readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
                readErc721ApprovedForAll: async () => false,
                readErc721GetApproved: async () => zeroAddress,
                readErc1155ApprovedForAll: async () => false,
                readErc4626ShareBalance: async () => 0n,
                readErc4626ShareAllowance: async () => 0n,
                readApprovedSignatureCheckers: async () => [],
            },
        }),
    ).rejects.toThrow(/standing allowance/)
})

const CHECKER = '0x5555555555555555555555555555555555555555'

test('creating a swap session requires CREATE SWAP SESSION, not the full-access phrase', async () => {
    const executeSignedCalls = mock(async () => {
        throw new Error('authorize should not be sent')
    })

    const deps = {
        withKeystoreLock: async <T>(_path: string, action: () => Promise<T>) => action(),
        readKeystoreBundle: typedMock<AccountSwapDeps['readKeystoreBundle']>(async (_rootPath: string) => swapRootBundle()),
        fileExists: typedMock<SessionCreateDeps['fileExists']>(async () => false),
        generatePrivateKey: typedMock<SessionCreateDeps['generatePrivateKey']>(
            () => '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const,
        ),
        createSessionKeystore: createSessionKeystoreReturning(swapSessionKeystore(SESSION_ADDRESS)),
        writeSessionKeystoreFile: typedMock<SessionCreateDeps['writeSessionKeystoreFile']>(async () => {}),
        decryptRootKeystore: typedMock<SessionCreateDeps['decryptRootKeystore']>(async () => ({
            rootPrivateKey:
                '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const,
        })),
        readNonce: typedMock<AccountSwapDeps['readNonce']>(async () => 1n),
        executeSignedCalls,
        readErc20Allowance: async () => 0n,
        readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
        readApprovedSignatureCheckers: async () => [],
    }

    await expect(
        executeSessionCreate(
            {
                env: 'prod',
                chain: 'base',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'swap',
                password: 'pw',
                swap: true,
                fullAccessPhraseConfirmed: true,
            },
            deps,
        ),
    ).rejects.toThrow(/CREATE SWAP SESSION/)
    await expect(
        executeSessionCreate(
            {
                env: 'prod',
                chain: 'base',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'swap',
                password: 'pw',
                swap: true,
            },
            deps,
        ),
    ).rejects.toThrow(/CREATE SWAP SESSION/)
    expect(executeSignedCalls).not.toHaveBeenCalled()
})

test('an ERC-1271 signature checker is refused before a swap quote is signed', async () => {
    const ran = runSwap({
        permissions: relaySessionCallPermissions(8453),
        readApprovedSignatureCheckers: async () => [CHECKER],
    })

    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringMatching(/signature checker[\s\S]*isValidSignature/),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})

test('swap session create refuses an ERC-1271 signature checker before authorize', async () => {
    const executeSignedCalls = mock(async () => {
        throw new Error('authorize should not be sent')
    })

    await expect(
        executeSessionCreate(
            {
                env: 'prod',
                chain: 'base',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'swap',
                password: 'pw',
                swap: true,
                fullAccessPhraseConfirmed: true,
                swapPhraseConfirmed: true,
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: typedMock<AccountSwapDeps['readKeystoreBundle']>(async (_rootPath: string) => swapRootBundle()),
                fileExists: typedMock<SessionCreateDeps['fileExists']>(async () => false),
                generatePrivateKey: typedMock<SessionCreateDeps['generatePrivateKey']>(
                    () =>
                        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const,
                ),
                createSessionKeystore: createSessionKeystoreReturning(swapSessionKeystore(SESSION_ADDRESS)),
                writeSessionKeystoreFile: typedMock<SessionCreateDeps['writeSessionKeystoreFile']>(async () => {}),
                decryptRootKeystore: typedMock<SessionCreateDeps['decryptRootKeystore']>(async () => ({
                    rootPrivateKey:
                        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const,
                })),
                readNonce: typedMock<AccountSwapDeps['readNonce']>(async () => 1n),
                executeSignedCalls,
                readErc20Allowance: async () => 0n,
                readPermit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
                readApprovedSignatureCheckers: async () => [CHECKER],
            },
        ),
    ).rejects.toThrow(/signature checker[\s\S]*ERC-1271/)
    expect(executeSignedCalls).not.toHaveBeenCalled()
})

test('a signature-checker read error refuses the swap session', async () => {
    const ran = runSwap({
        permissions: relaySessionCallPermissions(8453),
        readApprovedSignatureCheckers: async () => {
            throw new Error('checker rpc down')
        },
    })

    await expect(ran.result).rejects.toMatchObject({
        code: 'QUOTE_FAILED',
        message: expect.stringContaining('Could not read standing rights'),
    })
    expect(ran.signTypedData).not.toHaveBeenCalled()
})
