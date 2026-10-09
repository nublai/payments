import { expect, mock, test } from 'bun:test'
import { AccountAddressError } from '../src/lib/account-address'
import {
    AccountBalanceError,
    executeAccountBalance,
    type AccountBalanceOptions,
} from '../src/lib/account-balance'

test('executeAccountBalance returns base USDC balance by default', async () => {
    const result = await executeAccountBalance(
        {
            env: 'prod',
            keystorePath: '/tmp/alice.json',
        },
        {
            executeAccountAddress: mock(async () => ({
                type: 'account_address' as const,
                status: 'complete' as const,
                keystorePath: '/tmp/alice.json',
                address: '0x1111111111111111111111111111111111111111',
            })),
            readUsdcBalance: mock(async () => 1234567n),
        },
    )

    expect(result.type).toBe('account_balance')
    expect(result.chain).toBe('base')
    expect(result.symbol).toBe('USDC')
    expect(result.balance).toBe('1234567')
    expect(result.formattedBalance).toBe('1.234567')
    expect(result.contractAddress).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
})

test('executeAccountBalance defaults to anvil for dev env', async () => {
    const result = await executeAccountBalance(
        {
            env: 'dev',
            keystorePath: '/tmp/alice.json',
        },
        {
            executeAccountAddress: mock(async () => ({
                type: 'account_address' as const,
                status: 'complete' as const,
                keystorePath: '/tmp/alice.json',
                address: '0x1111111111111111111111111111111111111111',
            })),
            readUsdcBalance: mock(async () => 10n),
        },
    )

    expect(result.chain).toBe('anvil')
    expect(result.contractAddress).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
})

test('executeAccountBalance supports chain override', async () => {
    const result = await executeAccountBalance(
        {
            env: 'prod',
            keystorePath: '/tmp/alice.json',
            chain: 'polygon',
        },
        {
            executeAccountAddress: mock(async () => ({
                type: 'account_address' as const,
                status: 'complete' as const,
                keystorePath: '/tmp/alice.json',
                address: '0x1111111111111111111111111111111111111111',
            })),
            readUsdcBalance: mock(async () => 10n),
        },
    )

    expect(result.chain).toBe('polygon')
    expect(result.contractAddress).toBe('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359')
    expect(result.symbol).toBe('USDC')
})

test('executeAccountBalance supports legacy polygon USDC.e override', async () => {
    const result = await executeAccountBalance(
        {
            env: 'prod',
            keystorePath: '/tmp/alice.json',
            chain: 'polygon',
            legacy: true,
        },
        {
            executeAccountAddress: mock(async () => ({
                type: 'account_address' as const,
                status: 'complete' as const,
                keystorePath: '/tmp/alice.json',
                address: '0x1111111111111111111111111111111111111111',
            })),
            readUsdcBalance: mock(async () => 10n),
        },
    )

    expect(result.chain).toBe('polygon')
    expect(result.contractAddress).toBe('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174')
    expect(result.symbol).toBe('USDC.e')
})

test('executeAccountBalance maps address lookup failures', async () => {
    await expect(
        executeAccountBalance(
            {
                env: 'prod',
                keystorePath: '/tmp/alice.json',
            },
            {
                executeAccountAddress: mock(async () => {
                    throw new AccountAddressError('KEYSTORE_NOT_FOUND', 'Keystore not found')
                }),
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountBalanceError',
        code: 'ADDRESS_LOOKUP_FAILED',
    })
})

test('executeAccountBalance preserves cause for invalid chain override', async () => {
    // SAFETY: 'foobar' is not a ChainName; this negative case checks UNSUPPORTED_CHAIN.
    const invalidOptions: AccountBalanceOptions = {
        env: 'prod',
        keystorePath: '/tmp/alice.json',
        chain: 'foobar' as AccountBalanceOptions['chain'],
    }

    try {
        await executeAccountBalance(invalidOptions)
        throw new Error('expected executeAccountBalance to throw')
    } catch (error) {
        expect(error).toBeInstanceOf(AccountBalanceError)

        if (!(error instanceof AccountBalanceError)) throw error

        expect(error.code).toBe('UNSUPPORTED_CHAIN')
        expect(error.cause).toBeInstanceOf(Error)

        const causeMessage =
            error.cause instanceof Error
                ? error.cause.message
                : String(error.cause)

        expect(causeMessage).toContain('Unsupported chain')
    }
})
