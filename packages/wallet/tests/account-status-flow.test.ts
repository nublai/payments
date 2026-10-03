import { expect, mock, test } from 'bun:test'
import { computeKeyHash, encodeSecp256k1Key } from '@agentic-payments/relayer-client'
import { AccountStatusError, executeAccountStatus } from '../src/lib/account-status'

test('executeAccountStatus reports permission mismatches as warnings only', async () => {
    const sessionAddress = '0x2222222222222222222222222222222222222222' as const
    const sessionKeyHash = computeKeyHash('secp256k1', encodeSecp256k1Key(sessionAddress))
    const result = await executeAccountStatus(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split',
                        rootPath: '/tmp/alice.json',
                        sessionPath: '/tmp/sessions/default.json',
                        root: {
                            addresses: {
                                root: '0x1111111111111111111111111111111111111111',
                                delegated: '0x1111111111111111111111111111111111111111',
                            },
                            network: {
                                env: 'dev',
                                relayerUrl: 'http://127.0.0.1:8787',
                                rpcUrl: 'http://127.0.0.1:8545',
                                chainId: 31337,
                            },
                            checkpoint: 'complete',
                        },
                        session: {
                            addresses: {
                                session: sessionAddress,
                            },
                            name: 'default',
                        },
                    }) as any,
            ),
            getDelegatedCode: mock(async () => '0xef0100abcdef' as const),
            readNonce: mock(async () => 2n),
            readUsdcBalance: mock(async () => 1000000n),
            getAuthorizedKeys: mock(
                async () =>
                    ({
                        '0x7a69': [
                            {
                                hash: sessionKeyHash,
                                expiry: '0x0' as const,
                                type: 'secp256k1',
                                role: 'normal' as const,
                                publicKey:
                                    '0x0000000000000000000000002222222222222222222222222222222222222222',
                                permissions: [
                                    {
                                        type: 'call' as const,
                                        to: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                                        selector: '0xdeadbeef',
                                    },
                                ],
                            },
                        ],
                    }) as any,
            ),
        },
    )

    expect(result.type).toBe('account_status')
    expect(result.status).toBe('complete')
    expect(result.readiness).toBe(true)
    expect(result.permissions.found).toBe(true)
    expect(result.permissions.warnings).toBeGreaterThan(0)
    const permissionWarnings = result.checks.filter(
        (check) => check.id.startsWith('session.permissions') && check.level === 'warn',
    )
    expect(permissionWarnings.length).toBeGreaterThan(0)
    const missingSpendPermissionWarning = result.checks.find(
        (check) => check.id === 'session.permissions.spendToken',
    )
    expect(missingSpendPermissionWarning?.message).toContain(
        'Run tw session create without --full-access',
    )
    expect(missingSpendPermissionWarning?.message).toContain(
        'tw permissions grant --type spend --token',
    )
    expect(result.checks.some((check) => check.level === 'fail')).toBe(false)
})

test('executeAccountStatus returns readiness false on blocking failures', async () => {
    const result = await executeAccountStatus(
        {
            env: 'prod',
            chain: 'base',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split',
                        rootPath: '/tmp/alice.json',
                        sessionPath: '/tmp/sessions/default.json',
                        root: {
                            addresses: {
                                root: '0x1111111111111111111111111111111111111111',
                                delegated: '0x1111111111111111111111111111111111111111',
                            },
                            network: {
                                env: 'prod',
                                relayerUrl: 'https://relayer-worker.towns.com/',
                                rpcUrl: 'https://mainnet.base.org',
                                chainId: 8453,
                            },
                            checkpoint: 'complete',
                        },
                        session: {
                            addresses: {
                                session: '0x2222222222222222222222222222222222222222',
                            },
                            name: 'default',
                        },
                    }) as any,
            ),
            getDelegatedCode: mock(async () => '0x' as const),
            readNonce: mock(async () => {
                throw new Error('rpc unavailable')
            }),
            readUsdcBalance: mock(async () => {
                throw new Error('rpc unavailable')
            }),
            getAuthorizedKeys: mock(async () => ({}) as any),
        },
    )

    expect(result.readiness).toBe(false)
    expect(result.checks.some((check) => check.level === 'fail')).toBe(true)
})

