import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { decodeFunctionData, type Address, type Hex } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import { executeAccountUpdatePassword } from '../src/lib/account-update-password'
import { executePermissionsList } from '../src/lib/permissions-list'
import { executeSessionList } from '../src/lib/session-list'
import { executeSessionRevoke } from '../src/lib/session-revoke'
import { executeSessionRotate } from '../src/lib/session-rotate'
import { computeSessionKeyHash, listSessionNames } from '../src/lib/session-common'

const account = '0x1111111111111111111111111111111111111111' as Address
const oldAddress = '0x2222222222222222222222222222222222222222' as Address
const newAddress = '0x3333333333333333333333333333333333333333' as Address
const rootPrivateKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const txHash = '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca' as Hex

const oldSession = {
    addresses: { session: oldAddress, delegated: account },
    name: 'default',
    checkpoint: 'authorized',
    network: {
        env: 'stage',
        relayerUrl: 'http://127.0.0.1:8787',
        rpcUrl: 'https://mainnet.base.org',
        chainId: 8453,
    },
}

const newSession = {
    addresses: { session: newAddress, delegated: account },
    name: 'default-next',
    checkpoint: 'pending_rotation',
    network: oldSession.network,
}

function rootBundle() {
    return {
        root: {
            addresses: { root: account, delegated: account },
            sessionRef: { active: 'default', dir: 'sessions' },
            network: oldSession.network,
            createdAt: '2020-01-01T00:00:00.000Z',
            checkpoint: 'delegated',
        },
        session: oldSession,
    }
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

async function stageDir(): Promise<{ keystorePath: string; sessions: string }> {
    const root = await mkdtemp(join(tmpdir(), 'rotate-marker-'))
    const sessions = join(root, 'sessions')
    await mkdir(sessions)
    await writeFile(join(sessions, 'default.json'), '{}\n')
    return { keystorePath: join(root, 'alice.json'), sessions }
}

function confirmedBundle(id: string) {
    return {
        id,
        finalStatus: {
            success: true,
            statusCode: 200,
            status: 'confirmed',
            receipt: { transactionHash: txHash },
        },
    }
}

function rotateDeps(keystorePath: string, overrides: Record<string, unknown> = {}) {
    return {
        withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
        readKeystoreBundle: mock(async () => rootBundle()),
        readSessionKeystoreFile: mock(async (path: string) =>
            path.endsWith('default-next.json') ? newSession : oldSession,
        ),
        createSessionKeystore: mock(async () => newSession),
        writeSessionKeystoreFile: mock(async () => {}),
        writeRootKeystoreFile: mock(async () => {}),
        generatePrivateKey: mock(() => rootPrivateKey),
        decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
        readNonce: mock(async () => 1n),
        readActiveUsdcDaily: mock(async () => 0n),
        getKeys: mock(async () => ({
            '0x2105': [{ hash: computeSessionKeyHash(oldAddress) }],
        })),
        readGuardCleanup: mock(async (input: { chainId: number }) => {
            if (input.chainId === 137) {
                return {
                    anyCalls: [{ target: account, selector: '0xa9059cbb' as Hex }],
                    checkers: [],
                }
            }
            return { anyCalls: [], checkers: [] }
        }),
        executeSignedCalls: mock(async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
            const decoded = params.calls.map((call) =>
                decodeFunctionData({ abi: accountAbi, data: call.data }),
            )
            if (decoded.some((entry) => entry.functionName === 'authorize')) {
                return confirmedBundle('bundle-selected')
            }
            throw new Error('polygon cleanup failed')
        }),
        waitForBundle: mock(async () => confirmedBundle('bundle-selected').finalStatus),
        prepareCalls: mock(async () => {
            throw new Error('prepareCalls should not run')
        }),
        signTypedData: mock(async () => {
            throw new Error('signTypedData should not run')
        }),
        sendPreparedCalls: mock(async () => {
            throw new Error('sendPreparedCalls should not run')
        }),
        ...overrides,
    }
}

async function leaveRealMarker(keystorePath: string) {
    await expect(
        executeSessionRotate(
            {
                env: 'stage',
                chain: 'base',
                keystorePath,
                password: 'pw',
                narrow: true,
                newName: 'default-next',
            },
            rotateDeps(keystorePath) as never,
        ),
    ).rejects.toMatchObject({ code: 'ROTATION_PARTIAL' })
}

