import { expect, mock, test } from 'bun:test'
import { executeAccountHistory } from '../src/lib/account-history'
import type { KeystoreBundle } from '../src/lib/keystore'

const network = {
    env: 'prod',
    relayerUrl: 'http://127.0.0.1:8787',
    rpcUrl: 'https://mainnet.base.org',
    chainId: 8453,
}

const kdf: KeystoreBundle['root']['kdf'] = {
    name: 'argon2id',
    params: { memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32, salt: 'dGVzdA==' },
}

const bundle: KeystoreBundle = {
    rootPath: '/tmp/alice.json',
    sessionPath: '/tmp/sessions/default.json',
    root: {
        version: 2,
        createdAt: '2026-02-26T00:00:00.000Z',
        network,
        addresses: { root: '0x1111111111111111111111111111111111111111' },
        sessionRef: { active: 'default', dir: 'sessions' },
        kdf,
        crypto: { algorithm: 'aes-256-gcm' },
        secrets: { rootPrivateKey: { nonce: 'a', ciphertext: 'b', tag: 'c' } },
    },
    session: {
        version: 2,
        createdAt: '2026-02-26T00:00:00.000Z',
        name: 'default',
        checkpoint: 'complete',
        network,
        kdf,
        crypto: { algorithm: 'aes-256-gcm' },
        addresses: {
            session: '0x2222222222222222222222222222222222222222',
            delegated: '0x1111111111111111111111111111111111111111',
        },
        secrets: { sessionPrivateKey: { nonce: 'a', ciphertext: 'b', tag: 'c' } },
    },
}

test('executeAccountHistory uses root EOA from keystore when no address override', async () => {
    const getCallsHistory = mock(async () => ({
        success: true as const,
        items: [{ id: 'bundle-1', chainId: 8453, createdAt: 1000 }],
        total: 1,
    }))

    const result = await executeAccountHistory(
        {
            env: 'prod',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(async () => bundle),
            getCallsHistory,
        },
    )

    expect(result.type).toBe('account_history')
    expect(result.status).toBe('complete')
    expect(result.address).toBe('0x1111111111111111111111111111111111111111')
    expect(result.keystorePath).toBe('/tmp/alice.json')
    expect(result.items).toEqual([
        {
            id: 'bundle-1',
            chainId: 8453,
            chain: 'base',
            createdAt: 1000,
        },
    ])

    expect(getCallsHistory).toHaveBeenCalledWith({
        env: 'prod',
        address: '0x1111111111111111111111111111111111111111',
        chainIds: undefined,
        limit: 20,
        offset: 0,
    })
})

test('executeAccountHistory keeps keystorePath before networkScope in result key order', async () => {
    const result = await executeAccountHistory(
        {
            env: 'prod',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(async () => bundle),
            getCallsHistory: mock(async () => ({
                success: true as const,
                items: [],
                total: 0,
            })),
        },
    )

    expect(Object.keys(result)).toEqual([
        'type',
        'status',
        'address',
        'keystorePath',
        'networkScope',
        'page',
        'items',
    ])
})

test('executeAccountHistory uses explicit address and skips keystore lookup', async () => {
    const getCallsHistory = mock(async () => ({
        success: true as const,
        items: [],
        total: 0,
    }))

    const readKeystoreBundle = mock(async () => {
        throw new Error('should not be called')
    })

    const result = await executeAccountHistory(
        {
            env: 'stage',
            address: '0x2222222222222222222222222222222222222222',
        },
        {
            readKeystoreBundle,
            getCallsHistory,
        },
    )

    expect(result.address).toBe('0x2222222222222222222222222222222222222222')
    expect(result.keystorePath).toBeUndefined()
    expect(readKeystoreBundle).not.toHaveBeenCalled()
})

