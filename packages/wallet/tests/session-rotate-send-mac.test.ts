/**
 * Regression tests for the PR 25 gate at 1050b18.
 * Assertions describe the fixed behavior, so they fail on that head.
 */
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { decodeFunctionData, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { accountAbi } from '@nubl/contracts/abis'
import { JsonRpcClientError, type Call } from '@nubl/relayer-client'
import { executeSignedCalls, executeSessionRotate } from './helpers/stub-execute'
import { createSessionKeystore, ensureOwnerOnlyDirectory } from '../src/lib/keystore'
import { sealRotationMarker, type SessionRotateDeps } from '../src/lib/session-rotate'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { installFormerStageDeployments } from './helpers/former-deployment-env'
import { matchingPreparedCalls } from './helpers/matching-prepared'
import { typedMock } from './helpers/typed-mock'

const account = '0x1111111111111111111111111111111111111111'

const oldKey = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'

const newKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const rootPrivateKey =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const oldAddress = privateKeyToAccount(oldKey).address

const newAddress = privateKeyToAccount(newKey).address

const approveSelector = '0x095ea7b3'

const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

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

function decodeCalls(calls: Call[]) {
    return calls.map((call) => ({
        target: call.target,
        decoded: decodeFunctionData({ abi: accountAbi, data: call.data }),
    }))
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

test('a send throw before an id returns keeps the key and resume settles from getKeys', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('send-throw-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)
        const prepares: PreparedInput[] = []
        const signed: Hex[] = []
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password,
                    newName: 'default-next',
                },
                baseDeps({
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                    prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer(prepares)),
                    signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => {
                        signed.push(rootPrivateKey)

                        return rootPrivateKey
                    }),
                    sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
                        throw new Error('socket hang up')
                    }),
                    waitForBundle: typedMock<SessionRotateDeps['waitForBundle']>(async () => {
                        throw new Error('must not wait')
                    }),
                }),
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_SUBMITTED' })
        const names = await readdir(sessions)
        expect(names).toContain('default-next.json')
        expect(names).toContain('.rotation.json')

        const marker: { status?: string; bundleId?: string } = JSON.parse(
            await readFile(join(sessions, '.rotation.json'), 'utf8'),
        )

        expect(marker.status).toBe('submitted')
        expect(marker.bundleId).toBeUndefined()
        expect(prepares.length).toBeGreaterThan(0)
        expect(signed.length).toBeGreaterThan(0)

        const resumePrepares: PreparedInput[] = []

        const getKeys = mock(async () => ({
            '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
        }))

        await expect(
            executeSessionRotate(
                { env: 'stage', chain: 'base', keystorePath, password, resume: true },
                baseDeps({
                    getKeys,
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                    prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer(resumePrepares)),
                    signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => {
                        throw new Error('must not sign')
                    }),
                    sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
                        throw new Error('must not send')
                    }),
                }),
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_SUBMITTED' })
        expect(getKeys).toHaveBeenCalled()
        expect(resumePrepares).toHaveLength(0)
        expect(await readdir(sessions)).toContain('default-next.json')
        expect(await readdir(sessions)).toContain('.rotation.json')

        const settlePrepares: PreparedInput[] = []

        const settled = await executeSessionRotate(
            { env: 'stage', chain: 'base', keystorePath, password, resume: true },
            baseDeps({
                getKeys: typedMock<SessionRotateDeps['getKeys']>(async () => ({
                    '0x2105': [{ hash: computeSessionKeyHash(newAddress) }],
                })),
                executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer(settlePrepares)),
                signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => {
                    throw new Error('must not sign')
                }),
                sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
                    throw new Error('must not send')
                }),
            }),
        )

        expect(settled.bundle.id).not.toBe('noop')
        expect(settlePrepares).toHaveLength(0)
        const after = await readdir(sessions)
        expect(after).toContain('default-next.json')
        expect(after).not.toContain('.rotation.json')
        expect(after).not.toContain('default.json')
    })
})

test('bundle tracking unavailable after broadcast keeps the key and records the id', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('tracking-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password,
                    newName: 'default-next',
                },
                baseDeps({
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                    prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer([])),
                    signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => rootPrivateKey),
                    sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
                        throw new JsonRpcClientError(
                            -32002,
                            'Intent submitted but bundle tracking unavailable; retry status lookup later',
                            { bundleId: 'bundle-tracked' },
                        )
                    }),
                    waitForBundle: typedMock<SessionRotateDeps['waitForBundle']>(async () => {
                        throw new Error('must not wait')
                    }),
                }),
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_SUBMITTED' })
        expect(await readdir(sessions)).toContain('default-next.json')

        const marker: { status?: string; bundleId?: string } = JSON.parse(
            await readFile(join(sessions, '.rotation.json'), 'utf8'),
        )

        expect(marker.status).toBe('submitted')
        expect(marker.bundleId).toBe('bundle-tracked')
    })
})

test('a definitive pre-broadcast refusal still drops the unsent rotation', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('pre-broadcast-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password,
                    newName: 'default-next',
                },
                baseDeps({
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                    prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer([])),
                    signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => rootPrivateKey),
                    sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
                        throw new JsonRpcClientError(
                            -32602,
                            'Missing required parameter: context',
                        )
                    }),
                }),
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_FAILED' })
        const names = await readdir(sessions)
        expect(names).not.toContain('default-next.json')
        expect(names.filter((name) => name.startsWith('.rotation'))).toEqual([])
    })
})