test('executeAccountStatus reports full pass with matching permissions', async () => {
    const sessionAddress = '0x2222222222222222222222222222222222222222' as const
    const sessionKeyHash = computeKeyHash('secp256k1', encodeSecp256k1Key(sessionAddress))

    const result = await executeAccountStatus(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split',
                        root: {
                            addresses: {
                                root: '0x1111111111111111111111111111111111111111',
                                delegated: '0x1111111111111111111111111111111111111111',
                            },
                            checkpoint: 'complete',
                        },
                        session: {
                            addresses: { session: sessionAddress },
                            name: 'default',
                        },
                    }) as any,
            ),
            getDelegatedCode: mock(async () => '0xef0100abcdef' as const),
            readNonce: mock(async () => 5n),
            readUsdcBalance: mock(async () => 50_000_000n),
            getAuthorizedKeys: mock(
                async () =>
                    ({
                        '0x7a69': [
                            {
                                hash: sessionKeyHash,
                                expiry: '0x0',
                                type: 'secp256k1',
                                role: 'normal',
                                publicKey:
                                    '0x0000000000000000000000002222222222222222222222222222222222222222',
                                permissions: [
                                    {
                                        type: 'call',
                                        to: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                                        selector: '0x32323232',
                                    },
                                    {
                                        type: 'spend',
                                        token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
                                        period: 'day',
                                        limit: '10000000',
                                        spent: '0',
                                    },
                                ],
                            },
                        ],
                    }) as any,
            ),
        },
    )

    expect(result.readiness).toBe(true)
    expect(result.permissions.found).toBe(true)
    expect(result.usdc.formattedBalance).toBe('50')
    expect(result.nonce).toBe('5')
    expect(result.checks.every((c) => c.level !== 'fail')).toBe(true)
})

test('executeAccountStatus reports non-delegation code as fail', async () => {
    const result = await executeAccountStatus(
        {
            env: 'prod',
            chain: 'base',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split',
                        root: {
                            addresses: {
                                root: '0x1111111111111111111111111111111111111111',
                                delegated: '0x1111111111111111111111111111111111111111',
                            },
                            checkpoint: 'complete',
                        },
                        session: {
                            addresses: { session: '0x2222222222222222222222222222222222222222' },
                            name: 'default',
                        },
                    }) as any,
            ),
            getDelegatedCode: mock(async () => '0x6080604052' as const),
            readNonce: mock(async () => 0n),
            readUsdcBalance: mock(async () => 0n),
            getAuthorizedKeys: mock(async () => ({}) as any),
        },
    )

    expect(result.readiness).toBe(false)
    const delegationCheck = result.checks.find((c) => c.id === 'delegation.code')
    expect(delegationCheck?.level).toBe('fail')
    expect(delegationCheck?.message).toContain('not an EIP-7702')
})

test('executeAccountStatus reports session key not found as warning', async () => {
    const result = await executeAccountStatus(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split',
                        root: {
                            addresses: {
                                root: '0x1111111111111111111111111111111111111111',
                                delegated: '0x1111111111111111111111111111111111111111',
                            },
                            checkpoint: 'complete',
                        },
                        session: {
                            addresses: { session: '0x2222222222222222222222222222222222222222' },
                            name: 'default',
                        },
                    }) as any,
            ),
            getDelegatedCode: mock(async () => '0xef0100abcdef' as const),
            readNonce: mock(async () => 0n),
            readUsdcBalance: mock(async () => 0n),
            getAuthorizedKeys: mock(
                async () =>
                    ({
                        '0x7a69': [],
                    }) as any,
            ),
        },
    )

    expect(result.readiness).toBe(true)
    expect(result.permissions.found).toBe(false)
    const permCheck = result.checks.find((c) => c.id === 'session.permissions.found')
    expect(permCheck?.level).toBe('warn')
})

