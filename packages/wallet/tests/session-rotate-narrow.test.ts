import { expect, mock, test } from 'bun:test'
import { decodeFunctionData, type Address, type Hex } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import { getDefaultSessionPermissions } from '../src/lib/account-create'
import { executeSessionRotate } from '../src/lib/session-rotate'
import { computeSessionKeyHash } from '../src/lib/session-common'

const account = '0x1111111111111111111111111111111111111111' as Address
const oldAddress = '0x2222222222222222222222222222222222222222' as Address
const newAddress = '0x3333333333333333333333333333333333333333' as Address
const rootPrivateKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

test('executeSessionRotate --narrow revokes the old key and installs the narrow default', async () => {
    const previous = process.env.RELAYER_URL_PROD
    process.env.RELAYER_URL_PROD = 'http://127.0.0.1:9'
    const captured: Hex[] = []
    const oldSession = {
        addresses: { session: oldAddress, delegated: account },
        name: 'default',
    }
    const newSession = {
        addresses: { session: newAddress, delegated: account },
        name: 'default-next',
        checkpoint: 'pending_rotation',
    }
    let reads = 0
    try {
        const result = await executeSessionRotate(
            {
                env: 'prod',
                chain: 'base',
                keystorePath: '/tmp/narrow-rotate.json',
                password: 'pw',
                narrow: true,
                newName: 'default-next',
            },
            {
                withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                readKeystoreBundle: mock(async () => ({
                    root: {
                        addresses: { root: account, delegated: account },
                        sessionRef: { active: 'default', dir: 'sessions' },
                    },
                    session: oldSession,
                })),
                readSessionKeystoreFile: mock(async () => {
                    reads += 1
                    return reads === 1 ? oldSession : newSession
                }),
                readRotationIntent: mock(async () => null),
                createSessionKeystore: mock(async () => newSession),
                writeSessionKeystoreFile: mock(async () => {}),
                writeRootKeystoreFile: mock(async () => {}),
                writeRotationIntent: mock(
                    async (_root: string, _dir: string, value: object, fileName?: string) => ({
                        ...value,
                        fileName: fileName ?? 'rotation.json',
                    }),
                ),
                deleteRotationIntent: mock(async () => {}),
                unlink: mock(async () => {}),
                generatePrivateKey: mock(() => rootPrivateKey),
                decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                readNonce: mock(async () => 1n),
                readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                readActiveUsdcDaily: mock(async () => 0n),
                getKeys: mock(async () => ({
                    '0x2105': [{ hash: computeSessionKeyHash(newAddress) }],
                })),
                executeSignedCalls: mock(async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                    for (const call of params.calls) captured.push(call.data)
                    return {
                        id: 'bundle-narrow',
                        finalStatus: {
                            success: true,
                            statusCode: 200,
                            status: 'confirmed',
                            receipt: {
                                transactionHash:
                                    '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
                            },
                        },
                    }
                }),
                prepareCalls: mock(async () => {
                    throw new Error('prepareCalls should not run')
                }),
                signTypedData: mock(async () => {
                    throw new Error('signTypedData should not run')
                }),
                sendPreparedCalls: mock(async () => {
                    throw new Error('sendPreparedCalls should not run')
                }),
                waitForBundle: mock(async () => {
                    throw new Error('waitForBundle should not run')
                }),
            } as never,
        )

        expect(result.status).toBe('complete')
        expect(result.oldSessionName).toBe('default')
        expect(result.newSessionName).toBe('default-next')

        const decoded = captured.map((data) =>
            decodeFunctionData({ abi: accountAbi, data }),
        )
        const revoked = decoded.find((entry) => entry.functionName === 'revoke')
        expect(revoked?.args[0]).toBe(computeSessionKeyHash(oldAddress))

        const expected = getDefaultSessionPermissions(8453, { env: 'prod' }).filter(
            (permission) => permission.type === 'call',
        )
        const installed = decoded
            .filter((entry) => entry.functionName === 'setCanExecute')
            .map((entry) => ({
                to: String(entry.args[1]).toLowerCase(),
                selector: String(entry.args[2]).toLowerCase(),
            }))
        expect(installed).toEqual(
            expected.map((permission) => ({
                to: permission.to.toLowerCase(),
                selector: permission.selector.toLowerCase(),
            })),
        )
        const serialized = captured.join(',')
        expect(serialized.toLowerCase()).not.toContain('3232323232323232323232323232323232323232')
        expect(serialized.toLowerCase()).not.toContain('32323232')
        const spend = decoded.find((entry) => entry.functionName === 'setSpendLimit')
        expect(spend?.args[2]).toBe(2)
        expect(spend?.args[3]).toBe(10_000_000n)
    } finally {
        if (previous === undefined) delete process.env.RELAYER_URL_PROD
        else process.env.RELAYER_URL_PROD = previous
    }
})

const ANY_KEYHASH =
    '0x3232323232323232323232323232323232323232323232323232323232323232' as Hex