test('rotation marker written by the real writer is read back and is not a session', async () => {
    await withStage(async () => {
        const { keystorePath, sessions } = await stageDir()
        await leaveRealMarker(keystorePath)

        const names = await listSessionNames(keystorePath, 'sessions')
        expect(names).toEqual(['default'])

        const onDisk = await readdir(sessions)
        const markers = onDisk.filter(
            (name) => name.startsWith('.rotation') && name.endsWith('.json'),
        )
        expect(markers).toHaveLength(1)
    })
})

test('rotation marker written by the real writer is resumed instead of a noop', async () => {
    await withStage(async () => {
        const { keystorePath } = await stageDir()
        await leaveRealMarker(keystorePath)

        const result = executeSessionRotate(
            {
                env: 'stage',
                chain: 'base',
                keystorePath,
                password: 'pw',
                resume: true,
            },
            rotateDeps(keystorePath) as never,
        )
        await expect(result).rejects.toMatchObject({ code: 'ROTATION_PARTIAL' })
        await expect(result).rejects.not.toMatchObject({
            bundle: { id: 'noop' },
        })
    })
})

test('rotation marker does not break session list, permissions, revoke, or password change', async () => {
    await withStage(async () => {
        const { keystorePath, sessions } = await stageDir()
        await writeFile(join(sessions, 'other.json'), '{}\n')
        await leaveRealMarker(keystorePath)

        const listed = await executeSessionList(
            { env: 'stage', chain: 'base', keystorePath, onChain: false },
            {
                readKeystoreBundle: mock(async () => rootBundle()),
                readSessionKeystoreFile: mock(async (path: string) =>
                    path.endsWith('other.json')
                        ? {
                              ...oldSession,
                              name: 'other',
                              addresses: { ...oldSession.addresses, session: newAddress },
                          }
                        : oldSession,
                ),
            } as never,
        )
        expect(listed.status).toBe('complete')
        expect(listed.sessions.map((session) => session.name).sort()).toEqual(['default', 'other'])

        const permissions = await executePermissionsList(
            { env: 'stage', chain: 'base', keystorePath },
            {
                readKeystoreBundle: mock(async () => rootBundle()),
                readSessionKeystoreFile: mock(async () => oldSession),
                getKeys: mock(async () => ({})),
            } as never,
        )
        expect(permissions.status).toBe('complete')
        expect(permissions.keys).toEqual([])

        const revoked = await executeSessionRevoke(
            {
                env: 'stage',
                chain: 'base',
                keystorePath,
                sessionName: 'default',
                force: true,
                resume: true,
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                readKeystoreBundle: mock(async () => rootBundle()),
                readSessionKeystoreFile: mock(async () => oldSession),
                getKeys: mock(async () => ({})),
                unlink: mock(async () => {}),
                writeRootKeystoreFile: mock(async () => {}),
            } as never,
        )
        expect(revoked.status).toBe('complete')

        const bundle = rootBundle()
        const updated = await executeAccountUpdatePassword(
            {
                env: 'stage',
                keystorePath,
                currentPassword: 'pw',
                newPassword: 'next-pw',
            },
            {
                withKeystoreLock: async (_path: string, fn: () => Promise<unknown>) => fn(),
                readKeystoreBundle: mock(async () => bundle),
                readSessionKeystoreFile: mock(async (path: string) =>
                    path.endsWith('other.json') ? { ...oldSession, name: 'other' } : oldSession,
                ),
                decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
                decryptSessionKeystore: mock(async () => ({
                    sessionPrivateKey: rootPrivateKey,
                })),
                createRootKeystore: mock(async () => ({
                    createdAt: '',
                    checkpoint: '',
                    addresses: {},
                    network: bundle.root.network,
                })),
                createSessionKeystore: mock(async (input: { name: string }) => ({
                    ...oldSession,
                    name: input.name,
                })),
                writeRootKeystoreFile: mock(async () => {}),
                writeSessionKeystoreFile: mock(async () => {}),
            } as never,
        )
        expect(updated.status).toBe('complete')
        expect(updated.updatedSessions).toEqual(['default', 'other'])
        expect(updated.updatedSessions).not.toContain('.rotation')
    })
})

