import { expect, mock, test } from 'bun:test'
import { accountAbi } from '@nubl/contracts/abis'
import { decodeFunctionData, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem'
import {
    PermissionsError,
    parseKeyHash,
    parseRuleId,
    resolveSelectedKey,
    type OnChainPermissionKey,
} from '../src/lib/permissions-common'
import { executePermissionsGrant } from '../src/lib/permissions-grant'
import { executePermissionsList } from '../src/lib/permissions-list'
import { executePermissionsRevoke } from '../src/lib/permissions-revoke'
import { executePermissionsShow } from '../src/lib/permissions-show'

const accountAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const keyHash = parseKeyHash('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

function makeSecpPublicKey(address: `0x${string}`): Hex {
    return encodeAbiParameters(parseAbiParameters('address'), [address])
}

function makeKey(overrides?: Partial<OnChainPermissionKey>): OnChainPermissionKey {
    return {
        hash: keyHash,
        expiry: '0x0',
        type: 'secp256k1',
        role: 'normal',
        publicKey: makeSecpPublicKey('0x1111111111111111111111111111111111111111'),
        permissions: [],
        ...overrides,
    }
}

test('resolveSelectedKey fails when positional and explicit selectors mismatch', () => {
    expect(() =>
        resolveSelectedKey({
            selector: {
                positional: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                keyHash: parseKeyHash(
                    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                ),
            },
            keys: [makeKey()],
            localKeys: [],
        }),
    ).toThrow(
        new PermissionsError(
            'INVALID_KEY_SELECTOR',
            'Key selector mismatch between positional and explicit selector values.',
        ),
    )
})

test('executePermissionsGrant builds setCanExecute calldata for call grants', async () => {
    let capturedData: Hex | undefined

    const result = await executePermissionsGrant(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/permissions-keystore.json',
            keyHash,
            grantType: 'call',
            target: '0x2222222222222222222222222222222222222222',
            selector: '0xa9059cbb',
            password: 'pw',
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readKeystoreBundle: mock(
                async () =>
                    ({
                        root: {
                            sessionRef: { active: 'default', dir: 'sessions' },
                            addresses: {
                                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                delegated: accountAddress,
                            },
                        },
                    }) as any,
            ),
            listSessionNames: mock(async () => []),
            readSessionKeystoreFile: mock(async () => ({}) as any),
            getKeys: mock(async () => ({ '0x7a69': [makeKey()] })),
            decryptRootKeystore: mock(
                async () => ({ rootPrivateKey: '0x' + '11'.repeat(32) }) as any,
            ),
            readNonce: mock(async () => 9n),
            executeSignedCalls: mock(async (_deps, params) => {
                capturedData = params.calls[0]?.data
                return {
                    id: 'bundle-1',
                    finalStatus: {
                        success: true,
                        status: 'confirmed',
                        statusCode: 200,
                        receipt: { transactionHash: '0x' + '22'.repeat(32) },
                    } as any,
                }
            }),
        },
    )

    expect(result.type).toBe('permissions_grant')
    expect(result.bundle.id).toBe('bundle-1')
    expect(capturedData).toBeDefined()

    const decoded = decodeFunctionData({
        abi: accountAbi,
        data: capturedData!,
    })
    expect(decoded.functionName).toBe('setCanExecute')
    expect(decoded.args).toEqual([
        keyHash,
        '0x2222222222222222222222222222222222222222',
        '0xa9059cbb',
        true,
    ])
})

test('executePermissionsGrant rejects admin key rule changes', async () => {
    await expect(
        executePermissionsGrant(
            {
                env: 'dev',
                chain: 'anvil',
                keystorePath: '/tmp/permissions-keystore.json',
                keyHash,
                grantType: 'call',
                target: '0x2222222222222222222222222222222222222222',
                selector: '0xa9059cbb',
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(
                    async () =>
                        ({
                            root: {
                                sessionRef: { active: 'default', dir: 'sessions' },
                                addresses: {
                                    root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                    delegated: accountAddress,
                                },
                            },
                        }) as any,
                ),
                listSessionNames: mock(async () => []),
                readSessionKeystoreFile: mock(async () => ({}) as any),
                getKeys: mock(async () => ({ '0x7a69': [makeKey({ role: 'admin' })] })),
            },
        ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FOR_ADMIN_KEY' })
})

test('executePermissionsRevoke --rule call generates setCanExecute false', async () => {
    let capturedData: Hex | undefined

    const result = await executePermissionsRevoke(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/permissions-keystore.json',
            keyHash,
            rule: 'call:0x3333333333333333333333333333333333333333:0x095ea7b3',
            password: 'pw',
            phraseConfirmed: true,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readKeystoreBundle: mock(
                async () =>
                    ({
                        root: {
                            sessionRef: { active: 'default', dir: 'sessions' },
                            addresses: {
                                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                delegated: accountAddress,
                            },
                        },
                    }) as any,
            ),
            listSessionNames: mock(async () => []),
            readSessionKeystoreFile: mock(async () => ({}) as any),
            getKeys: mock(async () => ({ '0x7a69': [makeKey()] })),
            decryptRootKeystore: mock(
                async () => ({ rootPrivateKey: '0x' + '11'.repeat(32) }) as any,
            ),
            readNonce: mock(async () => 10n),
            executeSignedCalls: mock(async (_deps, params) => {
                capturedData = params.calls[0]?.data
                return {
                    id: 'bundle-2',
                    finalStatus: {
                        success: true,
                        status: 'confirmed',
                        statusCode: 200,
                    } as any,
                }
            }),
        },
    )

    expect(result.ruleCount).toBe(1)
    const decoded = decodeFunctionData({
        abi: accountAbi,
        data: capturedData!,
    })
    expect(decoded.functionName).toBe('setCanExecute')
    expect(decoded.args).toEqual([
        keyHash,
        '0x3333333333333333333333333333333333333333',
        '0x095ea7b3',
        false,
    ])
})

test('executePermissionsRevoke rejects using --all with --rule together', async () => {
    await expect(
        executePermissionsRevoke(
            {
                env: 'dev',
                chain: 'anvil',
                keystorePath: '/tmp/permissions-keystore.json',
                keyHash,
                all: true,
                rule: 'call:0x3333333333333333333333333333333333333333:0x095ea7b3',
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(
                    async () =>
                        ({
                            root: {
                                sessionRef: { active: 'default', dir: 'sessions' },
                                addresses: {
                                    root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                    delegated: accountAddress,
                                },
                            },
                        }) as any,
                ),
                listSessionNames: mock(async () => []),
                readSessionKeystoreFile: mock(async () => ({}) as any),
                getKeys: mock(async () => ({ '0x7a69': [makeKey()] })),
            },
        ),
    ).rejects.toMatchObject({
        code: 'MISSING_ARGUMENT',
        message: 'Provide either --rule or --all, not both.',
    })
})

test('executePermissionsShow derives external address and emits deterministic rule ids', async () => {
    const externalAddress = '0x4444444444444444444444444444444444444444'
    const externalPublicKey = `${externalAddress}${'00'.repeat(12)}`.toLowerCase() as Hex

    const result = await executePermissionsShow(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/permissions-keystore.json',
            keyHash,
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        root: {
                            sessionRef: { active: 'default', dir: 'sessions' },
                            addresses: {
                                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                delegated: accountAddress,
                            },
                        },
                    }) as any,
            ),
            listSessionNames: mock(async () => []),
            readSessionKeystoreFile: mock(async () => ({}) as any),
            getKeys: mock(async () => ({
                '0x7a69': [
                    makeKey({
                        type: 'external',
                        publicKey: externalPublicKey,
                        permissions: [
                            {
                                type: 'call',
                                to: '0x2222222222222222222222222222222222222222',
                                selector: '0xa9059cbb',
                            },
                            {
                                type: 'spend',
                                token: '0x5555555555555555555555555555555555555555',
                                period: 'day',
                                limit: '1000000',
                                spent: '200000',
                            },
                        ],
                    }),
                ],
            })),
        },
    )

    expect(result.key.type).toBe('external')
    expect(result.key.address).toBe(externalAddress)
    expect(result.callPermissions[0]?.id).toBe(
        'call:0x2222222222222222222222222222222222222222:0xa9059cbb',
    )
    expect(result.callPermissions[0]?.hashId).toMatch(/^0x[a-f0-9]{64}$/)
    expect(result.spendLimits[0]?.id).toBe('spend:0x5555555555555555555555555555555555555555:day')
    expect(result.spendLimits[0]?.remainingRaw).toBe('800000')
    expect(result.spendLimits[0]?.hashId).toMatch(/^0x[a-f0-9]{64}$/)
})

