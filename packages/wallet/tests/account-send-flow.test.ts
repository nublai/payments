import { expect, mock, test } from 'bun:test'
import {
    AccountSendError,
    executeAccountSend,
    resolveAccountSendPassword,
} from '../src/lib/account-send'
import { LoginProfileError, SessionOnlyProfileError } from '../src/lib/keystore'
import { RecipientResolutionError } from '../src/lib/recipient-resolver'
import { matchingPreparedCalls } from './helpers/matching-prepared'

test('resolveAccountSendPassword uses RELAYER_CLI_PASSWORD first', async () => {
    const value = await resolveAccountSendPassword(
        {
            env: 'prod',
            amount: '1',
            recipient: '0x1111111111111111111111111111111111111111',
            chain: 'base',
            legacy: false,
            json: false,
            help: false,
            passwordStdin: true,
        },
        {
            envPassword: 'from-env',
            readPasswordFromStdin: () => 'from-stdin',
            promptForExistingPassword: async () => 'from-prompt',
            isInteractive: true,
        },
    )

    expect(value).toBe('from-env')
})

test('executeAccountSend preserves cause for invalid chain override', async () => {
    const invalidOptions = {
        env: 'prod',
        amount: '1',
        recipient: '0x2222222222222222222222222222222222222222',
        chain: 'foobar',
        password: 'pw',
        keystorePath: '/tmp/alice.json',
    } as unknown as Parameters<typeof executeAccountSend>[0]

    try {
        await executeAccountSend(invalidOptions)
        throw new Error('expected executeAccountSend to throw')
    } catch (error) {
        expect(error).toBeInstanceOf(AccountSendError)
        const sendError = error as AccountSendError
        expect(sendError.code).toBe('UNSUPPORTED_CHAIN')
        expect(sendError.cause).toBeInstanceOf(Error)
        const causeMessage =
            sendError.cause instanceof Error ? sendError.cause.message : String(sendError.cause)
        expect(causeMessage).toContain('Unsupported chain')
    }
})

test('executeAccountSend executes sponsored transfer flow', async () => {
    const prepareCalls = mock(async (input) => matchingPreparedCalls(input)) as unknown as any
    const sendPreparedCalls = mock(async () => ({ id: 'bundle-1' }))
    const result = await executeAccountSend(
        {
            env: 'prod',
            amount: '1.5',
            recipient: '0x2222222222222222222222222222222222222222',
            chain: 'polygon',
            password: 'pw',
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
                        },
                        session: {
                            addresses: {
                                session: '0x3333333333333333333333333333333333333333',
                            },
                        },
                    }) as any,
            ),
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            resolveAddressOrEnsInput: mock(async () => ({
                address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
                ens: null,
            })),
            hasLegacyRecipientAlias: mock(async () => false),
            readNonce: mock(async () => 2n),
            prepareCalls,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls,
            waitForBundle: mock(async () => ({
                success: true,
                id: 'bundle-1',
                status: 'confirmed' as const,
                statusCode: 200,
                receipt: {
                    transactionHash:
                        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    blockNumber: '1',
                    gasUsed: '1',
                    status: 'success' as const,
                },
            })) as unknown as any,
        },
    )

    expect(result.type).toBe('account_send')
    expect(result.status).toBe('complete')
    expect(result.chain).toBe('polygon')
    expect(result.token.symbol).toBe('USDC')
    expect(result.token.amount).toBe('1.5')
    expect(result.bundle.id).toBe('bundle-1')
    expect(result.txHash).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const prepareInput = (prepareCalls as any).mock.calls[0]?.[0]
    expect(typeof prepareInput.sessionKey).toBe('string')
    expect(prepareInput.sessionKey.startsWith('0x')).toBe(true)
    expect(prepareInput.nonce).toBe(2n)
    const sentSignature = (sendPreparedCalls as any).mock.calls[0]?.[0]?.signature as string
    expect(sentSignature.startsWith('0x11111111111111111111111111111111')).toBe(true)
    expect(sentSignature.length).toBeGreaterThan(132)
})