test('rotation marker plus any other marker is ambiguous and does not sign', async () => {
    await withStage(async () => {
        const { keystorePath, sessions } = await stageDir()
        await leaveRealMarker(keystorePath)
        const hash = computeSessionKeyHash(newAddress)
        await writeFile(
            join(sessions, '.rotation-evil.json'),
            `${JSON.stringify(
                {
                    oldSessionName: 'default',
                    newSessionName: 'default-next',
                    status: 'pending',
                    chain: 'base',
                    chainId: 8453,
                    newKeyHash: hash,
                    narrow: false,
                    fullAccess: true,
                },
                null,
                2,
            )}\n`,
        )

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
                rotateDeps(keystorePath, {
                    executeSignedCalls: mock(
                        async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                            for (const call of params.calls) signed.push(call.data)
                            return confirmedBundle('bundle-evil')
                        },
                    ),
                }) as never,
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_MARKER_AMBIGUOUS' })
        expect(signed).toEqual([])
    })
})

test('rotation marker with fullAccess requires the human phrase on a plain resume', async () => {
    await withStage(async () => {
        const { keystorePath, sessions } = await stageDir()
        const hash = computeSessionKeyHash(newAddress)
        await writeFile(
            join(sessions, '.rotation-evil.json'),
            `${JSON.stringify(
                {
                    oldSessionName: 'default',
                    newSessionName: 'default-next',
                    status: 'pending',
                    chain: 'base',
                    chainId: 8453,
                    newKeyHash: hash,
                    narrow: false,
                    fullAccess: true,
                },
                null,
                2,
            )}\n`,
        )

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
                rotateDeps(keystorePath, {
                    executeSignedCalls: mock(
                        async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                            for (const call of params.calls) signed.push(call.data)
                            return confirmedBundle('bundle-evil')
                        },
                    ),
                }) as never,
            ),
        ).rejects.toThrow(/ROTATE FULL ACCESS SESSION/)
        expect(signed).toEqual([])
    })
})

test('rotation marker newKeyHash must be 0x and 64 hex characters', async () => {
    await withStage(async () => {
        const { keystorePath, sessions } = await stageDir()
        await writeFile(
            join(sessions, '.rotation-bad.json'),
            `${JSON.stringify(
                {
                    oldSessionName: 'default',
                    newSessionName: 'default-next',
                    status: 'pending',
                    chain: 'base',
                    chainId: 8453,
                    newKeyHash: '0xzz',
                    narrow: true,
                    fullAccess: false,
                },
                null,
                2,
            )}\n`,
        )

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
                rotateDeps(keystorePath, {
                    executeSignedCalls: mock(
                        async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                            for (const call of params.calls) signed.push(call.data)
                            return confirmedBundle('bundle-bad')
                        },
                    ),
                }) as never,
            ),
        ).rejects.toThrow(/64 hex/)
        expect(signed).toEqual([])
    })
})

test('rotation marker stays after a bundle wait timeout and tells the user to resume', async () => {
    await withStage(async () => {
        const { keystorePath, sessions } = await stageDir()
        const unlinked: string[] = []
        let caught: unknown
        try {
            await executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    narrow: true,
                    newName: 'default-next',
                },
                rotateDeps(keystorePath, {
                    readGuardCleanup: mock(async () => ({ anyCalls: [], checkers: [] })),
                    unlink: mock(async (path: string) => {
                        unlinked.push(path)
                    }),
                    executeSignedCalls: mock(async () => {
                        throw new Error(
                            'Timeout waiting for bundle bundle-timeout to reach final status. Current status: 100',
                        )
                    }),
                }) as never,
            )
        } catch (error) {
            caught = error
        }

        expect(caught).toMatchObject({
            code: 'ROTATION_SUBMITTED',
            recoveryCommand: 'tw session rotate --resume',
        })
        expect(caught).toBeInstanceOf(Error)
        expect((caught as Error).message).toMatch(/--resume/)

        const onDisk = await readdir(sessions)
        const markers = onDisk.filter(
            (name) => name.startsWith('.rotation') && name.endsWith('.json'),
        )
        expect(markers).toHaveLength(1)
        const raw = JSON.parse(await readFile(join(sessions, markers[0]!), 'utf8')) as {
            status?: string
            bundleId?: string
        }
        expect(raw.status).toBe('submitted')
        expect(raw.bundleId).toBe('bundle-timeout')
        expect(unlinked.some((path) => path.endsWith('default-next.json'))).toBe(false)
    })
})
