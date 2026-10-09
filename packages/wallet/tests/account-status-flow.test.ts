import { expect, mock, test } from 'bun:test'
import { computeKeyHash, encodeSecp256k1Key, type GetKeysResponse } from '@nubl/relayer-client'
import {
    AccountStatusError,
    executeAccountStatus,
    type AccountStatusOptions,
} from '../src/lib/account-status'
import { testKeystoreBundle } from './helpers/keystore-bundle'

function statusBundle(
    session = '0x2222222222222222222222222222222222222222',
    env: 'dev' | 'prod' = 'dev',
    chainId = 31337,
) {
    return testKeystoreBundle(
        '0x1111111111111111111111111111111111111111',
        session,
        chainId,
        env,
    )
}

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
            readKeystoreBundle: mock(async () => statusBundle(sessionAddress)),
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
                    }) satisfies GetKeysResponse,
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
            readKeystoreBundle: mock(async () => statusBundle('0x2222222222222222222222222222222222222222', 'prod', 8453)),
            getDelegatedCode: mock(async () => '0x' as const),
            readNonce: mock(async () => {
                throw new Error('rpc unavailable')
            }),
            readUsdcBalance: mock(async () => {
                throw new Error('rpc unavailable')
            }),
            getAuthorizedKeys: mock(async (): Promise<GetKeysResponse> => ({})),
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
            readKeystoreBundle: mock(async () => statusBundle(sessionAddress)),
            getDelegatedCode: mock(async () => '0xef0100abcdef' as const),
            readNonce: mock(async () => 5n),
            readUsdcBalance: mock(async () => 50_000_000n),
            getAuthorizedKeys: mock(async () => {
                return {
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
                                    limit: '0x989680',
                                    spent: '0x0',
                                },
                            ],
                        },
                    ],
                } satisfies GetKeysResponse
            }),
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
            readKeystoreBundle: mock(async () => statusBundle()),
            getDelegatedCode: mock(async () => '0x6080604052' as const),
            readNonce: mock(async () => 0n),
            readUsdcBalance: mock(async () => 0n),
            getAuthorizedKeys: mock(async (): Promise<GetKeysResponse> => ({})),
        },
    )

    expect(result.readiness).toBe(false)
    const delegationCheck = result.checks.find((c) => c.id === 'delegation.code')
    expect(delegationCheck?.level).toBe('fail')
    expect(delegationCheck?.message).toContain('not an EIP-7702')
})

test('executeAccountStatus warns when a legacy wildcard session is present', async () => {
    const sessionAddress = '0x2222222222222222222222222222222222222222' as const
    const sessionKeyHash = computeKeyHash('secp256k1', encodeSecp256k1Key(sessionAddress))

    const result = await executeAccountStatus(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(async () => statusBundle(sessionAddress)),
            getDelegatedCode: mock(async () => '0xef0100abcdef' as const),
            readNonce: mock(async () => 1n),
            readUsdcBalance: mock(async () => 0n),
            getAuthorizedKeys: mock(async () => {
                return {
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
                                    to: '0x3232323232323232323232323232323232323232',
                                    selector: '0x32323232',
                                },
                                {
                                    type: 'spend',
                                    token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                                    period: 'forever',
                                    limit: `0x${(2n ** 256n - 1n).toString(16)}`,
                                    spent: '0x0',
                                },
                            ],
                        },
                    ],
                } satisfies GetKeysResponse
            }),
        },
    )

    const wildcard = result.checks.find((check) => check.id === 'session.permissions.callWildcard')
    expect(wildcard?.level).toBe('warn')
    expect(wildcard?.message).toContain('full access')
    expect(wildcard?.message).toContain('session rotate --narrow')
    expect(result.readiness).toBe(true)
})

test('executeAccountStatus reports session key not found as warning', async () => {
    const result = await executeAccountStatus(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(async () => statusBundle()),
            getDelegatedCode: mock(async () => '0xef0100abcdef' as const),
            readNonce: mock(async () => 0n),
            readUsdcBalance: mock(async () => 0n),
            getAuthorizedKeys: mock(
                async () =>
                    ({
                        '0x7a69': [],
                    }) satisfies GetKeysResponse,
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
            readKeystoreBundle: mock(async () => statusBundle()),
            getDelegatedCode: mock(async () => {
                throw new Error('network error')
            }),
            readNonce: mock(async () => 0n),
            readUsdcBalance: mock(async () => 0n),
            getAuthorizedKeys: mock(async (): Promise<GetKeysResponse> => ({})),
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
            readKeystoreBundle: mock(async () => statusBundle()),
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
            readKeystoreBundle: mock(async () => statusBundle('0x2222222222222222222222222222222222222222', 'prod', 8453)),
            getDelegatedCode: mock(async () => '0xef0100abcdef' as const),
            readNonce: mock(async () => 2n),
            readUsdcBalance: mock(async () => 1000000n),
            getAuthorizedKeys: mock(async (): Promise<GetKeysResponse> => ({})),
        },
    )

    expect(result.usdc.symbol).toBe('USDC.e')
    expect(result.usdc.contractAddress).toBe('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174')
})

test('executeAccountStatus preserves cause for invalid chain override', async () => {
    // SAFETY: 'foobar' is not a ChainName; this negative case checks UNSUPPORTED_CHAIN.
    const invalidOptions = {
        env: 'prod',
        keystorePath: '/tmp/alice.json',
        chain: 'foobar',
    } as unknown as AccountStatusOptions

    try {
        await executeAccountStatus(invalidOptions)
        throw new Error('expected executeAccountStatus to throw')
    } catch (error) {
        expect(error).toBeInstanceOf(AccountStatusError)

        if (!(error instanceof AccountStatusError)) throw error

        expect(error.code).toBe('UNSUPPORTED_CHAIN')
        expect(error.cause).toBeInstanceOf(Error)

        const causeMessage =
            error.cause instanceof Error
                ? error.cause.message
                : String(error.cause)

        expect(causeMessage).toContain('Unsupported chain')
    }
})