test('executeAccountSend supports legacy polygon USDC.e override', async () => {
    const result = await executeAccountSend(
        {
            env: 'prod',
            amount: '1',
            recipient: '0x2222222222222222222222222222222222222222',
            chain: 'polygon',
            legacy: true,
            password: 'pw',
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
                        },
                        session: {
                            addresses: {
                                session: '0x3333333333333333333333333333333333333333',
                            },
                        },
                    }) as any,
            ),
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            resolveAddressOrEnsInput: mock(async () => ({
                address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
                ens: null,
            })),
            hasLegacyRecipientAlias: mock(async () => false),
            readNonce: mock(async () => 2n),
            prepareCalls: mock(async (input) => matchingPreparedCalls(input)) as unknown as any,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () => ({
                success: true,
                id: 'bundle-1',
                status: 'confirmed' as const,
                statusCode: 200,
            })) as unknown as any,
        },
    )

    expect(result.token.symbol).toBe('USDC.e')
    expect(result.token.address).toBe('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174')
})

test('executeAccountSend rejects invalid amount precision', async () => {
    await expect(
        executeAccountSend(
            {
                env: 'prod',
                amount: '1.0000001',
                recipient: '0x2222222222222222222222222222222222222222',
                chain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
            },
            {
                readKeystoreBundle: mock(async () => ({}) as any),
            },
        ),
    ).rejects.toMatchObject({
        code: 'INVALID_AMOUNT',
    })
})

test('executeAccountSend rejects unresolved ENS recipient', async () => {
    await expect(
        executeAccountSend(
            {
                env: 'prod',
                amount: '1',
                recipient: 'unknown.eth',
                chain: 'base',
                password: 'pw',
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
                                },
                            },
                            session: {
                                addresses: {
                                    session: '0x3333333333333333333333333333333333333333',
                                },
                            },
                        }) as any,
                ),
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                resolveAddressOrEnsInput: mock(async () => {
                    throw new Error('Could not resolve ENS name: unknown.eth')
                }),
                hasLegacyRecipientAlias: mock(async () => false),
            },
        ),
    ).rejects.toMatchObject({
        code: 'RECIPIENT_UNRESOLVED',
    })
})

test('executeAccountSend surfaces guidance for legacy alias recipients', async () => {
    try {
        await executeAccountSend(
            {
                env: 'prod',
                amount: '1',
                recipient: 'vitalik',
                chain: 'base',
                password: 'pw',
                keystorePath: '/tmp/alice.json',
            },
            {
                resolveAddressOrEnsInput: mock(async () => {
                    throw new RecipientResolutionError(
                        'INVALID_RECIPIENT',
                        'Recipient must be a valid address or .eth ENS name.',
                    )
                }),
                hasLegacyRecipientAlias: mock(async () => true),
                readKeystoreBundle: mock(
                    async () =>
                        ({
                            root: {
                                addresses: {
                                    root: '0x1111111111111111111111111111111111111111',
                                    delegated: '0x1111111111111111111111111111111111111111',
                                },
                            },
                            session: {
                                addresses: {
                                    session: '0x3333333333333333333333333333333333333333',
                                },
                            },
                        }) as any,
                ),
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                readNonce: mock(async () => 1n),
                prepareCalls: mock(async (input) => matchingPreparedCalls(input)) as unknown as any,
                signTypedData: mock(
                    async () =>
                        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
                ) as unknown as any,
                sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
                waitForBundle: mock(async () => ({
                    success: true,
                    id: 'bundle-1',
                    status: 'confirmed' as const,
                    statusCode: 200,
                })) as unknown as any,
            },
        )
        throw new Error('expected executeAccountSend to throw')
    } catch (error) {
        expect(error).toBeInstanceOf(AccountSendError)
        const sendError = error as AccountSendError
        expect(sendError.code).toBe('INVALID_RECIPIENT')
        expect(sendError.message).toContain('Contact aliases are no longer supported.')
        expect(sendError.message).toContain('"vitalik"')
        expect(sendError.details).toEqual({ legacyAlias: 'vitalik' })
    }
})

