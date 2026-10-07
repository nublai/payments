import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signedPaymentMaxForQuote } from '@nubl/relayer-client'
import { accountAbi } from '@nubl/contracts/abis'
import { getDefaultSessionPermissions } from '../src/lib/account-create'
import { executeSignedCalls } from '../src/lib/execute-calls'
import { PAID_FEE_CAP } from '../src/lib/intent-payment'
import { executeSessionRotate, sealRotationMarker } from '../src/lib/session-rotate'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { matchingPreparedCalls } from './helpers/matching-prepared'
import { installFormerStageDeployments } from './helpers/former-deployment-env'

const account = '0x1111111111111111111111111111111111111111' as Address
const oldSessionKey = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex
const newSessionKey = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex
const oldAddress = privateKeyToAccount(oldSessionKey).address
const newAddress = privateKeyToAccount(newSessionKey).address
const rootPrivateKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

const anvilDeployEnv = {
    ORCHESTRATOR_31337: '0x2222222222222222222222222222222222222222',
    SIMPLE_FUNDER_31337: '0x0000000000000000000000000000000000000004',
    SIMULATOR_31337: '0x0000000000000000000000000000000000000005',
    ACCOUNT_31337: '0x0000000000000000000000000000000000000003',
    ACCOUNT_PROXY_31337: '0x1111111111111111111111111111111111111111',
    SIMPLE_SETTLER_31337: '0x5386d1026e1598177e03eA52cbF1a0994ADF5eaE',
    ESCROW_31337: '0x05f9597eed844410b7c0746A1C584188d0644730',
    MULTI_SIG_SIGNER_31337: '0x0000000000000000000000000000000000000008',
}

function useAnvilDeployments(): () => void {
    const previous: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(anvilDeployEnv)) {
        previous[key] = process.env[key]
        process.env[key] = value
    }
    return () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