test('executeAccountHistory parses chain filter and maps to chain IDs', async () => {
    const getCallsHistory = mock(async () => ({
        success: true as const,
        items: [],
        total: 0,
    }))

    const result = await executeAccountHistory(
        {
            env: 'prod',
            address: '0x3333333333333333333333333333333333333333',
            chains: 'base,polygon',
        },
        {
            getCallsHistory,
        },
    )

    expect(result.networkScope.chainIds).toEqual([8453, 137])
    expect(getCallsHistory).toHaveBeenCalledWith({
        env: 'prod',
        address: '0x3333333333333333333333333333333333333333',
        chainIds: [8453, 137],
        limit: 20,
        offset: 0,
    })
})

test('executeAccountHistory omits chainIds when chain filter is not provided', async () => {
    const getCallsHistory = mock(async () => ({
        success: true as const,
        items: [],
        total: 0,
    }))

    await executeAccountHistory(
        {
            env: 'prod',
            address: '0x4444444444444444444444444444444444444444',
        },
        {
            getCallsHistory,
        },
    )

    expect(getCallsHistory).toHaveBeenCalledWith({
        env: 'prod',
        address: '0x4444444444444444444444444444444444444444',
        chainIds: undefined,
        limit: 20,
        offset: 0,
    })
})

test('executeAccountHistory rejects unsupported chain names', async () => {
    await expect(
        executeAccountHistory(
            {
                env: 'prod',
                address: '0x5555555555555555555555555555555555555555',
                chains: 'base,foo',
            },
            {
                getCallsHistory: mock(async () => ({
                    success: true as const,
                    items: [],
                    total: 0,
                })),
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountHistoryError',
        code: 'INVALID_ARGUMENT',
    })
})

test('executeAccountHistory rejects invalid limit and offset', async () => {
    await expect(
        executeAccountHistory(
            {
                env: 'prod',
                address: '0x6666666666666666666666666666666666666666',
                limit: 0,
            },
            {
                getCallsHistory: mock(async () => ({
                    success: true as const,
                    items: [],
                    total: 0,
                })),
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountHistoryError',
        code: 'INVALID_ARGUMENT',
    })

    await expect(
        executeAccountHistory(
            {
                env: 'prod',
                address: '0x6666666666666666666666666666666666666666',
                offset: -1,
            },
            {
                getCallsHistory: mock(async () => ({
                    success: true as const,
                    items: [],
                    total: 0,
                })),
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountHistoryError',
        code: 'INVALID_ARGUMENT',
    })
})

test('executeAccountHistory rejects offset + limit above max target size', async () => {
    await expect(
        executeAccountHistory(
            {
                env: 'prod',
                address: '0x7777777777777777777777777777777777777777',
                limit: 100,
                offset: 901,
            },
            {
                getCallsHistory: mock(async () => ({
                    success: true as const,
                    items: [],
                    total: 0,
                })),
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountHistoryError',
        code: 'INVALID_ARGUMENT',
    })
})

test('executeAccountHistory maps relayer failures', async () => {
    await expect(
        executeAccountHistory(
            {
                env: 'prod',
                address: '0x8888888888888888888888888888888888888888',
            },
            {
                getCallsHistory: mock(async () => ({
                    success: false as const,
                    error: 'upstream timeout',
                })),
            },
        ),
    ).rejects.toMatchObject({
        name: 'AccountHistoryError',
        code: 'RELAYER_ERROR',
    })
})

test('executeAccountHistory maps items and pagination metadata', async () => {
    const result = await executeAccountHistory(
        {
            env: 'dev',
            address: '0x9999999999999999999999999999999999999999',
            limit: 2,
            offset: 1,
        },
        {
            getCallsHistory: mock(async () => ({
                success: true as const,
                items: [
                    { id: 'bundle-a', chainId: 8453, createdAt: 2000 },
                    { id: 'bundle-b', chainId: 10, createdAt: 1000 },
                ],
                total: 7,
            })),
        },
    )

    expect(result.page).toEqual({
        limit: 2,
        offset: 1,
        returned: 2,
        total: 7,
    })
    expect(result.items).toEqual([
        {
            id: 'bundle-a',
            chainId: 8453,
            chain: 'base',
            createdAt: 2000,
        },
        {
            id: 'bundle-b',
            chainId: 10,
            chain: null,
            createdAt: 1000,
        },
    ])
})
