import { expect, mock, test } from 'bun:test'
import { AccountAddressError } from '../src/lib/account-address'
import {
    AccountNonceError,
    executeAccountNonce,
    type AccountNonceOptions,
} from '../src/lib/account-nonce'

test('executeAccountNonce returns nonce details', async () => {
    const result = await executeAccountNonce(
        {
            env: 'prod',
            keystorePath: '/tmp/alice.json',
            chain: 'base',
            seqKey: 7n,
        },
        {
            executeAccountAddress: mock(async () => ({
                type: 'account_address' as const,
                status: 'complete' as const,
                keystorePath: '/tmp/alice.json',
                address: '0x1111111111111111111111111111111111111111',
            })),
            readNonce: mock(async () => 123n),
        },
    )

    expect(result.type).toBe('account_nonce')
    expect(result.status).toBe('complete')
    expect(result.chain).toBe('base')
    expect(result.address).toBe('0x1111111111111111111111111111111111111111')
    expect(result.seqKey).toBe('7')
    expect(result.nonce).toBe('123')
})

test('executeAccountNonce maps address lookup failures', async () => {
    await expect(
        executeAccountNonce(
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
        name: 'AccountNonceError',
        code: 'ADDRESS_LOOKUP_FAILED',
    })
})

test('executeAccountNonce defaults seqKey to 0 when not provided', async () => {
    const result = await executeAccountNonce(
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
            readNonce: mock(async () => 42n),
        },
    )

    expect(result.seqKey).toBe('0')
    expect(result.nonce).toBe('42')
})

test('executeAccountNonce maps nonce read errors as UNKNOWN', async () => {
    await expect(
        executeAccountNonce(
            {
                env: 'prod',
                keystorePath: '/tmp/alice.json',
                chain: 'base',
            },
            {
                executeAccountAddress: mock(async () => ({
                    type: 'account_address' as const,
                    status: 'complete' as const,
                    keystorePath: '/tmp/alice.json',
                    address: '0x1111111111111111111111111111111111111111',
                })),
                readNonce: mock(async () => {
                    throw new Error('rpc timeout')
                }),
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountNonceError',
        code: 'UNKNOWN',
    })
})

test('executeAccountNonce maps unsupported chain errors', async () => {
    await expect(
        executeAccountNonce(
            {
                env: 'prod',
                keystorePath: '/tmp/alice.json',
            },
            {
                executeAccountAddress: mock(async () => {
                    throw new Error('Unsupported chain: foobar')
                }),
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountNonceError',
        code: 'UNSUPPORTED_CHAIN',
    })
})

test('executeAccountNonce preserves cause for invalid chain override', async () => {
    // SAFETY: 'foobar' is not a ChainName; this negative case checks UNSUPPORTED_CHAIN.
    const invalidOptions: AccountNonceOptions = {
        env: 'prod',
        keystorePath: '/tmp/alice.json',
        chain: 'foobar' as AccountNonceOptions['chain'],
    }

    try {
        await executeAccountNonce(invalidOptions)
        throw new Error('expected executeAccountNonce to throw')
    } catch (error) {
        expect(error).toBeInstanceOf(AccountNonceError)

        if (!(error instanceof AccountNonceError)) throw error

        expect(error.code).toBe('UNSUPPORTED_CHAIN')
        expect(error.cause).toBeInstanceOf(Error)

        const causeMessage =
            error.cause instanceof Error ? error.cause.message : String(error.cause)

        expect(causeMessage).toContain('Unsupported chain')
    }
})