test('executeSessionRotate --narrow revokes the old key and installs the narrow default', async () => {
    const restore = useAnvilDeployments()
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
                env: 'dev',
                chain: 'anvil',
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
                decryptSessionKeystore: mock(async (keystore: { addresses: { session: string } }) => {
                    const session = getAddress(keystore.addresses.session as Address)
                    if (session === newAddress) return { sessionPrivateKey: newSessionKey }
                    return { sessionPrivateKey: oldSessionKey }
                }),
                readNonce: mock(async () => 1n),
                readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                readActiveUsdcDaily: mock(async () => 0n),
                getKeys: mock(async () => ({
                    '0x7a69': [{ hash: computeSessionKeyHash(newAddress) }],
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

        const expected = getDefaultSessionPermissions(31337, { env: 'dev' }).filter(
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
        expect(() => getDefaultSessionPermissions(8453, { env: 'prod' })).toThrow(/not deployed/)
    } finally {
        restore()
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
        decryptSessionKeystore: mock(async (keystore: { addresses: { session: string } }) => {
            const session = getAddress(keystore.addresses.session as Address)
            if (session === newAddress) return { sessionPrivateKey: newSessionKey }
            return { sessionPrivateKey: oldSessionKey }
        }),
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
    const restore = useAnvilDeployments()
    const captured: Hex[] = []
    try {
        await executeSessionRotate(
            {
                env: 'dev',
                chain: 'anvil',
                keystorePath: '/tmp/narrow-rotate-clear.json',
                password: 'pw',
                narrow: true,
                newName: 'default-next',
                fullAccessPhraseConfirmed: true,
            },
            rotateDeps({
                getKeys: mock(async () => ({
                    '0x7a69': [{ hash: computeSessionKeyHash(newAddress) }],
                })),
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
        restore()
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

const POLYGON_CHAIN_ID = 137
const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as Address
const PLANTED_TARGET = '0x4444444444444444444444444444444444444444' as Address
const PLANTED_SELECTOR = '0x39509351' as Hex

test('extra-chain cleanup resolves the fee policy for that chain', async () => {
    const previous = process.env.RELAYER_URL_STAGE
    process.env.RELAYER_URL_STAGE = 'http://127.0.0.1:8787'
    const restoreStage = installFormerStageDeployments()
    const prepares: {
        chainId: number
        payer?: Address
        paymentToken?: Address
        paymentMaxAmount?: bigint
        calls: { data: Hex }[]
    }[] = []
    try {
        const result = await executeSessionRotate(
            {
                env: 'stage',
                chain: 'base',
                keystorePath: '/tmp/narrow-rotate-extra-chain.json',
                password: 'pw',
                narrow: true,
                newName: 'default-next',
            },
            rotateDeps({
                getKeys: mock(async () => ({
                    '0x2105': [{ hash: computeSessionKeyHash(newAddress) }],
                })),
                readGuardCleanup: mock(async (input: { chainId: number }) => {
                    if (input.chainId !== POLYGON_CHAIN_ID) return { anyCalls: [], checkers: [] }
                    return {
                        anyCalls: [{ target: PLANTED_TARGET, selector: PLANTED_SELECTOR }],
                        checkers: [],
                    }
                }),
                executeSignedCalls,
                prepareCalls: mock(async (input: {
                    network: { chainId: number }
                    from: Address
                    calls: { target: Address; value: bigint; data: Hex }[]
                    nonce: bigint
                    expiry?: bigint
                    payer?: Address
                    paymentToken?: Address
                    paymentMaxAmount?: bigint
                }) => {
                    prepares.push({
                        chainId: input.network.chainId,
                        payer: input.payer,
                        paymentToken: input.paymentToken,
                        paymentMaxAmount: input.paymentMaxAmount,
                        calls: input.calls,
                    })
                    return matchingPreparedCalls({
                        from: input.from,
                        calls: input.calls,
                        nonce: input.nonce,
                        network: { env: 'stage', chainId: input.network.chainId },
                        expiry: input.expiry,
                        payer: input.payer,
                        paymentToken: input.paymentToken,
                        paymentMaxAmount: input.paymentMaxAmount,
                    })
                }),
                signTypedData: mock(async () => rootPrivateKey),
                sendPreparedCalls: mock(async () => ({ id: 'bundle-extra-chain' })),
                waitForBundle: mock(async () => ({
                    success: true,
                    statusCode: 200,
                    status: 'confirmed',
                    receipt: {
                        transactionHash:
                            '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
                    },
                })),
            }) as never,
        )

        expect(result.status).toBe('complete')
        const polygon = prepares.filter((prepare) => prepare.chainId === POLYGON_CHAIN_ID)
        expect(polygon.length).toBeGreaterThan(0)
        expect(polygon[0]?.payer).toBe(account)
        expect(polygon[0]?.paymentToken).toBe(POLYGON_USDC)
        expect(polygon[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP)
        expect(polygon[1]?.paymentMaxAmount).toBe(signedPaymentMaxForQuote(1n))
        const decoded = decodeFunctionData({
            abi: accountAbi,
            data: polygon[0]!.calls[0]!.data,
        })
        expect(decoded.functionName).toBe('setCanExecute')
        expect(decoded.args[0]).toBe(ANY_KEYHASH)
        expect(String(decoded.args[1]).toLowerCase()).toBe(PLANTED_TARGET.toLowerCase())
        expect(decoded.args[2]).toBe(PLANTED_SELECTOR)
        expect(decoded.args[3]).toBe(false)
    } finally {
        restoreStage()
        if (previous === undefined) delete process.env.RELAYER_URL_STAGE
        else process.env.RELAYER_URL_STAGE = previous
    }
})

function partialRotateHarness(mode: 'status' | 'throw') {
    const unlinked: string[] = []
    let savedIntent: Record<string, unknown> | null = null
    let polygonSucceeds = false
    let readOld = true
    const oldSession = {
        addresses: { session: oldAddress, delegated: account },
        name: 'default',
    }
    const newSession = {
        addresses: { session: newAddress, delegated: account },
        name: 'default-next',
        checkpoint: 'pending_rotation',
    }
    const prepares: { chainId: number }[] = []
    const deps = rotateDeps({
        getKeys: mock(async () => ({
            '0x2105': [{ hash: computeSessionKeyHash(newAddress) }],
        })),
        readRotationIntent: mock(async () => savedIntent),
        writeRotationIntent: mock(async (_root: string, _dir: string, value: object, fileName?: string) => {
            savedIntent = { ...value, fileName: fileName ?? 'rotation.json' }
            return savedIntent
        }),
        readSessionKeystoreFile: mock(async () => {
            if (readOld) {
                readOld = false
                return oldSession
            }
            return newSession
        }),
        unlink: mock(async (path: string) => {
            unlinked.push(path)
        }),
        readGuardCleanup: mock(async (input: { chainId: number }) => {
            if (input.chainId !== POLYGON_CHAIN_ID) return { anyCalls: [], checkers: [] }
            return {
                anyCalls: [{ target: PLANTED_TARGET, selector: PLANTED_SELECTOR }],
                checkers: [],
            }
        }),
        executeSignedCalls,
        prepareCalls: mock(async (input: {
            network: { chainId: number }
            from: Address
            calls: { target: Address; value: bigint; data: Hex }[]
            nonce: bigint
            expiry?: bigint
            payer?: Address
            paymentToken?: Address
            paymentMaxAmount?: bigint
        }) => {
            prepares.push({ chainId: input.network.chainId })
            return matchingPreparedCalls({
                from: input.from,
                calls: input.calls,
                nonce: input.nonce,
                network: { env: 'stage', chainId: input.network.chainId },
                expiry: input.expiry,
                payer: input.payer,
                paymentToken: input.paymentToken,
                paymentMaxAmount: input.paymentMaxAmount,
            })
        }),
        signTypedData: mock(async () => rootPrivateKey),
        sendPreparedCalls: mock(async () => ({ id: 'bundle-partial' })),
        waitForBundle: mock(async (input: { network: { chainId: number } }) => {
            if (input.network.chainId === POLYGON_CHAIN_ID && !polygonSucceeds) {
                if (mode === 'throw') throw new Error('extra chain rpc down')
                return {
                    success: false,
                    statusCode: 500,
                    status: 'failed',
                    error: 'polygon cleanup reverted',
                }
            }
            return {
                success: true,
                statusCode: 200,
                status: 'confirmed',
                receipt: {
                    transactionHash:
                        '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
                },
            }
        }),
    })
    const options = {
        env: 'stage' as const,
        chain: 'base' as const,
        keystorePath: '/tmp/narrow-rotate-partial.json',
        password: 'pw',
        narrow: true,
        newName: 'default-next',
    }
    return {
        deps,
        options,
        unlinked,
        prepares,
        resetRead() {
            readOld = true
        },
        allowPolygon() {
            polygonSucceeds = true
        },
    }
}

test('a failed extra-chain bundle is a partial rotation and keeps both session files', async () => {
    const previous = process.env.RELAYER_URL_STAGE
    process.env.RELAYER_URL_STAGE = 'http://127.0.0.1:8787'
    const restoreStage = installFormerStageDeployments()
    const harness = partialRotateHarness('status')
    try {
        await expect(
            executeSessionRotate(harness.options, harness.deps as never),
        ).rejects.toMatchObject({
            code: 'ROTATION_PARTIAL',
            details: { chains: ['polygon'] },
        })
        expect(harness.unlinked.some((path) => path.includes('default-next'))).toBe(false)
        expect(harness.unlinked.some((path) => path.endsWith('default.json'))).toBe(false)
    } finally {
        restoreStage()
        if (previous === undefined) delete process.env.RELAYER_URL_STAGE
        else process.env.RELAYER_URL_STAGE = previous
    }
})

test('a thrown extra-chain wait keeps the new session file', async () => {
    const previous = process.env.RELAYER_URL_STAGE
    process.env.RELAYER_URL_STAGE = 'http://127.0.0.1:8787'
    const restoreStage = installFormerStageDeployments()
    const harness = partialRotateHarness('throw')
    try {
        await expect(
            executeSessionRotate(harness.options, harness.deps as never),
        ).rejects.toMatchObject({
            code: 'ROTATION_PARTIAL',
            details: { chains: ['polygon'] },
        })
        expect(harness.unlinked.some((path) => path.includes('default-next'))).toBe(false)
    } finally {
        restoreStage()
        if (previous === undefined) delete process.env.RELAYER_URL_STAGE
        else process.env.RELAYER_URL_STAGE = previous
    }
})

test('resuming a partial rotation finishes the extra-chain cleanup', async () => {
    const previous = process.env.RELAYER_URL_STAGE
    process.env.RELAYER_URL_STAGE = 'http://127.0.0.1:8787'
    const restoreStage = installFormerStageDeployments()
    const harness = partialRotateHarness('status')
    try {
        await expect(
            executeSessionRotate(harness.options, harness.deps as never),
        ).rejects.toMatchObject({ code: 'ROTATION_PARTIAL' })
        expect(harness.unlinked.some((path) => path.includes('default-next'))).toBe(false)
        const polygonBefore = harness.prepares.filter((prepare) => prepare.chainId === POLYGON_CHAIN_ID).length
        harness.allowPolygon()
        harness.resetRead()
        const result = await executeSessionRotate(
            { ...harness.options, resume: true },
            harness.deps as never,
        )
        expect(result.status).toBe('complete')
        expect(harness.prepares.filter((prepare) => prepare.chainId === POLYGON_CHAIN_ID).length).toBeGreaterThan(
            polygonBefore,
        )
        expect(harness.unlinked.some((path) => path.includes('default-next'))).toBe(false)
    } finally {
        restoreStage()
        if (previous === undefined) delete process.env.RELAYER_URL_STAGE
        else process.env.RELAYER_URL_STAGE = previous
    }
})

const attacker = '0x4444444444444444444444444444444444444444' as Address

function stageEnv<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.RELAYER_URL_STAGE
    process.env.RELAYER_URL_STAGE = 'http://127.0.0.1:8787'
    const restoreStage = installFormerStageDeployments()
    return fn().finally(() => {
        restoreStage()
        if (previous === undefined) delete process.env.RELAYER_URL_STAGE
        else process.env.RELAYER_URL_STAGE = previous
    })
}

test('resume after a successful rotation does not start another rotation', async () => {
    await stageEnv(async () => {
        let intent: Record<string, unknown> | null = null
        const signed: string[] = []
        const deps = rotateDeps({
            getKeys: mock(async () => ({
                '0x2105': [{ hash: computeSessionKeyHash(newAddress) }],
            })),
            readRotationIntent: mock(async () => intent),
            writeRotationIntent: mock(async (_root: string, _dir: string, value: object, fileName?: string) => {
                intent = { ...value, fileName: fileName ?? '.rotation.json' }
                return intent
            }),
            deleteRotationIntent: mock(async () => {
                intent = null
            }),
            executeSignedCalls: mock(async () => {
                signed.push('authorize')
                return {
                    id: 'bundle-once',
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
        })
        const first = await executeSessionRotate(
            {
                env: 'stage',
                chain: 'base',
                keystorePath: '/tmp/resume-noop.json',
                password: 'pw',
                narrow: true,
                newName: 'default-next',
            },
            deps as never,
        )
        expect(first.status).toBe('complete')
        expect(signed).toEqual(['authorize'])
        const again = await executeSessionRotate(
            {
                env: 'stage',
                chain: 'base',
                keystorePath: '/tmp/resume-noop.json',
                password: 'pw',
                resume: true,
            },
            deps as never,
        )
        expect(again.resumed).toBe(true)
        expect(again.newSessionName).toBe(again.oldSessionName)
        expect(signed).toEqual(['authorize'])
    })
})

test('a tampered pending marker is not authorized', async () => {
    await stageEnv(async () => {
        const signed: Hex[] = []
        let reads = 0
        const deps = rotateDeps({
            readRotationIntent: mock(async () => ({
                oldSessionName: 'default',
                newSessionName: 'attacker',
                status: 'pending',
                fileName: '.rotation-9000.json',
                chain: 'base',
                chainId: 8453,
                newKeyHash: computeSessionKeyHash(attacker),
                narrow: true,
                fullAccess: false,
                account,
                oldKeyHash: computeSessionKeyHash(oldAddress),
                permissions: { kind: 'narrow' },
            })),
            readSessionKeystoreFile: mock(async () => {
                reads += 1
                if (reads === 1) {
                    return {
                        addresses: { session: oldAddress, delegated: account },
                        name: 'default',
                    }
                }
                return {
                    addresses: { session: attacker, delegated: account },
                    name: 'attacker',
                }
            }),
            getKeys: mock(async () => ({
                '0x2105': [{ hash: computeSessionKeyHash(newAddress) }],
            })),
            executeSignedCalls: mock(async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                for (const call of params.calls) signed.push(call.data)
                return {
                    id: 'bundle-tamper',
                    finalStatus: { success: true, statusCode: 200, status: 'confirmed' },
                }
            }),
        })
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath: '/tmp/tamper-rotate.json',
                    password: 'pw',
                    resume: true,
                },
                deps as never,
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_MARKER_MISMATCH' })
        expect(signed).toEqual([])
    })
})

test('two rotation markers are refused instead of using the lexicographic last', async () => {
    await stageEnv(async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'rotation-markers-'))
        const sessions = join(rootDir, 'sessions')
        await mkdir(sessions)
        const marker = {
            oldSessionName: 'default',
            newSessionName: 'default-next',
            chain: 'base',
            chainId: 8453,
            newKeyHash: computeSessionKeyHash(newAddress),
            narrow: true,
            fullAccess: false,
        }
        await writeFile(
            join(sessions, '.rotation-2000.json'),
            `${JSON.stringify({ ...marker, status: 'submitted', bundleId: 'legit' })}\n`,
        )
        await writeFile(
            join(sessions, '.rotation-9000.json'),
            `${JSON.stringify({
                ...marker,
                newSessionName: 'attacker',
                newKeyHash: computeSessionKeyHash(attacker),
                status: 'pending',
            })}\n`,
        )
        const signed: string[] = []
        const { readRotationIntent: _ignored, ...deps } = rotateDeps({
            readKeystoreBundle: mock(async () => ({
                root: {
                    addresses: { root: account, delegated: account },
                    sessionRef: { active: 'default', dir: 'sessions' },
                },
            })),
            executeSignedCalls: mock(async () => {
                signed.push('signed')
                return {
                    id: 'bundle-lex',
                    finalStatus: { success: true, statusCode: 200, status: 'confirmed' },
                }
            }),
        })
        void _ignored
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath: join(rootDir, 'alice.json'),
                    password: 'pw',
                    resume: true,
                },
                deps as never,
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_MARKER_AMBIGUOUS' })
        expect(signed).toEqual([])
    })
})

test('resume --chain refuses a marker for a different chain', async () => {
    await stageEnv(async () => {
        const signed: string[] = []
        const deps = rotateDeps({
            readRotationIntent: mock(async () => ({
                oldSessionName: 'default',
                newSessionName: 'default-next',
                status: 'submitted',
                bundleId: 'bundle-base',
                fileName: '.rotation.json',
                chain: 'base',
                chainId: 8453,
                newKeyHash: computeSessionKeyHash(newAddress),
                narrow: true,
                fullAccess: false,
            })),
            getKeys: mock(async () => ({
                '0x89': [{ hash: computeSessionKeyHash(newAddress) }],
                '0x2105': [{ hash: computeSessionKeyHash(newAddress) }],
            })),
            waitForBundle: mock(async () => ({
                success: true,
                statusCode: 200,
                status: 'confirmed',
                receipt: {
                    transactionHash:
                        '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
                },
            })),
            executeSignedCalls: mock(async () => {
                signed.push('signed')
                return {
                    id: 'bundle-wrong-chain',
                    finalStatus: { success: true, statusCode: 200, status: 'confirmed' },
                }
            }),
        })
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'polygon',
                    keystorePath: '/tmp/wrong-chain-rotate.json',
                    password: 'pw',
                    resume: true,
                },
                deps as never,
            ),
        ).rejects.toMatchObject({
            code: 'ROTATION_WRONG_CHAIN',
            details: { markerChain: 'base', requestedChain: 'polygon' },
        })
        expect(signed).toEqual([])
    })
})

test('a submitted resume re-reads the daily USDC total under the lock', async () => {
    await stageEnv(async () => {
        const daily = mock(async () => 0n)
        const deps = rotateDeps({
            getKeys: mock(async () => ({
                '0x2105': [{ hash: computeSessionKeyHash(newAddress) }],
            })),
            readRotationIntent: mock(async () => ({
                ...(await sealRotationMarker(
                    {
                        oldSessionName: 'default',
                        newSessionName: 'default-next',
                        status: 'submitted',
                        bundleId: 'bundle-base',
                        chain: 'base',
                        chainId: 8453,
                        newKeyHash: computeSessionKeyHash(newAddress),
                        narrow: true,
                        fullAccess: false,
                        account,
                        oldKeyHash: computeSessionKeyHash(oldAddress),
                        permissions: { kind: 'narrow' },
                    },
                    'pw',
                )),
                fileName: '.rotation.json',
            })),
            readActiveUsdcDaily: daily,
            waitForBundle: mock(async () => ({
                success: true,
                statusCode: 200,
                status: 'confirmed',
                receipt: {
                    transactionHash:
                        '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
                },
            })),
            readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
        })
        const result = await executeSessionRotate(
            {
                env: 'stage',
                chain: 'base',
                keystorePath: '/tmp/daily-resume.json',
                password: 'pw',
                resume: true,
                narrow: true,
            },
            deps as never,
        )
        expect(result.status).toBe('complete')
        expect(daily).toHaveBeenCalled()
    })
})