test('executePermissionsList returns spend usage summary ids and hashes', async () => {
    const result = await executePermissionsList(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/permissions-keystore.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        root: {
                            sessionRef: { active: 'default', dir: 'sessions' },
                            addresses: {
                                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                delegated: accountAddress,
                            },
                        },
                    }) as any,
            ),
            listSessionNames: mock(async () => []),
            readSessionKeystoreFile: mock(async () => ({}) as any),
            getKeys: mock(async () => ({
                '0x7a69': [
                    makeKey({
                        permissions: [
                            {
                                type: 'spend',
                                token: '0x5555555555555555555555555555555555555555',
                                period: 'day',
                                limit: '900000',
                                spent: '100000',
                            },
                        ],
                    }),
                ],
            })),
        },
    )

    expect(result.keys).toHaveLength(1)
    expect(result.keys[0]?.summary.spendUsage[0]?.id).toBe(
        'spend:0x5555555555555555555555555555555555555555:day',
    )
    expect(result.keys[0]?.summary.spendUsage[0]?.hashId).toMatch(/^0x[a-f0-9]{64}$/)
    expect(result.keys[0]?.summary.spendUsage[0]?.remainingRaw).toBe('800000')
})

test('executePermissionsRevoke surfaces send failure diagnostics', async () => {
    await expect(
        executePermissionsRevoke(
            {
                env: 'dev',
                chain: 'anvil',
                keystorePath: '/tmp/permissions-keystore.json',
                keyHash,
                rule: 'call:0x3333333333333333333333333333333333333333:0x095ea7b3',
                password: 'pw',
                phraseConfirmed: true,
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(
                    async () =>
                        ({
                            root: {
                                sessionRef: { active: 'default', dir: 'sessions' },
                                addresses: {
                                    root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                    delegated: accountAddress,
                                },
                            },
                        }) as any,
                ),
                listSessionNames: mock(async () => []),
                readSessionKeystoreFile: mock(async () => ({}) as any),
                getKeys: mock(async () => ({ '0x7a69': [makeKey()] })),
                decryptRootKeystore: mock(
                    async () => ({ rootPrivateKey: ('0x' + '11'.repeat(32)) as Hex }) as any,
                ),
                readNonce: mock(async () => 10n),
                executeSignedCalls: mock(async () => ({
                    id: 'bundle-failed',
                    finalStatus: {
                        success: false,
                        status: 'failed',
                        statusCode: 500,
                        error: 'execution reverted',
                        receipt: {
                            transactionHash: '0x' + '44'.repeat(32),
                            intentError: {
                                name: 'IntentCallFailed',
                                args: [],
                            },
                        },
                    } as any,
                })),
            },
        ),
    ).rejects.toMatchObject({
        code: 'SEND_FAILED',
        details: {
            statusCode: 500,
            txHash: '0x' + '44'.repeat(32),
        },
    })
})

