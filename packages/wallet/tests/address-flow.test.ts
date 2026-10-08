import { expect, mock, test } from 'bun:test'
import type { AccountAddressResult } from '../src/lib/account-address'
import { executeAddress } from '../src/lib/address'

const accountAddress: AccountAddressResult = {
    type: 'account_address',
    status: 'complete',
    keystorePath: '/tmp/default.keystore.json',
    address: '0x2222222222222222222222222222222222222222',
}

test('executeAddress returns default usdc/base context', async () => {
    const result = await executeAddress(
        {
            env: 'prod',
        },
        {
            executeAccountAddress: mock(async () => accountAddress),
        },
    )

    expect(result.type).toBe('address')
    expect(result.address).toBe('0x2222222222222222222222222222222222222222')
    expect(result.token.symbol).toBe('USDC')
    expect(result.token.decimals).toBe(6)
    expect(result.chain.name).toBe('base')
    expect(result.chain.chainId).toBe(8453)
    expect(result.warnings[0]).toContain('Send this token on this chain only')
})

test('executeAddress requires decimals for custom token amount', async () => {
    await expect(
        executeAddress(
            {
                env: 'prod',
                token: '0x1111111111111111111111111111111111111111',
                amount: '1',
            },
            {
                executeAccountAddress: mock(async () => accountAddress),
            },
        ),
    ).rejects.toMatchObject({
        code: 'MISSING_ARGUMENT',
    })
})

test('executeAddress encodes custom token amount with decimals', async () => {
    const result = await executeAddress(
        {
            env: 'prod',
            token: '0x1111111111111111111111111111111111111111',
            amount: '1.5',
            decimals: 18,
            link: true,
        },
        {
            executeAccountAddress: mock(async () => accountAddress),
        },
    )

    expect(result.funding?.amountAtomic).toBe('1500000000000000000')
    expect(result.funding?.paymentUri).toContain('uint256=1500000000000000000')
})

test('executeAddress keeps usdc decimals fixed at 6', async () => {
    const result = await executeAddress(
        {
            env: 'prod',
            token: 'USDC',
            amount: '1',
            decimals: 18,
            link: true,
        },
        {
            executeAccountAddress: mock(async () => accountAddress),
        },
    )

    expect(result.token.decimals).toBe(6)
    expect(result.funding?.amountAtomic).toBe('1000000')
})

test('executeAddress uses identical payload for link and qr', async () => {
    const result = await executeAddress(
        {
            env: 'prod',
            token: 'USDC',
            amount: '1',
            link: true,
            qr: true,
        },
        {
            executeAccountAddress: mock(async () => accountAddress),
        },
    )

    expect(result.funding?.paymentUri).toBe(result.funding?.qrPayload)
})

test('executeAddress validates decimals bounds', async () => {
    await expect(
        executeAddress(
            {
                env: 'prod',
                token: '0x1111111111111111111111111111111111111111',
                amount: '1',
                decimals: 77,
            },
            {
                executeAccountAddress: mock(async () => accountAddress),
            },
        ),
    ).rejects.toMatchObject({
        code: 'MISSING_ARGUMENT',
    })
})