test('executeAccountSend resolves ENS recipient', async () => {
    const result = await executeAccountSend(
        {
            env: 'prod',
            amount: '1',
            recipient: 'vitalik.eth',
            chain: 'base',
            password: 'pw',
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
                        },
                        session: {
                            addresses: {
                                session: '0x3333333333333333333333333333333333333333',
                            },
                        },
                    }) as any,
            ),
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            resolveAddressOrEnsInput: mock(async () => ({
                address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as `0x${string}`,
                ens: 'vitalik.eth' as `${string}.eth`,
            })),
            hasLegacyRecipientAlias: mock(async () => false),
            readNonce: mock(async () => 1n),
            prepareCalls: mock(async (input) => matchingPreparedCalls(input)) as unknown as any,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () => ({
                success: true,
                id: 'bundle-1',
                status: 'confirmed' as const,
                statusCode: 200,
            })) as unknown as any,
        },
    )

    expect(result.recipient.resolved).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
})

test('executeAccountSend classifies empty recipient as invalid recipient', async () => {
    await expect(
        executeAccountSend(
            {
                env: 'prod',
                amount: '1',
                recipient: '   ',
                chain: 'base',
                password: 'pw',
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
                            },
                            session: {
                                addresses: {
                                    session: '0x3333333333333333333333333333333333333333',
                                },
                            },
                        }) as any,
                ),
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey:
                        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
                })),
                resolveAddressOrEnsInput: mock(async () => {
                    throw new Error('Recipient cannot be empty.')
                }),
                hasLegacyRecipientAlias: mock(async () => false),
            },
        ),
    ).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' })
})

test('executeAccountSend supports --session-file direct mode', async () => {
    const readSessionKeystoreFile = mock(async () => ({
        version: 2,
        createdAt: '2026-03-02T00:00:00.000Z',
        name: 'worker-1',
        checkpoint: 'authorized',
        network: {
            env: 'prod',
            relayerUrl: 'https://relayer.example',
            rpcUrl: 'https://rpc.example',
            chainId: 8453,
        },
        kdf: {
            name: 'argon2id',
            params: {
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1,
                hashLength: 32,
                salt: 'dGVzdA==',
            },
        },
        crypto: { algorithm: 'aes-256-gcm' },
        addresses: {
            session: '0x3333333333333333333333333333333333333333',
            delegated: '0x1111111111111111111111111111111111111111',
        },
        secrets: {
            sessionPrivateKey: { nonce: 'a', ciphertext: 'b', tag: 'c' },
        },
    }))
    const result = await executeAccountSend(
        {
            env: 'prod',
            amount: '1',
            recipient: '0x2222222222222222222222222222222222222222',
            chain: 'base',
            password: 'pw',
            sessionFile: '/tmp/worker-1.session.json',
        },
        {
            readSessionKeystoreFile,
            readKeystoreBundle: mock(async () => {
                throw new Error('should not load root bundle')
            }),
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            resolveAddressOrEnsInput: mock(async () => ({
                address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
                ens: null,
            })),
            hasLegacyRecipientAlias: mock(async () => false),
            readNonce: mock(async () => 2n),
            prepareCalls: mock(async (input) => matchingPreparedCalls(input)) as unknown as any,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () => ({
                success: true,
                id: 'bundle-1',
                status: 'confirmed' as const,
                statusCode: 200,
            })) as unknown as any,
        },
    )
    expect(result.status).toBe('complete')
    expect(readSessionKeystoreFile).toHaveBeenCalledTimes(1)
})