test('executeAccountStatus handles getDelegatedCode error', async () => {
    const result = await executeAccountStatus(
        {
            env: 'prod',
            chain: 'base',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split',
                        root: {
                            addresses: {
                                root: '0x1111111111111111111111111111111111111111',
                                delegated: '0x1111111111111111111111111111111111111111',
                            },
                            checkpoint: 'complete',
                        },
                        session: {
                            addresses: { session: '0x2222222222222222222222222222222222222222' },
                            name: 'default',
                        },
                    }) as any,
            ),
            getDelegatedCode: mock(async () => {
                throw new Error('network error')
            }),
            readNonce: mock(async () => 0n),
            readUsdcBalance: mock(async () => 0n),
            getAuthorizedKeys: mock(async () => ({}) as any),
        },
    )

    expect(result.readiness).toBe(false)
    const delegationCheck = result.checks.find((c) => c.id === 'delegation.code')
    expect(delegationCheck?.level).toBe('fail')
    expect(delegationCheck?.message).toContain('Could not read')
})

test('executeAccountStatus throws KEYSTORE_NOT_FOUND for ENOENT', async () => {
    await expect(
        executeAccountStatus(
            {
                env: 'prod',
                keystorePath: '/tmp/nonexistent.json',
            },
            {
                readKeystoreBundle: mock(async () => {
                    throw new Error('ENOENT: no such file or directory')
                }),
            },
        ),
    ).rejects.toMatchObject({
        code: 'KEYSTORE_NOT_FOUND',
    })
})

test('executeAccountStatus handles getAuthorizedKeys error', async () => {
    const result = await executeAccountStatus(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split',
                        root: {
                            addresses: {
                                root: '0x1111111111111111111111111111111111111111',
                                delegated: '0x1111111111111111111111111111111111111111',
                            },
                            checkpoint: 'complete',
                        },
                        session: {
                            addresses: { session: '0x2222222222222222222222222222222222222222' },
                            name: 'default',
                        },
                    }) as any,
            ),
            getDelegatedCode: mock(async () => '0xef0100abcdef' as const),
            readNonce: mock(async () => 0n),
            readUsdcBalance: mock(async () => 0n),
            getAuthorizedKeys: mock(async () => {
                throw new Error('relayer unavailable')
            }),
        },
    )

    const permCheck = result.checks.find((c) => c.id === 'session.permissions.lookup')
    expect(permCheck?.level).toBe('fail')
    expect(permCheck?.message).toContain('Could not fetch session permissions')
})

test('executeAccountStatus supports legacy polygon USDC.e override', async () => {
    const result = await executeAccountStatus(
        {
            env: 'prod',
            chain: 'polygon',
            legacy: true,
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split',
                        rootPath: '/tmp/alice.json',
                        sessionPath: '/tmp/sessions/default.json',
                        root: {
                            addresses: {
                                root: '0x1111111111111111111111111111111111111111',
                                delegated: '0x1111111111111111111111111111111111111111',
                            },
                            network: {
                                env: 'prod',
                                relayerUrl: 'https://relayer-worker.towns.com/',
                                rpcUrl: 'https://polygon.drpc.org',
                                chainId: 137,
                            },
                            checkpoint: 'complete',
                        },
                        session: {
                            addresses: {
                                session: '0x2222222222222222222222222222222222222222',
                            },
                            name: 'default',
                        },
                    }) as any,
            ),
            getDelegatedCode: mock(async () => '0xef0100abcdef' as const),
            readNonce: mock(async () => 2n),
            readUsdcBalance: mock(async () => 1000000n),
            getAuthorizedKeys: mock(async () => ({}) as any),
        },
    )

    expect(result.usdc.symbol).toBe('USDC.e')
    expect(result.usdc.contractAddress).toBe('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174')
})

test('executeAccountStatus preserves cause for invalid chain override', async () => {
    const invalidOptions = {
        env: 'prod',
        keystorePath: '/tmp/alice.json',
        chain: 'foobar',
    } as unknown as Parameters<typeof executeAccountStatus>[0]

    try {
        await executeAccountStatus(invalidOptions)
        throw new Error('expected executeAccountStatus to throw')
    } catch (error) {
        expect(error).toBeInstanceOf(AccountStatusError)
        const statusError = error as AccountStatusError
        expect(statusError.code).toBe('UNSUPPORTED_CHAIN')
        expect(statusError.cause).toBeInstanceOf(Error)
        const causeMessage =
            statusError.cause instanceof Error
                ? statusError.cause.message
                : String(statusError.cause)
        expect(causeMessage).toContain('Unsupported chain')
    }
})
