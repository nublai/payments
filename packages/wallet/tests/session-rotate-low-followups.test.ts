/**
 * Regression tests for the four Lows left on 697dcf7.
 * Assertions describe the fixed behavior, so they fail on that commit.
 */
import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type Call } from '@nubl/relayer-client'
import { createSessionKeystore, deriveKeystoreKey } from '../src/lib/keystore'
import { sealRotationMarker } from '../src/lib/session-rotate'
import { executeSignedCalls, executeSessionRotate } from './helpers/stub-execute'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { matchingPreparedCalls } from './helpers/matching-prepared'

const account: Address = '0x1111111111111111111111111111111111111111'

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

    try {
        return await fn()
    } finally {
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
        withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
        readKeystoreBundle: mock(async () => rootBundle()),
        decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
        generatePrivateKey: mock(() => newKey),
        readNonce: mock(async () => 1n),
        readActiveUsdcDaily: mock(async () => 0n),
        readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
        getKeys: mock(async () => ({
            '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
        })),
        ...extra,
    }
}

function pendingPayload() {
    return {
        oldSessionName: 'default',
        newSessionName: 'default-next',
        status: 'pending' as const,
        chain: 'base' as const,
        chainId: 8453,
        newKeyHash: computeSessionKeyHash(newAddress),
        narrow: true,
        fullAccess: false,
        account,
        oldKeyHash: computeSessionKeyHash(oldAddress),
        permissions: { kind: 'narrow' as const },
    }
}

/** Canonical MAC body at 697dcf7, before freshness was added. */
function legacyMarkerMacBody(value: ReturnType<typeof pendingPayload>): string {
    return JSON.stringify({
        account: value.account.toLowerCase(),
        bundleId: null,
        chain: value.chain,
        chainId: value.chainId,
        fullAccess: value.fullAccess,
        narrow: value.narrow,
        newKeyHash: value.newKeyHash.toLowerCase(),
        newSessionName: value.newSessionName,
        oldKeyHash: value.oldKeyHash.toLowerCase(),
        oldSessionName: value.oldSessionName,
        permissions: { kind: value.permissions.kind },
        status: value.status,
    })
}

test('a restored marker is refused when freshness no longer matches', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('fresh-')
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
                    readNonce: mock(async () => {
                        throw new Error('rpc down before send')
                    }),
                }),
            ),
        ).rejects.toThrow(/rpc down before send/)

        const freshnessPath = join(sessions, 'rotation-freshness-alice')
        const current = await readFile(freshnessPath, 'utf8').catch(() => '')
        const replacement = current.trim() === '11'.repeat(16) ? '22'.repeat(16) : '11'.repeat(16)
        await writeFile(freshnessPath, `${replacement}\n`)

        const prepares: PreparedInput[] = []
        let caught: unknown

        try {
            await executeSessionRotate(
                { env: 'stage', chain: 'base', keystorePath, password, resume: true },
                baseDeps({
                    executeSignedCalls,
                    prepareCalls: quotePreparer(prepares),
                    signTypedData: mock(async () => rootPrivateKey),
                    sendPreparedCalls: mock(async () => ({ id: 'bundle-stale' })),
                    waitForBundle: mock(async () => ({
                        success: true,
                        statusCode: 200,
                        status: 'confirmed',
                    })),
                }),
            )
        } catch (error) {
            caught = error
        }

        expect(prepares).toHaveLength(0)
        expect(caught).toMatchObject({ code: 'ROTATION_MARKER_MISMATCH' })
        expect(await readdir(sessions)).toContain('.rotation.json')
    })
})

test('abandon refuses an unverified marker and leaves the file', async () => {
    await withStage(async () => {
        const { sessions, keystorePath } = await stageDir('abandon-unverified-')
        await writeRealSession(join(sessions, 'default.json'), 'default', oldKey)
        await writeRealSession(join(sessions, 'default-next.json'), 'default-next', newKey)
        await writeFile(
            join(sessions, '.rotation.json'),
            `${JSON.stringify(
                {
                    ...pendingPayload(),
                    status: 'submitted',
                    bundleId: 'bundle-reverted',
                    mac: 'ab'.repeat(32),
                    macKdf: {
                        memoryCost: 19456,
                        timeCost: 2,
                        parallelism: 1,
                        hashLength: 32,
                        salt: Buffer.from('0123456789abcdef').toString('base64'),
                    },
                },
                null,
                2,
            )}\n`,
        )

        const getKeys = mock(async () => ({
            '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
        }))

        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password,
                    abandon: true,
                },
                baseDeps({
                    getKeys,
                    prepareCalls: mock(async () => {
                        throw new Error('must not prepare')
                    }),
                    signTypedData: mock(async () => {
                        throw new Error('must not sign')
                    }),
                }),
            ),
        ).rejects.toThrow(/unverified/)
        expect(getKeys).not.toHaveBeenCalled()
        expect(await readdir(sessions)).toContain('.rotation.json')
        expect(await readdir(sessions)).toContain('default.json')
        expect(await readdir(sessions)).toContain('default-next.json')
    })
})

test('sealRotationMarker rejects argon2 parameters above the writer cap', async () => {
    const payload = {
        ...pendingPayload(),
        mac: 'ab'.repeat(32),
        macKdf: {
            memoryCost: 19456,
            timeCost: 3,
            parallelism: 1,
            hashLength: 32,
            salt: Buffer.from('0123456789abcdef').toString('base64'),
        },
    }

    await expect(sealRotationMarker(payload, password)).rejects.toThrow(/KDF parameters/)
})

test('the marker MAC is not the keystore argon2 digest of the legacy body', async () => {
    const payload = pendingPayload()
    const sealed = await sealRotationMarker(payload, password)
    const key = await deriveKeystoreKey(password, sealed.macKdf)

    try {
        const legacy = createHmac('sha256', key).update(legacyMarkerMacBody(payload)).digest('hex')
        expect(sealed.mac).not.toBe(legacy)
    } finally {
        key.fill(0)
    }
})