test('parseRuleId rejects spend:any aliases', () => {
    expect(() => parseRuleId('spend:any:day')).toThrow(
        new PermissionsError('RULE_PARSE_FAILED', 'Invalid spend token in rule id: any'),
    )
})

test('executePermissionsGrant builds setSpendLimit calldata for spend grants', async () => {
    let capturedData: Hex | undefined

    const result = await executePermissionsGrant(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/permissions-keystore.json',
            keyHash,
            grantType: 'spend',
            token: '0x5555555555555555555555555555555555555555',
            spendLimit: 10_000_000n,
            period: 'day',
            password: 'pw',
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readKeystoreBundle: mock(
                async () =>
                    ({
                        root: {
                            sessionRef: { active: 'default', dir: 'sessions' },
                            addresses: {
                                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                delegated: accountAddress,
                            },
                        },
                    }) as any,
            ),
            listSessionNames: mock(async () => []),
            readSessionKeystoreFile: mock(async () => ({}) as any),
            getKeys: mock(async () => ({ '0x7a69': [makeKey()] })),
            decryptRootKeystore: mock(
                async () => ({ rootPrivateKey: '0x' + '11'.repeat(32) }) as any,
            ),
            readNonce: mock(async () => 5n),
            executeSignedCalls: mock(async (_deps, params) => {
                capturedData = params.calls[0]?.data
                return {
                    id: 'bundle-spend',
                    finalStatus: {
                        success: true,
                        status: 'confirmed',
                        statusCode: 200,
                        receipt: { transactionHash: '0x' + '33'.repeat(32) },
                    } as any,
                }
            }),
        },
    )

    expect(result.grantType).toBe('spend')
    expect(capturedData).toBeDefined()

    const decoded = decodeFunctionData({
        abi: accountAbi,
        data: capturedData!,
    })
    expect(decoded.functionName).toBe('setSpendLimit')
})