test('executeAccountSend supports --session local selection mode', async () => {
    const readSessionKeystoreFile = mock(async (path: string) => {
        if (path.endsWith('/sessions/worker-2.json')) {
            return {
                version: 2,
                createdAt: '2026-03-02T00:00:00.000Z',
                name: 'worker-2',
                checkpoint: 'authorized',
                network: {
                    env: 'prod',
                    relayerUrl: 'https://relayer.example',
                    rpcUrl: 'https://rpc.example',
                    chainId: 8453,
                },
                kdf: {
                    name: 'argon2id',
                    params: {
                        memoryCost: 19456,
                        timeCost: 2,
                        parallelism: 1,
                        hashLength: 32,
                        salt: 'dGVzdA==',
                    },
                },
                crypto: { algorithm: 'aes-256-gcm' },
                addresses: {
                    session: '0x4444444444444444444444444444444444444444',
                    delegated: '0x1111111111111111111111111111111111111111',
                },
                secrets: {
                    sessionPrivateKey: { nonce: 'a', ciphertext: 'b', tag: 'c' },
                },
            }
        }
        throw new Error(`unexpected session path: ${path}`)
    })

    const result = await executeAccountSend(
        {
            env: 'prod',
            amount: '1',
            recipient: '0x2222222222222222222222222222222222222222',
            chain: 'base',
            password: 'pw',
            keystorePath: '/tmp/default.keystore.json',
            sessionName: 'worker-2',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split',
                        rootPath: '/tmp/default.keystore.json',
                        sessionPath: '/tmp/sessions/default.json',
                        root: {
                            addresses: {
                                root: '0x1111111111111111111111111111111111111111',
                                delegated: '0x1111111111111111111111111111111111111111',
                            },
                            sessionRef: { active: 'default', dir: 'sessions' },
                        },
                        session: {
                            addresses: {
                                session: '0x3333333333333333333333333333333333333333',
                            },
                        },
                    }) as any,
            ),
            readSessionKeystoreFile,
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const,
            })),
            resolveAddressOrEnsInput: mock(async () => ({
                address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
                ens: null,
            })),
            hasLegacyRecipientAlias: mock(async () => false),
            readNonce: mock(async () => 2n),
            prepareCalls: mock(async (input) => matchingPreparedCalls(input)) as unknown as any,
            signTypedData: mock(
                async () =>
                    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
            ) as unknown as any,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () => ({
                success: true,
                id: 'bundle-1',
                status: 'confirmed' as const,
                statusCode: 200,
            })) as unknown as any,
        },
    )

    expect(result.status).toBe('complete')
    expect(readSessionKeystoreFile).toHaveBeenCalledWith('/tmp/sessions/worker-2.json')
})

test('executeAccountSend preserves selected session lookup failures', async () => {
    await expect(
        executeAccountSend(
            {
                env: 'prod',
                amount: '1',
                recipient: '0x2222222222222222222222222222222222222222',
                chain: 'base',
                password: 'pw',
                keystorePath: '/tmp/default.keystore.json',
                sessionName: 'worker-missing',
            },
            {
                readKeystoreBundle: mock(
                    async () =>
                        ({
                            format: 'split',
                            rootPath: '/tmp/default.keystore.json',
                            sessionPath: '/tmp/sessions/default.json',
                            root: {
                                addresses: {
                                    root: '0x1111111111111111111111111111111111111111',
                                    delegated: '0x1111111111111111111111111111111111111111',
                                },
                                sessionRef: { active: 'default', dir: 'sessions' },
                            },
                            session: {
                                addresses: {
                                    session: '0x3333333333333333333333333333333333333333',
                                },
                            },
                        }) as any,
                ),
                readSessionKeystoreFile: mock(async () => {
                    throw new Error('ENOENT: no such file or directory')
                }),
            },
        ),
    ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining('Could not load session "worker-missing"'),
    })
})

test('executeAccountSend rejects using --session with --session-file', async () => {
    await expect(
        executeAccountSend({
            env: 'prod',
            amount: '1',
            recipient: '0x2222222222222222222222222222222222222222',
            chain: 'base',
            password: 'pw',
            sessionFile: '/tmp/worker-1.session.json',
            sessionName: 'worker-1',
        }),
    ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
    })
})