function rotateDeps(overrides: Record<string, unknown>) {
    const oldSession = {
        addresses: { session: oldAddress, delegated: account },
        name: 'default',
    }
    const newSession = {
        addresses: { session: newAddress, delegated: account },
        name: 'default-next',
        checkpoint: 'pending_rotation',
    }
    let reads = 0
    return {
        withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
        readKeystoreBundle: mock(async () => ({
            root: {
                addresses: { root: account, delegated: account },
                sessionRef: { active: 'default', dir: 'sessions' },
            },
            session: oldSession,
        })),
        readSessionKeystoreFile: mock(async () => {
            reads += 1
            return reads === 1 ? oldSession : newSession
        }),
        readRotationIntent: mock(async () => null),
        createSessionKeystore: mock(async () => newSession),
        writeSessionKeystoreFile: mock(async () => {}),
        writeRootKeystoreFile: mock(async () => {}),
        writeRotationIntent: mock(async (_root: string, _dir: string, value: object, fileName?: string) => ({
            ...value,
            fileName: fileName ?? 'rotation.json',
        })),
        deleteRotationIntent: mock(async () => {}),
        unlink: mock(async () => {}),
        generatePrivateKey: mock(() => rootPrivateKey),
        decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
        readNonce: mock(async () => 1n),
        getKeys: mock(async () => ({
            '0x2105': [{ hash: computeSessionKeyHash(newAddress) }],
        })),
        executeSignedCalls: mock(async () => ({
            id: 'bundle-narrow',
            finalStatus: {
                success: true,
                statusCode: 200,
                status: 'confirmed',
                receipt: {
                    transactionHash:
                        '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
                },
            },
        })),
        prepareCalls: mock(async () => {
            throw new Error('prepareCalls should not run')
        }),
        signTypedData: mock(async () => {
            throw new Error('signTypedData should not run')
        }),
        sendPreparedCalls: mock(async () => {
            throw new Error('sendPreparedCalls should not run')
        }),
        waitForBundle: mock(async () => {
            throw new Error('waitForBundle should not run')
        }),
        readActiveUsdcDaily: mock(async () => 0n),
        readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
        ...overrides,
    }
}

test('executeSessionRotate --narrow clears ANY_KEYHASH calls and call checkers', async () => {
    const previous = process.env.RELAYER_URL_PROD
    process.env.RELAYER_URL_PROD = 'http://127.0.0.1:9'
    const captured: Hex[] = []
    try {
        await executeSessionRotate(
            {
                env: 'prod',
                chain: 'base',
                keystorePath: '/tmp/narrow-rotate-clear.json',
                password: 'pw',
                narrow: true,
                newName: 'default-next',
                fullAccessPhraseConfirmed: true,
            },
            rotateDeps({
                readGuardCleanup: mock(async () => ({
                    anyCalls: [
                        {
                            target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
                            selector: '0x39509351' as Hex,
                        },
                    ],
                    checkers: [
                        {
                            keyHash: ANY_KEYHASH,
                            target: '0x4444444444444444444444444444444444444444' as Address,
                        },
                        {
                            keyHash: computeSessionKeyHash(oldAddress),
                            target: '0x5555555555555555555555555555555555555555' as Address,
                        },
                    ],
                })),
                executeSignedCalls: mock(async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                    for (const call of params.calls) captured.push(call.data)
                    return {
                        id: 'bundle-clear',
                        finalStatus: {
                            success: true,
                            statusCode: 200,
                            status: 'confirmed',
                            receipt: {
                                transactionHash:
                                    '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
                            },
                        },
                    }
                }),
            }) as never,
        )
        const decoded = captured.map((data) => decodeFunctionData({ abi: accountAbi, data }))
        const cleared = decoded.find(
            (entry) =>
                entry.functionName === 'setCanExecute' &&
                String(entry.args[0]).toLowerCase() === ANY_KEYHASH.toLowerCase() &&
                entry.args[3] === false,
        )
        expect(cleared?.args[2]).toBe('0x39509351')
        const checkers = decoded.filter((entry) => entry.functionName === 'setCallChecker')
        expect(checkers.length).toBeGreaterThanOrEqual(2)
        expect(checkers.every((entry) => entry.args[2] === '0x0000000000000000000000000000000000000000')).toBe(
            true,
        )
    } finally {
        if (previous === undefined) delete process.env.RELAYER_URL_PROD
        else process.env.RELAYER_URL_PROD = previous
    }
})

test('session rotate re-reads the daily USDC sum inside the keystore lock', async () => {
    const previous = process.env.RELAYER_URL_PROD
    process.env.RELAYER_URL_PROD = 'http://127.0.0.1:9'
    let locked = false
    let signed = false
    try {
        await expect(
            executeSessionRotate(
                {
                    env: 'prod',
                    chain: 'base',
                    keystorePath: '/tmp/rotate-lock.json',
                    password: 'pw',
                    newName: 'default-next',
                },
                rotateDeps({
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => {
                        locked = true
                        try {
                            return await fn()
                        } finally {
                            locked = false
                        }
                    },
                    readActiveUsdcDaily: mock(async () => {
                        expect(locked).toBe(true)
                        return 10_000_000n
                    }),
                    executeSignedCalls: mock(async () => {
                        signed = true
                        throw new Error('should not send')
                    }),
                }) as never,
            ),
        ).rejects.toThrow(/ROTATE FULL ACCESS SESSION/)
        expect(signed).toBe(false)
    } finally {
        if (previous === undefined) delete process.env.RELAYER_URL_PROD
        else process.env.RELAYER_URL_PROD = previous
    }
})