test('executePermissionsGrant rejects call grant missing target', async () => {
    await expect(
        executePermissionsGrant(
            {
                env: 'dev',
                chain: 'anvil',
                keystorePath: '/tmp/permissions-keystore.json',
                keyHash,
                grantType: 'call',
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(
                    async () =>
                        ({
                            root: {
                                sessionRef: { active: 'default', dir: 'sessions' },
                                addresses: {
                                    root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                    delegated: accountAddress,
                                },
                            },
                        }) as any,
                ),
                listSessionNames: mock(async () => []),
                readSessionKeystoreFile: mock(async () => ({}) as any),
                getKeys: mock(async () => ({ '0x7a69': [makeKey()] })),
            },
        ),
    ).rejects.toMatchObject({
        code: 'MISSING_ARGUMENT',
        message: 'Call grants require --target and --selector.',
    })
})

test('executePermissionsGrant rejects spend grant missing token', async () => {
    await expect(
        executePermissionsGrant(
            {
                env: 'dev',
                chain: 'anvil',
                keystorePath: '/tmp/permissions-keystore.json',
                keyHash,
                grantType: 'spend',
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(
                    async () =>
                        ({
                            root: {
                                sessionRef: { active: 'default', dir: 'sessions' },
                                addresses: {
                                    root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                    delegated: accountAddress,
                                },
                            },
                        }) as any,
                ),
                listSessionNames: mock(async () => []),
                readSessionKeystoreFile: mock(async () => ({}) as any),
                getKeys: mock(async () => ({ '0x7a69': [makeKey()] })),
            },
        ),
    ).rejects.toMatchObject({
        code: 'MISSING_ARGUMENT',
        message: 'Spend grants require --token, --spend-limit, and --period.',
    })
})

test('executePermissionsRevoke --all removes both call and spend rules', async () => {
    const capturedCalls: Hex[] = []

    const keyWithPermissions = makeKey({
        permissions: [
            {
                type: 'call',
                to: '0x3333333333333333333333333333333333333333',
                selector: '0xa9059cbb',
            },
            {
                type: 'spend',
                token: '0x5555555555555555555555555555555555555555',
                period: 'day',
                limit: '1000000',
                spent: '0',
            },
        ],
    })

    const result = await executePermissionsRevoke(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/permissions-keystore.json',
            keyHash,
            all: true,
            password: 'pw',
            phraseConfirmed: true,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readKeystoreBundle: mock(
                async () =>
                    ({
                        root: {
                            sessionRef: { active: 'default', dir: 'sessions' },
                            addresses: {
                                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                delegated: accountAddress,
                            },
                        },
                    }) as any,
            ),
            listSessionNames: mock(async () => []),
            readSessionKeystoreFile: mock(async () => ({}) as any),
            getKeys: mock(async () => ({ '0x7a69': [keyWithPermissions] })),
            decryptRootKeystore: mock(
                async () => ({ rootPrivateKey: '0x' + '11'.repeat(32) }) as any,
            ),
            readNonce: mock(async () => 10n),
            executeSignedCalls: mock(async (_deps, params) => {
                for (const call of params.calls) {
                    capturedCalls.push(call.data)
                }
                return {
                    id: 'bundle-all',
                    finalStatus: {
                        success: true,
                        status: 'confirmed',
                        statusCode: 200,
                    } as any,
                }
            }),
        },
    )

    expect(result.ruleCount).toBe(2)
    expect(capturedCalls).toHaveLength(2)

    const decoded0 = decodeFunctionData({ abi: accountAbi, data: capturedCalls[0]! })
    const decoded1 = decodeFunctionData({ abi: accountAbi, data: capturedCalls[1]! })
    expect(decoded0.functionName).toBe('setCanExecute')
    expect(decoded1.functionName).toBe('removeSpendLimit')
})