test('executeAccountSend rejects --session-file chain mismatch', async () => {
    await expect(
        executeAccountSend(
            {
                env: 'prod',
                amount: '1',
                recipient: '0x2222222222222222222222222222222222222222',
                chain: 'base',
                password: 'pw',
                sessionFile: '/tmp/worker-1.session.json',
            },
            {
                readSessionKeystoreFile: mock(async () => ({
                    version: 2,
                    createdAt: '2026-03-02T00:00:00.000Z',
                    name: 'worker-1',
                    checkpoint: 'authorized',
                    network: {
                        env: 'prod',
                        relayerUrl: 'https://relayer.example',
                        rpcUrl: 'https://rpc.example',
                        chainId: 1,
                    },
                    kdf: {
                        name: 'argon2id',
                        params: {
                            memoryCost: 19456,
                            timeCost: 2,
                            parallelism: 1,
                            hashLength: 32,
                            salt: 'dGVzdA==',
                        },
                    },
                    crypto: { algorithm: 'aes-256-gcm' },
                    addresses: {
                        session: '0x3333333333333333333333333333333333333333',
                        delegated: '0x1111111111111111111111111111111111111111',
                    },
                    secrets: {
                        sessionPrivateKey: { nonce: 'a', ciphertext: 'b', tag: 'c' },
                    },
                })),
            },
        ),
    ).rejects.toMatchObject({
        code: 'UNSUPPORTED_CHAIN',
    })
})

test('executeAccountSend preserves chain mismatch errors in session-only profile fallback', async () => {
    await expect(
        executeAccountSend(
            {
                env: 'prod',
                amount: '1',
                recipient: '0x2222222222222222222222222222222222222222',
                chain: 'base',
                password: 'pw',
                keystorePath: '/tmp/default.keystore.json',
            },
            {
                readKeystoreBundle: mock(async () => {
                    throw new SessionOnlyProfileError('/tmp/default.keystore.json')
                }),
                readSessionKeystoreFile: mock(async () => ({
                    version: 2,
                    createdAt: '2026-03-02T00:00:00.000Z',
                    name: 'worker-1',
                    checkpoint: 'authorized',
                    network: {
                        env: 'prod',
                        relayerUrl: 'https://relayer.example',
                        rpcUrl: 'https://rpc.example',
                        chainId: 1,
                    },
                    kdf: {
                        name: 'argon2id',
                        params: {
                            memoryCost: 19456,
                            timeCost: 2,
                            parallelism: 1,
                            hashLength: 32,
                            salt: 'dGVzdA==',
                        },
                    },
                    crypto: { algorithm: 'aes-256-gcm' },
                    addresses: {
                        session: '0x3333333333333333333333333333333333333333',
                        delegated: '0x1111111111111111111111111111111111111111',
                    },
                    secrets: {
                        sessionPrivateKey: { nonce: 'a', ciphertext: 'b', tag: 'c' },
                    },
                })),
            },
        ),
    ).rejects.toMatchObject({
        code: 'UNSUPPORTED_CHAIN',
    })
})

test('executeAccountSend preserves chain mismatch errors for login-profile fallback', async () => {
    await expect(
        executeAccountSend(
            {
                env: 'prod',
                amount: '1',
                recipient: '0x2222222222222222222222222222222222222222',
                chain: 'base',
                password: 'pw',
                keystorePath: '/tmp/default.keystore.json',
            },
            {
                readKeystoreBundle: mock(async () => {
                    throw new LoginProfileError()
                }),
                readSessionKeystoreFile: mock(async () => ({
                    version: 2,
                    createdAt: '2026-03-02T00:00:00.000Z',
                    name: 'worker-1',
                    checkpoint: 'authorized',
                    kind: 'login',
                    network: {
                        env: 'prod',
                        relayerUrl: 'https://relayer.example',
                        rpcUrl: 'https://rpc.example',
                        chainId: 1,
                    },
                    kdf: {
                        name: 'argon2id',
                        params: {
                            memoryCost: 19456,
                            timeCost: 2,
                            parallelism: 1,
                            hashLength: 32,
                            salt: 'dGVzdA==',
                        },
                    },
                    crypto: { algorithm: 'aes-256-gcm' },
                    addresses: {
                        session: '0x3333333333333333333333333333333333333333',
                        delegated: '0x1111111111111111111111111111111111111111',
                    },
                    secrets: {
                        sessionPrivateKey: { nonce: 'a', ciphertext: 'b', tag: 'c' },
                    },
                })),
            },
        ),
    ).rejects.toMatchObject({
        code: 'UNSUPPORTED_CHAIN',
    })
})