test('an edited marker is refused before resume signs', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('forge-perm-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)
        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password,
                    newName: 'default-next',
                    target: usdc,
                    selectors: [approveSelector],
                    spendLimit: 1_000_000n,
                },
                baseDeps({
                    readNonce: typedMock<SessionRotateDeps['readNonce']>(async () => {
                        throw new Error('rpc down before send')
                    }),
                }),
            ),
        ).rejects.toThrow(/rpc down before send/)

        const attackerTarget = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead'
        const marker = JSON.parse(await readFile(join(sessions, '.rotation.json'), 'utf8'))
        marker.permissions = {
            kind: 'custom',
            target: attackerTarget,
            selectors: ['0xdeadbeef'],
            spendLimit: '10000000',
            spendPeriod: 'day',
        }
        await writeFile(join(sessions, '.rotation.json'), `${JSON.stringify(marker, null, 2)}\n`)

        const prepares: PreparedInput[] = []
        await expect(
            executeSessionRotate(
                { env: 'stage', chain: 'base', keystorePath, password, resume: true },
                baseDeps({
                    getKeys: typedMock<SessionRotateDeps['getKeys']>(async () => ({
                        '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
                    })),
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                    prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer(prepares)),
                    signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => rootPrivateKey),
                    sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => ({ id: 'bundle-forged' })),
                    waitForBundle: typedMock<SessionRotateDeps['waitForBundle']>(async () => ({
                        success: true,
                        statusCode: 200,
                        status: 'confirmed',
                    })),
                }),
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_MARKER_MISMATCH' })
        expect(prepares).toHaveLength(0)
        expect(await readdir(sessions)).toContain('default-next.json')
        expect(await readdir(sessions)).toContain('.rotation.json')
        const calls = prepares.flatMap((prepare) => decodeCalls(prepare.calls))
        expect(calls).toEqual([])
    })
})

test('an older marker with no authentication is refused before resume signs', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('legacy-mac-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)
        await writeRealSession(join(sessions, 'default-next.json'), 'default-next', newKey)
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
                    account,
                    oldKeyHash: computeSessionKeyHash(oldAddress),
                    permissions: {
                        kind: 'custom',
                        target: usdc,
                        selectors: [approveSelector],
                        spendLimit: '1000000',
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
                { env: 'stage', chain: 'base', keystorePath, password, resume: true },
                baseDeps({
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(executeSignedCalls),
                    prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(quotePreparer(prepares)),
                    signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => rootPrivateKey),
                    sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => ({ id: 'bundle-legacy-mac' })),
                    waitForBundle: typedMock<SessionRotateDeps['waitForBundle']>(async () => ({
                        success: true,
                        statusCode: 200,
                        status: 'confirmed',
                    })),
                }),
            ),
        ).rejects.toThrow(/not authenticated/)
        expect(prepares).toHaveLength(0)
        expect(await readdir(sessions)).toContain('default.json')
        expect(await readdir(sessions)).toContain('default-next.json')
        expect(await readdir(sessions)).toContain('.rotation.json')
    })
})

test('abandon reports on-chain keys and removes only the marker', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('abandon-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)
        await writeRealSession(join(sessions, 'default-next.json'), 'default-next', newKey)

        const marker = await sealRotationMarker(
            {
                oldSessionName: 'default',
                newSessionName: 'default-next',
                status: 'submitted',
                bundleId: 'bundle-reverted',
                chain: 'base',
                chainId: 8453,
                newKeyHash: computeSessionKeyHash(newAddress),
                narrow: false,
                fullAccess: false,
                account,
                oldKeyHash: computeSessionKeyHash(oldAddress),
                permissions: {
                    kind: 'custom',
                    target: usdc,
                    selectors: [approveSelector],
                    spendLimit: '1000000',
                    spendPeriod: 'day',
                },
            },
            password,
        )

        await writeFile(join(sessions, '.rotation.json'), `${JSON.stringify(marker, null, 2)}\n`)
        const signed: string[] = []
        let markerPresentAtGetKeys = false

        const getKeys = mock(async () => {
            markerPresentAtGetKeys = (await readdir(sessions)).includes('.rotation.json')

            return { '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }] }
        })

        const result = await executeSessionRotate(
            {
                env: 'stage',
                chain: 'base',
                keystorePath,
                password,
                abandon: true,
            },
            baseDeps({
                getKeys,
                executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(async () => {
                    signed.push('execute')
                    throw new Error('must not sign')
                }),
                signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => {
                    signed.push('sign')
                    throw new Error('must not sign')
                }),
                prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(async () => {
                    signed.push('prepare')
                    throw new Error('must not prepare')
                }),
            }),
        )

        expect(markerPresentAtGetKeys).toBe(true)
        expect(getKeys).toHaveBeenCalled()
        expect(signed).toEqual([])
        expect(result.onChain).toEqual({ newKeyAuthorized: false, oldKeyLive: true })
        const names = await readdir(sessions)
        expect(names).not.toContain('.rotation.json')
        expect(names).toContain('default.json')
        expect(names).toContain('default-next.json')
    })
})

test('sessions chmod refuses a symlink and still tightens a real directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mode-'))
    await chmod(root, 0o755)
    const loose = join(root, 'sessions')
    await mkdir(loose, { recursive: true, mode: 0o777 })
    await chmod(loose, 0o775)
    await ensureOwnerOnlyDirectory(loose)
    expect((await stat(loose)).mode & 0o777).toBe(0o700)
    expect((await stat(root)).mode & 0o777).toBe(0o755)

    const linked = await mkdtemp(join(tmpdir(), 'link-'))
    const target = join(linked, 'elsewhere')
    await mkdir(target, { mode: 0o777 })
    await chmod(target, 0o775)
    const link = join(linked, 'sessions')
    await symlink(target, link)
    await expect(ensureOwnerOnlyDirectory(link)).rejects.toThrow(/symlink/i)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect((await stat(target)).mode & 0o777).toBe(0o775)
})