test('executePermissionsRevoke returns no-op when key has no permissions and --all is set', async () => {
    const result = await executePermissionsRevoke(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/permissions-keystore.json',
            keyHash,
            all: true,
            password: 'pw',
            phraseConfirmed: true,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readKeystoreBundle: mock(
                async () =>
                    ({
                        root: {
                            sessionRef: { active: 'default', dir: 'sessions' },
                            addresses: {
                                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                delegated: accountAddress,
                            },
                        },
                    }) as any,
            ),
            listSessionNames: mock(async () => []),
            readSessionKeystoreFile: mock(async () => ({}) as any),
            getKeys: mock(async () => ({ '0x7a69': [makeKey()] })),
        },
    )

    expect(result.ruleCount).toBe(0)
    expect(result.bundle.id).toBe('no-op')
})

test('executePermissionsRevoke rejects without --rule or --all', async () => {
    await expect(
        executePermissionsRevoke(
            {
                env: 'dev',
                chain: 'anvil',
                keystorePath: '/tmp/permissions-keystore.json',
                keyHash,
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(
                    async () =>
                        ({
                            root: {
                                sessionRef: { active: 'default', dir: 'sessions' },
                                addresses: {
                                    root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                    delegated: accountAddress,
                                },
                            },
                        }) as any,
                ),
                listSessionNames: mock(async () => []),
                readSessionKeystoreFile: mock(async () => ({}) as any),
                getKeys: mock(async () => ({ '0x7a69': [makeKey()] })),
            },
        ),
    ).rejects.toMatchObject({
        code: 'MISSING_ARGUMENT',
        message: 'Provide --rule or --all.',
    })
})

test('executePermissionsRevoke --rule spend generates removeSpendLimit', async () => {
    let capturedData: Hex | undefined

    const result = await executePermissionsRevoke(
        {
            env: 'dev',
            chain: 'anvil',
            keystorePath: '/tmp/permissions-keystore.json',
            keyHash,
            rule: 'spend:0x5555555555555555555555555555555555555555:day',
            password: 'pw',
            phraseConfirmed: true,
        },
        {
            withKeystoreLock: async (_path, action) => action(),
            readKeystoreBundle: mock(
                async () =>
                    ({
                        root: {
                            sessionRef: { active: 'default', dir: 'sessions' },
                            addresses: {
                                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                delegated: accountAddress,
                            },
                        },
                    }) as any,
            ),
            listSessionNames: mock(async () => []),
            readSessionKeystoreFile: mock(async () => ({}) as any),
            getKeys: mock(async () => ({ '0x7a69': [makeKey()] })),
            decryptRootKeystore: mock(
                async () => ({ rootPrivateKey: '0x' + '11'.repeat(32) }) as any,
            ),
            readNonce: mock(async () => 10n),
            executeSignedCalls: mock(async (_deps, params) => {
                capturedData = params.calls[0]?.data
                return {
                    id: 'bundle-spend-revoke',
                    finalStatus: {
                        success: true,
                        status: 'confirmed',
                        statusCode: 200,
                    } as any,
                }
            }),
        },
    )

    expect(result.ruleCount).toBe(1)
    const decoded = decodeFunctionData({ abi: accountAbi, data: capturedData! })
    expect(decoded.functionName).toBe('removeSpendLimit')
})

test('executePermissionsRevoke rejects admin key', async () => {
    await expect(
        executePermissionsRevoke(
            {
                env: 'dev',
                chain: 'anvil',
                keystorePath: '/tmp/permissions-keystore.json',
                keyHash,
                all: true,
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(
                    async () =>
                        ({
                            root: {
                                sessionRef: { active: 'default', dir: 'sessions' },
                                addresses: {
                                    root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                    delegated: accountAddress,
                                },
                            },
                        }) as any,
                ),
                listSessionNames: mock(async () => []),
                readSessionKeystoreFile: mock(async () => ({}) as any),
                getKeys: mock(async () => ({ '0x7a69': [makeKey({ role: 'admin' })] })),
            },
        ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FOR_ADMIN_KEY' })
})
