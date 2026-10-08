import { expect, mock, test } from 'bun:test'
import { executeAccountAddress } from '../src/lib/account-address'
import { LoginProfileError, type LoginSessionKeystoreV2 } from '../src/lib/keystore'

test('executeAccountAddress returns root address from keystore bundle', async () => {
    const result = await executeAccountAddress(
        {
            env: 'prod',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split' as const,
                        rootPath: '/tmp/alice.json',
                        sessionPath: '/tmp/sessions/default.json',
                        root: {
                            addresses: {
                                root: '0x1111111111111111111111111111111111111111',
                            },
                        },
                        session: {
                            addresses: {
                                session: '0x2222222222222222222222222222222222222222',
                            },
                        },
                    }) as any,
            ),
        },
    )

    expect(result.type).toBe('account_address')
    expect(result.address).toBe('0x1111111111111111111111111111111111111111')
})

test('executeAccountAddress maps invalid profile name to AccountAddressError', async () => {
    await expect(
        executeAccountAddress({
            env: 'prod',
            name: 'alice.dev',
        }),
    ).rejects.toMatchObject({
        name: 'AccountAddressError',
        code: 'INVALID_NAME',
    })
})

test('executeAccountAddress falls back to delegated address for login profiles', async () => {
    const readSessionKeystoreFile = mock(async (_path: string): Promise<LoginSessionKeystoreV2> => ({
        version: 2,
        createdAt: new Date().toISOString(),
        name: 'default',
        kind: 'login',
        checkpoint: 'authorized',
        network: {
            env: 'prod',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'https://mainnet.base.org',
            chainId: 8453,
        },
        kdf: {
            name: 'argon2id',
            params: {
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1,
                hashLength: 32,
                salt: 'c2FsdA==',
            },
        },
        crypto: { algorithm: 'aes-256-gcm' },
        addresses: {
            delegated: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            session: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        secrets: {
            sessionPrivateKey: {
                nonce: 'nonce',
                ciphertext: 'ciphertext',
                tag: 'tag',
            },
        },
    }))

    const result = await executeAccountAddress(
        {
            env: 'prod',
            keystorePath: '/tmp/default.keystore.json',
        },
        {
            readKeystoreBundle: mock(async () => {
                throw new LoginProfileError()
            }),
            readSessionKeystoreFile,
        },
    )

    expect(result.address).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(result.keystorePath).toBe('/tmp/session.json')
    expect(readSessionKeystoreFile).toHaveBeenCalledWith('/tmp/session.json')
})
