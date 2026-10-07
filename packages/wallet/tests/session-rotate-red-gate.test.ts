/**
 * Regression tests for the PR 25 final gate at e39b23c.
 * Assertions describe the fixed behavior, so they fail on that head.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { accountAbi } from '@nubl/contracts/abis'
import { executeSignedCalls } from '../src/lib/execute-calls'
import { executeSessionRotate, sealRotationMarker } from '../src/lib/session-rotate'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { installFormerProdDeployments, installFormerStageDeployments } from './helpers/former-deployment-env'
import { matchingPreparedCalls } from './helpers/matching-prepared'
import type { Call } from '@nubl/relayer-client'

const account = '0x1111111111111111111111111111111111111111' as Address
const oldKey = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex
const newKey = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex
const attackerKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const siblingKey = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex
const rootPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const oldAddress = privateKeyToAccount(oldKey).address
const newAddress = privateKeyToAccount(newKey).address
const attackerAddress = privateKeyToAccount(attackerKey).address
const siblingAddress = privateKeyToAccount(siblingKey).address
const wrongAddress = '0x5555555555555555555555555555555555555555' as Address
const approveSelector = '0x095ea7b3' as Hex
const transferSelector = '0xa9059cbb' as Hex
const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

const keysByAddress: Record<string, Hex> = {
    [oldAddress.toLowerCase()]: oldKey,
    [newAddress.toLowerCase()]: newKey,
    [attackerAddress.toLowerCase()]: attackerKey,
    [siblingAddress.toLowerCase()]: siblingKey,
}

function sessionDocument(name: string, session: Address, delegated: Address = account) {
    return {
        version: 2,
        createdAt: '2020-01-01T00:00:00.000Z',
        name,
        checkpoint: 'authorized',
        network: {
            env: 'stage',
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
        addresses: { session, delegated },
        secrets: {
            sessionPrivateKey: {
                nonce: 'bm9uY2U=',
                ciphertext: 'not-a-real-key',
                tag: 'dGFn',
            },
        },
    }
}

function decryptMatching() {
    return mock(async (keystore: { addresses: { session: string } }) => {
        const key = keysByAddress[getAddress(keystore.addresses.session).toLowerCase()]
        if (!key) {
            return { sessionPrivateKey: oldKey }
        }
        return { sessionPrivateKey: key }
    })
}

async function stageDir(prefix: string) {
    const root = await mkdtemp(join(tmpdir(), prefix))
    const sessions = join(root, 'sessions')
    await mkdir(sessions, { recursive: true })
    return { root, sessions, keystorePath: join(root, 'alice.json') }
}

async function withStage<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.RELAYER_URL_STAGE
    process.env.RELAYER_URL_STAGE = 'http://127.0.0.1:8787'
    // Published JSON is zero. Stage rotations resolve the orchestrator from
    // ORCHESTRATOR_<chainId> for this test only.
    const restoreStage = installFormerStageDeployments()
    try {
        return await fn()
    } finally {
        restoreStage()
        if (previous === undefined) delete process.env.RELAYER_URL_STAGE
        else process.env.RELAYER_URL_STAGE = previous
    }
}

function rootBundle(active = 'default') {
    return {
        root: {
            addresses: { root: account, delegated: account },
            sessionRef: { active, dir: 'sessions' },
            network: sessionDocument('default', oldAddress).network,
            createdAt: '2020-01-01T00:00:00.000Z',
            checkpoint: 'delegated',
        },
        session: sessionDocument('default', oldAddress),
    }
}

type PreparedInput = {
    network: { chainId: number; env: 'stage' }
    from: Address
    calls: Call[]
    nonce: bigint
    expiry?: bigint
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: bigint
}

function quotePreparer(captured: PreparedInput[]) {
    return mock(async (input: PreparedInput) => {
        captured.push(input)
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
    })
}

function decodeCalls(calls: Call[]) {
    return calls.map((call) => ({
        target: call.target,
        decoded: decodeFunctionData({ abi: accountAbi, data: call.data }),
    }))
}

function confirmedStatus() {
    return {
        success: true,
        statusCode: 200,
        status: 'confirmed',
        receipt: {
            transactionHash: '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca' as Hex,
        },
    }
}

test('a status-poll failure after send keeps the new key and resume is not a noop', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('rotate-crash-')
        await writeFile(
            join(sessions, 'default.json'),
            `${JSON.stringify(sessionDocument('default', oldAddress), null, 2)}\n`,
        )
        const prepares: PreparedInput[] = []
        const sent: { id: string }[] = []
        const statusError = new Error(
            'Failed to get bundle status: HTTP error: 500 Internal Server Error',
        )
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    newName: 'default-next',
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    decryptSessionKeystore: decryptMatching(),
                    generatePrivateKey: mock(() => newKey),
                    createSessionKeystore: mock(async () => ({
                        ...sessionDocument('default-next', newAddress),
                        checkpoint: 'pending_rotation',
                    })),
                    readNonce: mock(async () => 1n),
                    readActiveUsdcDaily: mock(async () => 0n),
                    readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                    getKeys: mock(async () => ({
                        '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
                    })),
                    executeSignedCalls,
                    prepareCalls: quotePreparer(prepares),
                    signTypedData: mock(async () => rootPrivateKey),
                    sendPreparedCalls: mock(async () => {
                        sent.push({ id: 'bundle-in-flight' })
                        return { id: 'bundle-in-flight' }
                    }),
                    waitForBundle: mock(async () => {
                        throw statusError
                    }),
                } as never,
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_SUBMITTED' })

        expect(sent).toHaveLength(1)
        expect(prepares.length).toBeGreaterThan(0)
        const signedCalls = decodeCalls(prepares[0]!.calls)
        const revoke = signedCalls.find((call) => call.decoded.functionName === 'revoke')
        expect(revoke?.decoded.args[0]).toBe(computeSessionKeyHash(oldAddress))
        const names = await readdir(sessions)
        expect(names).toContain('default-next.json')
        const marker = JSON.parse(await readFile(join(sessions, '.rotation.json'), 'utf8')) as {
            status?: string
            bundleId?: string
        }
        expect(marker.status).toBe('submitted')
        expect(marker.bundleId).toBe('bundle-in-flight')

        const resumePrepares: PreparedInput[] = []
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    resume: true,
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    decryptSessionKeystore: decryptMatching(),
                    readNonce: mock(async () => 1n),
                    readActiveUsdcDaily: mock(async () => 0n),
                    readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                    getKeys: mock(async () => ({
                        '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
                    })),
                    executeSignedCalls,
                    prepareCalls: quotePreparer(resumePrepares),
                    signTypedData: mock(async () => rootPrivateKey),
                    sendPreparedCalls: mock(async () => {
                        throw new Error('send should not run')
                    }),
                    waitForBundle: mock(async () => {
                        throw statusError
                    }),
                } as never,
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_SUBMITTED' })
        expect(resumePrepares).toHaveLength(0)
        expect(await readdir(sessions)).toContain('default-next.json')
    })
})

test('a planted marker does not authorize an attacker key or revoke the active key', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('rotate-plant-')
        await writeFile(
            join(sessions, 'default.json'),
            `${JSON.stringify(sessionDocument('default', oldAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, 'attacker.json'),
            `${JSON.stringify(
                sessionDocument(
                    'attacker',
                    attackerAddress,
                    '0x9999999999999999999999999999999999999999',
                ),
                null,
                2,
            )}\n`,
        )
        await writeFile(
            join(sessions, '.rotation.json'),
            `${JSON.stringify(
                {
                    oldSessionName: 'not-the-active-session',
                    newSessionName: 'attacker',
                    status: 'pending',
                    chain: 'base',
                    chainId: 8453,
                    newKeyHash: computeSessionKeyHash(attackerAddress),
                    narrow: false,
                    fullAccess: false,
                    account,
                    oldKeyHash: computeSessionKeyHash(oldAddress),
                    permissions: {
                        kind: 'custom',
                        target: usdc,
                        selectors: [transferSelector],
                        spendLimit: '10000000',
                        spendPeriod: 'day',
                    },
                },
                null,
                2,
            )}\n`,
        )
        const prepares: PreparedInput[] = []
        const signed: Hex[] = []
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    resume: true,
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    readNonce: mock(async () => 1n),
                    readActiveUsdcDaily: mock(async () => 0n),
                    readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                    getKeys: mock(async () => ({
                        '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
                    })),
                    executeSignedCalls,
                    prepareCalls: quotePreparer(prepares),
                    signTypedData: mock(async () => {
                        signed.push(rootPrivateKey)
                        return rootPrivateKey
                    }),
                    sendPreparedCalls: mock(async () => ({ id: 'bundle-plant' })),
                    waitForBundle: mock(async () => confirmedStatus()),
                } as never,
            ),
        ).rejects.toThrow(/decrypt|decrypted session key|missing the account|missing the old key/i)
        expect(signed).toEqual([])
        expect(prepares).toHaveLength(0)
        const names = await readdir(sessions)
        expect(names).toContain('default.json')
        expect(names).toContain('.rotation.json')
    })
})

test('a planted narrow marker does not sign', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('rotate-narrow-plant-')
        await writeFile(
            join(sessions, 'default.json'),
            `${JSON.stringify(sessionDocument('default', oldAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, 'attacker.json'),
            `${JSON.stringify(sessionDocument('attacker', attackerAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, '.rotation.json'),
            `${JSON.stringify(
                {
                    oldSessionName: 'default',
                    newSessionName: 'attacker',
                    status: 'pending',
                    chain: 'base',
                    chainId: 8453,
                    newKeyHash: computeSessionKeyHash(attackerAddress),
                    narrow: true,
                    fullAccess: false,
                    account,
                    oldKeyHash: computeSessionKeyHash(oldAddress),
                    permissions: { kind: 'narrow' },
                },
                null,
                2,
            )}\n`,
        )
        const prepares: PreparedInput[] = []
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    resume: true,
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    readNonce: mock(async () => 1n),
                    readActiveUsdcDaily: mock(async () => 0n),
                    readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                    executeSignedCalls,
                    prepareCalls: quotePreparer(prepares),
                    signTypedData: mock(async () => rootPrivateKey),
                    sendPreparedCalls: mock(async () => ({ id: 'bundle-narrow-plant' })),
                    waitForBundle: mock(async () => confirmedStatus()),
                } as never,
            ),
        ).rejects.toThrow(/decrypt|decrypted session key/i)
        expect(prepares).toHaveLength(0)
    })
})

test('tampering the active session file does not revoke the swapped address', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('rotate-wrong-revoke-')
        await writeFile(
            join(sessions, 'default.json'),
            `${JSON.stringify(sessionDocument('default', wrongAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, 'attacker.json'),
            `${JSON.stringify(sessionDocument('attacker', attackerAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, '.rotation.json'),
            `${JSON.stringify(
                {
                    oldSessionName: 'default',
                    newSessionName: 'attacker',
                    status: 'pending',
                    chain: 'base',
                    chainId: 8453,
                    newKeyHash: computeSessionKeyHash(attackerAddress),
                    narrow: false,
                    fullAccess: false,
                    account,
                    oldKeyHash: computeSessionKeyHash(oldAddress),
                    permissions: {
                        kind: 'custom',
                        target: usdc,
                        selectors: [transferSelector],
                        spendLimit: '10000000',
                        spendPeriod: 'day',
                    },
                },
                null,
                2,
            )}\n`,
        )
        const prepares: PreparedInput[] = []
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    resume: true,
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    decryptSessionKeystore: decryptMatching(),
                    readNonce: mock(async () => 1n),
                    readActiveUsdcDaily: mock(async () => 0n),
                    readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                    executeSignedCalls,
                    prepareCalls: quotePreparer(prepares),
                    signTypedData: mock(async () => rootPrivateKey),
                    sendPreparedCalls: mock(async () => ({ id: 'bundle-wrong-revoke' })),
                    waitForBundle: mock(async () => confirmedStatus()),
                } as never,
            ),
        ).rejects.toThrow(/decrypted session key|old key/i)
        expect(prepares).toHaveLength(0)
    })
})

test('an older marker missing its account, old key hash, or permissions is refused', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('rotate-legacy-')
        await writeFile(
            join(sessions, 'default.json'),
            `${JSON.stringify(sessionDocument('default', oldAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, 'default-next.json'),
            `${JSON.stringify(sessionDocument('default-next', newAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, '.rotation.json'),
            `${JSON.stringify(
                {
                    oldSessionName: 'default',
                    newSessionName: 'default-next',
                    status: 'pending',
                    chain: 'base',
                    chainId: 8453,
                    newKeyHash: computeSessionKeyHash(newAddress),
                    narrow: false,
                    fullAccess: false,
                },
                null,
                2,
            )}\n`,
        )
        const prepares: PreparedInput[] = []
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    resume: true,
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    decryptSessionKeystore: decryptMatching(),
                    executeSignedCalls,
                    prepareCalls: quotePreparer(prepares),
                    signTypedData: mock(async () => rootPrivateKey),
                    sendPreparedCalls: mock(async () => ({ id: 'bundle-legacy' })),
                    waitForBundle: mock(async () => confirmedStatus()),
                } as never,
            ),
        ).rejects.toThrow(/missing the account/)
        expect(prepares).toHaveLength(0)
    })
})

test('a symlink marker is ignored, and a pending resume keeps the original custom spend', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('rotate-drift-')
        await writeFile(
            join(sessions, 'default.json'),
            `${JSON.stringify(sessionDocument('default', oldAddress), null, 2)}\n`,
        )
        const elsewhere = join(sessions, 'elsewhere.json')
        await writeFile(elsewhere, '{}\n')
        await symlink(elsewhere, join(sessions, '.rotation.json'))
        const symlinkResult = await executeSessionRotate(
            {
                env: 'stage',
                chain: 'base',
                keystorePath,
                password: 'pw',
                resume: true,
            },
            {
                withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                readKeystoreBundle: mock(async () => rootBundle()),
                decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                executeSignedCalls: mock(async () => {
                    throw new Error('symlink marker must not sign')
                }),
            } as never,
        )
        expect(symlinkResult.bundle.id).toBe('noop')
        await rm(join(sessions, '.rotation.json'))

        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    newName: 'default-next',
                    target: usdc,
                    selectors: [approveSelector],
                    spendLimit: 1_000_000n,
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    decryptSessionKeystore: decryptMatching(),
                    generatePrivateKey: mock(() => newKey),
                    createSessionKeystore: mock(async () => ({
                        ...sessionDocument('default-next', newAddress),
                        checkpoint: 'pending_rotation',
                    })),
                    readNonce: mock(async () => {
                        throw new Error('rpc down before send')
                    }),
                    readActiveUsdcDaily: mock(async () => 0n),
                    readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                    getKeys: mock(async () => ({
                        '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
                    })),
                    executeSignedCalls: mock(async () => {
                        throw new Error('must not send before the nonce read')
                    }),
                } as never,
            ),
        ).rejects.toThrow(/rpc down before send/)

        const marker = JSON.parse(await readFile(join(sessions, '.rotation.json'), 'utf8')) as {
            status?: string
            permissions?: {
                kind?: string
                selectors?: string[]
                spendLimit?: string
            }
        }
        expect(marker.status).toBe('pending')
        expect(marker.permissions).toEqual({
            kind: 'custom',
            target: usdc,
            selectors: [approveSelector],
            spendLimit: '1000000',
            spendPeriod: 'day',
        })
        const markerMode = (await stat(join(sessions, '.rotation.json'))).mode & 0o777
        expect(markerMode).toBe(0o600)

        const prepares: PreparedInput[] = []
        let keyReads = 0
        await executeSessionRotate(
            {
                env: 'stage',
                chain: 'base',
                keystorePath,
                password: 'pw',
                resume: true,
            },
            {
                withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                readKeystoreBundle: mock(async () => rootBundle()),
                decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                decryptSessionKeystore: decryptMatching(),
                readNonce: mock(async () => 1n),
                readActiveUsdcDaily: mock(async () => 0n),
                readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                getKeys: mock(async () => {
                    keyReads += 1
                    if (keyReads === 1) {
                        return { '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }] }
                    }
                    return { '0x2105': [{ hash: computeSessionKeyHash(newAddress) }] }
                }),
                executeSignedCalls,
                prepareCalls: quotePreparer(prepares),
                signTypedData: mock(async () => rootPrivateKey),
                sendPreparedCalls: mock(async () => ({ id: 'bundle-drift' })),
                waitForBundle: mock(async () => confirmedStatus()),
            } as never,
        )
        const calls = decodeCalls(prepares[0]!.calls)
        const spend = calls.find((call) => call.decoded.functionName === 'setSpendLimit')
        const selectors = calls
            .filter((call) => call.decoded.functionName === 'setCanExecute')
            .map((call) => String(call.decoded.args[2]).toLowerCase())
        expect(spend?.decoded.args[3]).toBe(1_000_000n)
        expect(selectors).toEqual([approveSelector])
    })
})

test('sessions directory is owner-only even when umask is 002', async () => {
    await withStage(async () => {
        const previous = process.umask(0o002)
        try {
            const root = await mkdtemp(join(tmpdir(), 'rotate-umask-'))
            const keystorePath = join(root, 'alice.json')
            const sessions = join(root, 'sessions')
            await mkdir(sessions)
            expect((await stat(sessions)).mode & 0o777).toBe(0o775)
            await expect(
                executeSessionRotate(
                    {
                        env: 'stage',
                        chain: 'base',
                        keystorePath,
                        password: 'pw',
                        newName: 'default-next',
                    },
                    {
                        withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                        readKeystoreBundle: mock(async () => rootBundle()),
                        decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                        decryptSessionKeystore: decryptMatching(),
                        generatePrivateKey: mock(() => newKey),
                        createSessionKeystore: mock(async () => ({
                            ...sessionDocument('default-next', newAddress),
                            checkpoint: 'pending_rotation',
                        })),
                        readSessionKeystoreFile: mock(async () => sessionDocument('default', oldAddress)),
                        readNonce: mock(async () => {
                            throw new Error('stop after the directory is created')
                        }),
                        readActiveUsdcDaily: mock(async () => 0n),
                        readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                    } as never,
                ),
            ).rejects.toThrow(/stop after the directory is created/)
            const created = (await stat(sessions)).mode & 0o777
            expect(created).toBe(0o700)

            await chmod(sessions, 0o775)
            expect((await stat(sessions)).mode & 0o777).toBe(0o775)
            await expect(
                executeSessionRotate(
                    {
                        env: 'stage',
                        chain: 'base',
                        keystorePath,
                        password: 'pw',
                        newName: 'default-next',
                    },
                    {
                        withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                        readKeystoreBundle: mock(async () => rootBundle()),
                        decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                        decryptSessionKeystore: decryptMatching(),
                        generatePrivateKey: mock(() => {
                            throw new Error('must not generate a second key')
                        }),
                        readSessionKeystoreFile: mock(async () => sessionDocument('default', oldAddress)),
                        executeSignedCalls: mock(async () => {
                            throw new Error('must not sign')
                        }),
                    } as never,
                ),
            ).rejects.toMatchObject({ code: 'ROTATION_IN_PROGRESS' })
            expect((await stat(sessions)).mode & 0o777).toBe(0o700)
        } finally {
            process.umask(previous)
        }
    })
})

test('a fresh rotate refuses while a marker exists and does not replace it', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('rotate-refuse-')
        await writeFile(
            join(sessions, 'default.json'),
            `${JSON.stringify(sessionDocument('default', oldAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, 'default-next.json'),
            `${JSON.stringify(sessionDocument('default-next', attackerAddress), null, 2)}\n`,
        )
        const marker = {
            oldSessionName: 'default',
            newSessionName: 'default-next',
            status: 'pending',
            chain: 'base',
            chainId: 8453,
            newKeyHash: computeSessionKeyHash(attackerAddress),
            narrow: false,
            fullAccess: false,
        }
        await writeFile(join(sessions, '.rotation.json'), `${JSON.stringify(marker, null, 2)}\n`)
        const signed: Hex[] = []
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    newName: 'default-other',
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    generatePrivateKey: mock(() => {
                        throw new Error('must not generate a second key')
                    }),
                    executeSignedCalls: mock(async () => {
                        throw new Error('must not sign')
                    }),
                    signTypedData: mock(async () => {
                        signed.push(rootPrivateKey)
                        return rootPrivateKey
                    }),
                } as never,
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_IN_PROGRESS' })
        expect(signed).toEqual([])
        const after = JSON.parse(await readFile(join(sessions, '.rotation.json'), 'utf8'))
        expect(after).toEqual(marker)
        const names = await readdir(sessions)
        expect(names).not.toContain('default-other.json')
        expect(names).toContain('default-next.json')
    })
})

test('a marker whose new session file is gone reports on-chain keys and does not sign', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('rotate-stuck-')
        await writeFile(
            join(sessions, 'default.json'),
            `${JSON.stringify(sessionDocument('default', oldAddress), null, 2)}\n`,
        )
        const oldHash = computeSessionKeyHash(oldAddress)
        const newHash = computeSessionKeyHash(newAddress)
        const marker = await sealRotationMarker(
            {
                oldSessionName: 'default',
                newSessionName: 'default-next',
                status: 'pending' as const,
                chain: 'base' as const,
                chainId: 8453,
                newKeyHash: newHash,
                narrow: false,
                fullAccess: false,
                account,
                oldKeyHash: oldHash,
                permissions: {
                    kind: 'custom' as const,
                    target: usdc,
                    selectors: [transferSelector],
                    spendLimit: '10000000',
                    spendPeriod: 'day' as const,
                },
            },
            'pw',
        )
        await writeFile(join(sessions, '.rotation.json'), `${JSON.stringify(marker, null, 2)}\n`)
        const getKeys = mock(async () => ({
            '0x2105': [{ hash: oldHash }],
        }))
        const execute = mock(async () => {
            throw new Error('must not sign')
        })
        await expect(
            executeSessionRotate(
                { env: 'stage', chain: 'base', keystorePath, password: 'pw', resume: true },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    generatePrivateKey: mock(() => {
                        throw new Error('must not generate a key')
                    }),
                    getKeys,
                    executeSignedCalls: execute,
                    signTypedData: mock(async () => {
                        throw new Error('must not sign typed data')
                    }),
                } as never,
            ),
        ).rejects.toThrow(/not authorized/)
        await expect(
            executeSessionRotate(
                { env: 'stage', chain: 'base', keystorePath, password: 'pw', resume: true },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    getKeys,
                    executeSignedCalls: execute,
                } as never,
            ),
        ).rejects.toThrow(/still live/)
        expect(getKeys).toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
        expect(JSON.parse(await readFile(join(sessions, '.rotation.json'), 'utf8'))).toEqual(marker)
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    newName: 'default-other',
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    generatePrivateKey: mock(() => {
                        throw new Error('must not generate a key')
                    }),
                    executeSignedCalls: execute,
                } as never,
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_IN_PROGRESS' })
        expect(await readdir(sessions)).not.toContain('default-other.json')
        expect(await readdir(sessions)).not.toContain('default-next.json')
    })
})

test('pointer-moved resume does not delete a sibling key that is still on chain', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('rotate-pointer-plant-')
        await writeFile(
            join(sessions, 'default.json'),
            `${JSON.stringify(sessionDocument('default', oldAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, 'sibling.json'),
            `${JSON.stringify(sessionDocument('sibling', siblingAddress), null, 2)}\n`,
        )
        const marker = await sealRotationMarker(
            {
                oldSessionName: 'sibling',
                newSessionName: 'default',
                status: 'pending' as const,
                chain: 'base' as const,
                chainId: 8453,
                newKeyHash: computeSessionKeyHash(oldAddress),
                narrow: false,
                fullAccess: false,
                account,
                oldKeyHash: computeSessionKeyHash(siblingAddress),
                permissions: {
                    kind: 'custom' as const,
                    target: usdc,
                    selectors: [transferSelector],
                    spendLimit: '10000000',
                    spendPeriod: 'day' as const,
                },
            },
            'pw',
        )
        await writeFile(join(sessions, '.rotation.json'), `${JSON.stringify(marker, null, 2)}\n`)
        const executeSigned = mock(async () => {
            throw new Error('must not sign')
        })
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    resume: true,
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    decryptSessionKeystore: decryptMatching(),
                    getKeys: mock(async () => ({
                        '0x2105': [
                            { hash: computeSessionKeyHash(oldAddress) },
                            { hash: computeSessionKeyHash(siblingAddress) },
                        ],
                    })),
                    executeSignedCalls: executeSigned,
                    signTypedData: mock(async () => {
                        throw new Error('must not sign typed data')
                    }),
                } as never,
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_VERIFICATION_FAILED' })
        expect(executeSigned).not.toHaveBeenCalled()
        const names = await readdir(sessions)
        expect(names).toContain('sibling.json')
        expect(names).toContain('.rotation.json')
        expect(names).toContain('default.json')
    })
})

test('pointer-moved full-access resume requires the phrase and does not delete a sibling', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('rotate-pointer-phrase-')
        await writeFile(
            join(sessions, 'default.json'),
            `${JSON.stringify(sessionDocument('default', oldAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, 'sibling.json'),
            `${JSON.stringify(sessionDocument('sibling', siblingAddress), null, 2)}\n`,
        )
        await writeFile(
            join(sessions, '.rotation.json'),
            `${JSON.stringify(
                {
                    oldSessionName: 'sibling',
                    newSessionName: 'default',
                    status: 'pending',
                    chain: 'base',
                    chainId: 8453,
                    newKeyHash: computeSessionKeyHash(oldAddress),
                    narrow: false,
                    fullAccess: true,
                    account,
                    oldKeyHash: computeSessionKeyHash(siblingAddress),
                    permissions: { kind: 'fullAccess' },
                },
                null,
                2,
            )}\n`,
        )
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    resume: true,
                },
                {
                    withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                    readKeystoreBundle: mock(async () => rootBundle()),
                    decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                    decryptSessionKeystore: decryptMatching(),
                    getKeys: mock(async () => ({
                        '0x2105': [
                            { hash: computeSessionKeyHash(oldAddress) },
                            { hash: computeSessionKeyHash(siblingAddress) },
                        ],
                    })),
                    executeSignedCalls: mock(async () => {
                        throw new Error('must not sign')
                    }),
                    signTypedData: mock(async () => {
                        throw new Error('must not sign typed data')
                    }),
                } as never,
            ),
        ).rejects.toThrow(/ROTATE FULL ACCESS SESSION/)
        const names = await readdir(sessions)
        expect(names).toContain('sibling.json')
        expect(names).toContain('.rotation.json')
    })
})

test('an RPC that reports chain id 31337 does not unclamp a Base fee', async () => {
    await withStage(async () => {
        // This quote is built for prod/8453 and the signed domain is the former
        // prod orchestrator. Stage addresses share ORCHESTRATOR_8453, so this
        // test installs the prod book and restores it before the helper exits.
        const restoreProd = installFormerProdDeployments()
        const methods: string[] = []
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const body = (await request.json()) as { method?: string; id?: number }
                methods.push(body.method ?? '')
                const id = body.id ?? 1
                if (body.method === 'eth_chainId') {
                    return Response.json({ jsonrpc: '2.0', id, result: '0x7a69' })
                }
                return Response.json({
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32000, message: 'nope' },
                })
            },
        })
        const previousNodeEnv = process.env.NODE_ENV
        process.env.NODE_ENV = 'production'
        try {
            const ceilings: bigint[] = []
            await expect(
                executeSignedCalls(
                    {
                        prepareCalls: mock(
                            async (input: {
                                from: Address
                                calls: Call[]
                                nonce: bigint
                                expiry?: bigint
                                payer?: Address
                                paymentToken?: Address
                                paymentMaxAmount?: bigint
                            }) => {
                                ceilings.push(input.paymentMaxAmount ?? 0n)
                                const prepared = matchingPreparedCalls({
                                    from: input.from,
                                    calls: input.calls,
                                    nonce: input.nonce,
                                    network: { env: 'prod', chainId: 8453 },
                                    expiry: input.expiry,
                                    payer: input.payer,
                                    paymentToken: input.paymentToken,
                                    paymentMaxAmount: input.paymentMaxAmount,
                                })
                                const quote = prepared.context.quote.quotes[0] as {
                                    paymentAmount: string
                                }
                                quote.paymentAmount = '10000000'
                                return prepared
                            },
                        ),
                        signTypedData: mock(async () => {
                            throw new Error('must not sign a quote above 5 USDC')
                        }),
                        sendPreparedCalls: mock(async () => {
                            throw new Error('must not send')
                        }),
                        waitForBundle: mock(async () => {
                            throw new Error('must not wait')
                        }),
                    },
                    {
                        from: account,
                        calls: [{ target: account, value: 0n, data: '0x1234' }],
                        nonce: 1n,
                        signerPrivateKey: rootPrivateKey,
                        chainId: 8453,
                        env: 'prod',
                        payer: account,
                        paymentToken: usdc,
                        paymentMaxAmount: 100_000_000n,
                        rpcUrl: `http://127.0.0.1:${server.port}`,
                        now: 1_700_000_000n,
                        expiry: 1_700_000_060n,
                        verifyingContract: '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8',
                    },
                ),
            ).rejects.toThrow(/payment amount exceeds fee cap/)
            expect(ceilings[0]).toBe(5_000_000n)
            expect(methods).toContain('eth_estimateGas')
            expect(methods).not.toContain('eth_chainId')
        } finally {
            restoreProd()
            server.stop(true)
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV
            else process.env.NODE_ENV = previousNodeEnv
        }
    })
})

test('dev on Base clamps a 100 USDC caller cap to 5 USDC before prepare and before sign', async () => {
    await withStage(async () => {
        const restoreProd = installFormerProdDeployments()
        const methods: string[] = []
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const body = (await request.json()) as { method?: string; id?: number }
                methods.push(body.method ?? '')
                return Response.json({
                    jsonrpc: '2.0',
                    id: body.id ?? 1,
                    error: { code: -32000, message: 'nope' },
                })
            },
        })
        const previousNodeEnv = process.env.NODE_ENV
        process.env.NODE_ENV = 'production'
        try {
            const ceilings: bigint[] = []
            const signedCaps: bigint[] = []
            const base = {
                from: account,
                calls: [{ target: account, value: 0n, data: '0x1234' as Hex }],
                nonce: 1n,
                signerPrivateKey: rootPrivateKey,
                chainId: 8453,
                env: 'dev' as const,
                payer: account,
                paymentToken: usdc,
                paymentMaxAmount: 100_000_000n,
                rpcUrl: `http://127.0.0.1:${server.port}`,
                now: 1_700_000_000n,
                expiry: 1_700_000_060n,
                verifyingContract: '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8' as Address,
            }
            const prepare = (quote: string) =>
                mock(
                    async (input: {
                        from: Address
                        calls: Call[]
                        nonce: bigint
                        expiry?: bigint
                        payer?: Address
                        paymentToken?: Address
                        paymentMaxAmount?: bigint
                    }) => {
                        ceilings.push(input.paymentMaxAmount ?? 0n)
                        const prepared = matchingPreparedCalls({
                            from: input.from,
                            calls: input.calls,
                            nonce: input.nonce,
                            network: { env: 'prod', chainId: 8453 },
                            expiry: input.expiry,
                            payer: input.payer,
                            paymentToken: input.paymentToken,
                            paymentMaxAmount: input.paymentMaxAmount,
                        })
                        const row = prepared.context.quote.quotes[0] as { paymentAmount: string }
                        row.paymentAmount = quote
                        return prepared
                    },
                )
            await expect(
                executeSignedCalls(
                    {
                        prepareCalls: prepare('10000000'),
                        signTypedData: mock(async () => {
                            throw new Error('must not sign a 10 USDC quote')
                        }),
                        sendPreparedCalls: mock(async () => {
                            throw new Error('must not send')
                        }),
                        waitForBundle: mock(async () => {
                            throw new Error('must not wait')
                        }),
                    },
                    base,
                ),
            ).rejects.toThrow(/payment amount exceeds fee cap/)
            expect(ceilings[0]).toBe(5_000_000n)
            expect(ceilings[0]).not.toBe(100_000_000n)

            ceilings.length = 0
            await executeSignedCalls(
                {
                    prepareCalls: prepare('1'),
                    signTypedData: mock(
                        async (input: { typedData: { message: { paymentMaxAmount: bigint } } }) => {
                            signedCaps.push(input.typedData.message.paymentMaxAmount)
                            return rootPrivateKey
                        },
                    ),
                    sendPreparedCalls: mock(async () => ({ id: 'fee-ok' })),
                    waitForBundle: mock(async () => ({
                        success: true,
                        statusCode: 200,
                        status: 'confirmed',
                    })),
                },
                base,
            )
            expect(ceilings[0]).toBe(5_000_000n)
            expect(signedCaps).toEqual([1001n])
            expect(methods).not.toContain('eth_chainId')
        } finally {
            restoreProd()
            server.stop(true)
            if (previousNodeEnv === undefined) delete process.env.NODE_ENV
            else process.env.NODE_ENV = previousNodeEnv
        }
    })
})
