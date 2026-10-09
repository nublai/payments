/**
 * Regression tests for an interrupted post-broadcast marker reseal at af1f014.
 * The ENOSPC, interruption, and wrong-password cases fail on that commit.
 */
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type Call } from '@nubl/relayer-client'
import { createRootKeystore, createSessionKeystore, decryptRootKeystore } from '../src/lib/keystore'
import { executeSignedCalls, executeSessionRotate } from './helpers/stub-execute'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { installFormerStageDeployments } from './helpers/former-deployment-env'
import { matchingPreparedCalls } from './helpers/matching-prepared'
import { typedMock } from './helpers/typed-mock'
import type { SessionRotateDeps } from '../src/lib/session-rotate'

const account = '0x1111111111111111111111111111111111111111'

const oldKey = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'

const newKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const rootPrivateKey =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const oldAddress = privateKeyToAccount(oldKey).address

const newAddress = privateKeyToAccount(newKey).address

const password = 'pw'

const network = {
    env: 'stage' as const,
    relayerUrl: 'http://127.0.0.1:8787',
    rpcUrl: 'https://mainnet.base.org',
    chainId: 8453,
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

function rootBundle(active = 'default') {
    return {
        root: {
            addresses: { root: account, delegated: account },
            sessionRef: { active, dir: 'sessions' },
            network,
            createdAt: '2020-01-01T00:00:00.000Z',
            checkpoint: 'delegated',
        },
        session: { addresses: { session: oldAddress } },
    }
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
    const restoreStage = installFormerStageDeployments()

    try {
        return await fn()
    } finally {
        restoreStage()

        if (previous === undefined) delete process.env.RELAYER_URL_STAGE
        else process.env.RELAYER_URL_STAGE = previous
    }
}

async function writeRealSession(path: string, name: string, key: Hex) {
    const doc = await createSessionKeystore({
        password,
        sessionPrivateKey: key,
        network,
        delegated: account,
        name,
        checkpoint: 'authorized',
    })

    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`)

    return doc
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

function baseDeps<E>(extra?: E) {
    return {
        withKeystoreLock: typedMock<SessionRotateDeps['withKeystoreLock']>(async (_path: string, fn: () => Promise<unknown>) => fn()),
        readKeystoreBundle: typedMock<SessionRotateDeps['readKeystoreBundle']>(async () => rootBundle()),
        decryptRootKeystore: typedMock<SessionRotateDeps['decryptRootKeystore']>(async () => ({ rootPrivateKey })),
        generatePrivateKey: typedMock<SessionRotateDeps['generatePrivateKey']>(() => newKey),
        readNonce: typedMock<SessionRotateDeps['readNonce']>(async () => 1n),
        readActiveUsdcDaily: typedMock<SessionRotateDeps['readActiveUsdcDaily']>(async () => 0n),
        readGuardCleanup: typedMock<SessionRotateDeps['readGuardCleanup']>(async () => ({ anyCalls: [], checkers: [] })),
        getKeys: typedMock<SessionRotateDeps['getKeys']>(async () => ({
            '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
        })),
        ...extra,
    }
}

function enospc(): Error {
    return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
}

/**
 * Writes the marker to disk like the default writer. `plan(call)` decides each call:
 * write, throw before writing, or write and then throw (a crash right after the rename).
 */
function intentWriter(
    sessions: string,
    plan: (call: number) => 'write' | 'fail' | 'write-then-fail',
    error: () => Error,
) {
    let calls = 0

    return mock(
        async (_root: string, _dir: string, value: Record<string, unknown>, fileName?: string) => {
            calls += 1
            const step = plan(calls)

            if (step === 'fail') throw error()
            const name = fileName ?? '.rotation.json'
            const tmp = join(sessions, `${name}.tmp-test`)
            await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
            await rename(tmp, join(sessions, name))

            if (step === 'write-then-fail') throw error()

            return { ...value, fileName: name }
        },
    )
}

const minedNewOnly = () =>
    typedMock<SessionRotateDeps['getKeys']>(async () => ({
        '0x2105': [{ hash: computeSessionKeyHash(newAddress) }],
    }))

async function firstRunWithEnospc(sessions: string, keystorePath: string) {
    const prepares: PreparedInput[] = []
    const sends: string[] = []
    let caught: unknown

    try {
        await executeSessionRotate(
            { env: 'stage', chain: 'base', keystorePath, password, newName: 'default-next' },
            baseDeps({
                executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer(prepares)),
                signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => rootPrivateKey),
                sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
                    sends.push('bundle-1')

                    return { id: 'bundle-1' }
                }),
                waitForBundle: typedMock<SessionRotateDeps['waitForBundle']>(async () => ({
                    success: true,
                    statusCode: 200,
                    status: 'confirmed',
                })),
                writeRotationIntent: intentWriter(
                    sessions,
                    (call) => (call >= 2 ? 'fail' : 'write'),
                    enospc,
                ),
            }),
        )
    } catch (error) {
        caught = error
    }

    return { caught, sends, prepares }
}

test('ENOSPC on the post-broadcast reseal reports the sent bundle and resume recovers', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('reseal-enospc-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)

        const first = await firstRunWithEnospc(sessions, keystorePath)
        expect(first.sends).toEqual(['bundle-1'])
        expect(first.caught).toMatchObject({ code: 'ROTATION_SUBMITTED' })

        if (!(first.caught instanceof Error)) throw first.caught

        expect(first.caught.message).toContain('bundle-1')
        expect(first.caught.message).not.toContain('ENOSPC')

        const resumePrepares: PreparedInput[] = []

        const signTypedData = mock(async () => {
            throw new Error('must not sign')
        })

        const result = await executeSessionRotate(
            { env: 'stage', chain: 'base', keystorePath, password, resume: true },
            baseDeps({
                getKeys: typedMock<SessionRotateDeps['getKeys']>(minedNewOnly()),
                executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer(resumePrepares)),
                signTypedData,
                sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
                    throw new Error('must not send')
                }),
            }),
        )

        expect(result.status).toBe('complete')
        expect(result.resumed).toBe(true)
        expect(resumePrepares).toHaveLength(0)
        expect(signTypedData).not.toHaveBeenCalled()
        const after = await readdir(sessions)
        expect(after).not.toContain('.rotation.json')
        expect(after).toContain('default-next.json')
        expect(after).not.toContain('default.json')
    })
})

test('ENOSPC on the post-broadcast reseal can be abandoned without deleting files by hand', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('reseal-enospc-abandon-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)

        const first = await firstRunWithEnospc(sessions, keystorePath)
        expect(first.sends).toEqual(['bundle-1'])
        expect(first.caught).toMatchObject({ code: 'ROTATION_SUBMITTED' })

        const getKeys = minedNewOnly()

        const result = await executeSessionRotate(
            { env: 'stage', chain: 'base', keystorePath, password, abandon: true },
            baseDeps({ getKeys }),
        )

        expect(getKeys).toHaveBeenCalled()
        expect(result.markerRemoved).toBe(true)
        expect(result.onChain).toEqual({ newKeyAuthorized: true, oldKeyLive: false })
        expect(await readdir(sessions)).not.toContain('.rotation.json')
    })
})

test('a crash after the resealed marker is written and before the sidecar update recovers', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('reseal-crash-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)

        const sends: string[] = []
        await expect(
            executeSessionRotate(
                { env: 'stage', chain: 'base', keystorePath, password, newName: 'default-next' },
                baseDeps({
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                    prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer([])),
                    signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => rootPrivateKey),
                    sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
                        sends.push('bundle-1')

                        return { id: 'bundle-1' }
                    }),
                    writeRotationIntent: intentWriter(
                        sessions,
                        (call) => (call === 1 ? 'write' : call === 2 ? 'write-then-fail' : 'fail'),
                        () => new Error('killed'),
                    ),
                }),
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_SUBMITTED' })
        expect(sends).toEqual(['bundle-1'])
        const marker = JSON.parse(await readFile(join(sessions, '.rotation.json'), 'utf8'))
        expect(marker).toMatchObject({ status: 'submitted', bundleId: 'bundle-1' })

        const resumePrepares: PreparedInput[] = []

        const waitForBundle = mock(async () => ({
            success: true,
            statusCode: 200,
            status: 'confirmed',
        }))

        const result = await executeSessionRotate(
            { env: 'stage', chain: 'base', keystorePath, password, resume: true },
            baseDeps({
                getKeys: typedMock<SessionRotateDeps['getKeys']>(minedNewOnly()),
                executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer(resumePrepares)),
                signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => {
                    throw new Error('must not sign')
                }),
                sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
                    throw new Error('must not send')
                }),
                waitForBundle,
            }),
        )

        expect(result.bundle.id).toBe('bundle-1')
        expect(waitForBundle).toHaveBeenCalled()
        expect(resumePrepares).toHaveLength(0)
        expect(await readdir(sessions)).not.toContain('.rotation.json')
    })
})

test('abandon with a wrong password says so and leaves every file in place', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('abandon-wrong-pw-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)

        const realRoot = await createRootKeystore({
            password,
            rootPrivateKey,
            env: 'stage',
            relayerUrl: network.relayerUrl,
            rpcUrl: network.rpcUrl,
            chainId: network.chainId,
        })

        const bundleWithRealRoot = () => ({
            root: { ...realRoot, addresses: { ...realRoot.addresses, delegated: account } },
            session: { addresses: { session: oldAddress } },
        })

        await expect(
            executeSessionRotate(
                { env: 'stage', chain: 'base', keystorePath, password, newName: 'default-next' },
                baseDeps({
                    readKeystoreBundle: typedMock<SessionRotateDeps['readKeystoreBundle']>(async () => bundleWithRealRoot()),
                    decryptRootKeystore,
                    readNonce: typedMock<SessionRotateDeps['readNonce']>(async () => {
                        throw new Error('rpc down before send')
                    }),
                }),
            ),
        ).rejects.toThrow(/rpc down before send/)
        const before = await readdir(sessions)
        const markerBefore = await readFile(join(sessions, '.rotation.json'), 'utf8')

        const getKeys = typedMock<SessionRotateDeps['getKeys']>(async () => ({
            '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
        }))

        let caught: unknown

        try {
            await executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'wrong',
                    abandon: true,
                },
                baseDeps({
                    readKeystoreBundle: typedMock<SessionRotateDeps['readKeystoreBundle']>(async () => bundleWithRealRoot()),
                    decryptRootKeystore,
                    getKeys,
                }),
            )
        } catch (error) {
            caught = error
        }

        expect(caught).toMatchObject({ code: 'PASSWORD_INCORRECT' })

        if (!(caught instanceof Error)) throw caught

        expect(caught.message).not.toMatch(/unverified|Delete the marker/)
        expect(getKeys).not.toHaveBeenCalled()
        expect(await readdir(sessions)).toEqual(before)
        expect(before).toContain('.rotation.json')
        expect(before).toContain('default.json')
        expect(before).toContain('default-next.json')
        expect(await readFile(join(sessions, '.rotation.json'), 'utf8')).toBe(markerBefore)
    })
})

test('restoring only the pre-broadcast marker after a reseal is still refused', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('reseal-restore-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)

        let pendingCopy = ''
        await expect(
            executeSessionRotate(
                { env: 'stage', chain: 'base', keystorePath, password, newName: 'default-next' },
                baseDeps({
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                    prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer([])),
                    signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => rootPrivateKey),
                    sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
                        pendingCopy = await readFile(join(sessions, '.rotation.json'), 'utf8')

                        return { id: 'bundle-1' }
                    }),
                    waitForBundle: typedMock<SessionRotateDeps['waitForBundle']>(async () => {
                        throw new Error('Timeout waiting for bundle bundle-1 to reach final status')
                    }),
                }),
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_SUBMITTED' })
        expect(JSON.parse(pendingCopy)).toMatchObject({ status: 'pending' })
        await writeFile(join(sessions, '.rotation.json'), pendingCopy)

        const prepares: PreparedInput[] = []
        await expect(
            executeSessionRotate(
                { env: 'stage', chain: 'base', keystorePath, password, resume: true },
                baseDeps({
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                    prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer(prepares)),
                    signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => rootPrivateKey),
                    sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => ({ id: 'bundle-2' })),
                }),
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_MARKER_MISMATCH' })
        expect(prepares).toHaveLength(0)
        expect(await readdir(sessions)).toContain('.rotation.json')
    })
})
