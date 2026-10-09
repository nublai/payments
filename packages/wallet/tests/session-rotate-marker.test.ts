import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { decodeFunctionData, getAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { accountAbi } from '@nubl/contracts/abis'
import {
    executeAccountUpdatePassword,
    executePermissionsList,
    executeSessionList,
    executeSessionRevoke,
    executeSessionRotate,
} from './helpers/stub-execute'
import { sealRotationMarker, type SessionRotateDeps } from '../src/lib/session-rotate'
import { computeSessionKeyHash, listSessionNames } from '../src/lib/session-common'
import { installFormerStageDeployments } from './helpers/former-deployment-env'
import { parseAddr } from './helpers/hex'
import { confirmedBundle } from './helpers/bundle-status'
import { passthroughKeystoreLock, typedMock } from './helpers/typed-mock'
import type { AccountUpdatePasswordDeps } from '../src/lib/account-update-password'
import { sessionKeystoreFactory, testKeystoreBundleFrom, testRootKeystore, testSessionKeystore } from './helpers/keystore-bundle'
import { signedCallsResult, testFeeCap } from './helpers/signed-calls'
import { testBaseKeys } from './helpers/authorized-key'

const account = '0x1111111111111111111111111111111111111111'

const oldSessionKey = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

const newSessionKey = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'

const oldAddress = privateKeyToAccount(oldSessionKey).address

const newAddress = privateKeyToAccount(newSessionKey).address

const rootPrivateKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const txHash = '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca'

const oldSession = testSessionKeystore(oldAddress, account, {
    name: 'default',
    checkpoint: 'authorized',
    network: {
        env: 'stage',
        relayerUrl: 'http://127.0.0.1:8787',
        rpcUrl: 'https://mainnet.base.org',
        chainId: 8453,
    },
})

const newSession = testSessionKeystore(newAddress, account, {
    name: 'default-next',
    checkpoint: 'pending_rotation',
    network: oldSession.network,
})

function rootBundle() {
    return testKeystoreBundleFrom(
        {
            addresses: { root: account, delegated: account },
            sessionRef: { active: 'default', dir: 'sessions' },
            network: oldSession.network,
            createdAt: '2020-01-01T00:00:00.000Z',
            checkpoint: 'delegated',
        },
        oldSession,
    )
}

async function withStage<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.RELAYER_URL_STAGE
    process.env.RELAYER_URL_STAGE = 'http://127.0.0.1:8787'
    // Published JSON is zero. This file's stage/Base rotations still need the
    // former stage addresses, and only for the test that calls withStage.
    const restoreStage = installFormerStageDeployments()

    try {
        return await fn()
    } finally {
        restoreStage()

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

function rotateDeps<E>(keystorePath: string, overrides?: E) {
    return {
        withKeystoreLock: typedMock<SessionRotateDeps['withKeystoreLock']>(passthroughKeystoreLock),
        readKeystoreBundle: typedMock<SessionRotateDeps['readKeystoreBundle']>(async () => rootBundle()),
        readSessionKeystoreFile: typedMock<SessionRotateDeps['readSessionKeystoreFile']>(async (path: string) =>
            path.endsWith('default-next.json') ? newSession : oldSession,
        ),
        createSessionKeystore: typedMock<SessionRotateDeps['createSessionKeystore']>(sessionKeystoreFactory(newSession)),
        writeSessionKeystoreFile: typedMock<SessionRotateDeps['writeSessionKeystoreFile']>(async () => {}),
        writeRootKeystoreFile: typedMock<SessionRotateDeps['writeRootKeystoreFile']>(async () => {}),
        generatePrivateKey: typedMock<SessionRotateDeps['generatePrivateKey']>(() => rootPrivateKey),
        decryptRootKeystore: typedMock<SessionRotateDeps['decryptRootKeystore']>(async () => ({ rootPrivateKey })),
        decryptSessionKeystore: typedMock<SessionRotateDeps['decryptSessionKeystore']>(async (keystore: { addresses: { session: string } }) => {
            const session = getAddress(parseAddr(keystore.addresses.session))

            if (session === newAddress) return { sessionPrivateKey: newSessionKey }

            return { sessionPrivateKey: oldSessionKey }
        }),
        readNonce: typedMock<SessionRotateDeps['readNonce']>(async () => 1n),
        readActiveUsdcDaily: typedMock<SessionRotateDeps['readActiveUsdcDaily']>(async () => 0n),
        getKeys: typedMock<SessionRotateDeps['getKeys']>(async () =>
            testBaseKeys(computeSessionKeyHash(oldAddress)),
        ),
        readGuardCleanup: typedMock<SessionRotateDeps['readGuardCleanup']>(async (input: { chainId: number }) => {
            if (input.chainId === 137) {
                return {
                    anyCalls: [{ target: account, selector: '0xa9059cbb' }],
                    checkers: [],
                }
            }

            return { anyCalls: [], checkers: [] }
        }),
        executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
            const decoded = params.calls.map((call) =>
                decodeFunctionData({ abi: accountAbi, data: call.data }),
            )

            if (decoded.some((entry) => entry.functionName === 'authorize')) {
                return signedCallsResult(testFeeCap(), 'bundle-selected', txHash)
            }

            throw new Error('polygon cleanup failed')
        }),
        waitForBundle: typedMock<SessionRotateDeps['waitForBundle']>(async () =>
            confirmedBundle('bundle-selected', txHash),
        ),
        prepareCalls: typedMock<SessionRotateDeps['prepareCalls']>(async () => {
            throw new Error('prepareCalls should not run')
        }),
        signTypedData: typedMock<SessionRotateDeps['signTypedData']>(async () => {
            throw new Error('signTypedData should not run')
        }),
        sendPreparedCalls: typedMock<SessionRotateDeps['sendPreparedCalls']>(async () => {
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
            rotateDeps(keystorePath),
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
            rotateDeps(keystorePath),
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
                readKeystoreBundle: typedMock<SessionRotateDeps['readKeystoreBundle']>(async () => rootBundle()),
                readSessionKeystoreFile: typedMock<SessionRotateDeps['readSessionKeystoreFile']>(async (path: string) =>
                    path.endsWith('other.json')
                        ? {
                              ...oldSession,
                              name: 'other',
                              addresses: { ...oldSession.addresses, session: newAddress },
                          }
                        : oldSession,
                ),
            },
        )

        expect(listed.status).toBe('complete')
        expect(listed.sessions.map((session) => session.name).sort()).toEqual(['default', 'other'])

        const permissions = await executePermissionsList(
            { env: 'stage', chain: 'base', keystorePath },
            {
                readKeystoreBundle: typedMock<SessionRotateDeps['readKeystoreBundle']>(async () => rootBundle()),
                readSessionKeystoreFile: typedMock<SessionRotateDeps['readSessionKeystoreFile']>(async () => oldSession),
                getKeys: typedMock<SessionRotateDeps['getKeys']>(async () => ({})),
            },
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
                withKeystoreLock: typedMock<SessionRotateDeps['withKeystoreLock']>(passthroughKeystoreLock),
                readKeystoreBundle: typedMock<SessionRotateDeps['readKeystoreBundle']>(async () => rootBundle()),
                readSessionKeystoreFile: typedMock<SessionRotateDeps['readSessionKeystoreFile']>(async () => oldSession),
                getKeys: typedMock<SessionRotateDeps['getKeys']>(async () => ({})),
                unlink: typedMock<SessionRotateDeps['unlink']>(async () => {}),
                writeRootKeystoreFile: typedMock<SessionRotateDeps['writeRootKeystoreFile']>(async () => {}),
            },
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
                withKeystoreLock: typedMock<SessionRotateDeps['withKeystoreLock']>(passthroughKeystoreLock),
                readKeystoreBundle: typedMock<SessionRotateDeps['readKeystoreBundle']>(async () => bundle),
                readSessionKeystoreFile: typedMock<SessionRotateDeps['readSessionKeystoreFile']>(async (path: string) =>
                    path.endsWith('other.json') ? { ...oldSession, name: 'other' } : oldSession,
                ),
                decryptRootKeystore: typedMock<SessionRotateDeps['decryptRootKeystore']>(async () => ({ rootPrivateKey })),
                decryptSessionKeystore: typedMock<SessionRotateDeps['decryptSessionKeystore']>(async () => ({
                    sessionPrivateKey: rootPrivateKey,
                })),
                createRootKeystore: typedMock<AccountUpdatePasswordDeps['createRootKeystore']>(async () =>
                    testRootKeystore({ network: bundle.root.network }),
                ),
                createSessionKeystore: typedMock<SessionRotateDeps['createSessionKeystore']>(sessionKeystoreFactory(oldSession)),
                writeRootKeystoreFile: typedMock<SessionRotateDeps['writeRootKeystoreFile']>(async () => {}),
                writeSessionKeystoreFile: typedMock<SessionRotateDeps['writeSessionKeystoreFile']>(async () => {}),
            },
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
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(
                        async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                            for (const call of params.calls) signed.push(call.data)

                            return signedCallsResult(testFeeCap(), 'bundle-evil', txHash)
                        },
                    ),
                }),
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
                    account,
                    oldKeyHash: computeSessionKeyHash(oldAddress),
                    permissions: { kind: 'fullAccess' },
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
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(
                        async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                            for (const call of params.calls) signed.push(call.data)

                            return signedCallsResult(testFeeCap(), 'bundle-evil', txHash)
                        },
                    ),
                }),
            ),
        ).rejects.toThrow(/ROTATE FULL ACCESS SESSION/)
        expect(signed).toEqual([])
    })
})

test('plain resume of a full-access marker tells the user to rerun with --resume --full-access', async () => {
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
                    account,
                    oldKeyHash: computeSessionKeyHash(oldAddress),
                    permissions: { kind: 'fullAccess' },
                },
                null,
                2,
            )}\n`,
        )

        const signed: Hex[] = []

        const signTypedData = mock(async () => {
            throw new Error('signTypedData should not run')
        })

        const sendPreparedCalls = mock(async () => {
            throw new Error('sendPreparedCalls should not run')
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
                rotateDeps(keystorePath, {
                    signTypedData,
                    sendPreparedCalls,
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(
                        async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                            for (const call of params.calls) signed.push(call.data)

                            return signedCallsResult(testFeeCap(), 'bundle-evil', txHash)
                        },
                    ),
                }),
            ),
        ).rejects.toThrow(/tw session rotate --resume --full-access/)
        expect(signed).toEqual([])
        expect(signTypedData).not.toHaveBeenCalled()
        expect(sendPreparedCalls).not.toHaveBeenCalled()
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
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(
                        async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                            for (const call of params.calls) signed.push(call.data)

                            return signedCallsResult(testFeeCap(), 'bundle-bad', txHash)
                        },
                    ),
                }),
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
                    readGuardCleanup: typedMock<SessionRotateDeps['readGuardCleanup']>(async () => ({ anyCalls: [], checkers: [] })),
                    unlink: typedMock<SessionRotateDeps['unlink']>(async (path: string) => {
                        unlinked.push(path)
                    }),
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(async () => {
                        throw new Error(
                            'Timeout waiting for bundle bundle-timeout to reach final status. Current status: 100',
                        )
                    }),
                }),
            )
        } catch (error) {
            caught = error
        }

        expect(caught).toMatchObject({
            code: 'ROTATION_SUBMITTED',
            recoveryCommand: 'tw session rotate --resume',
        })
        expect(caught).toBeInstanceOf(Error)

        if (!(caught instanceof Error)) throw caught

        expect(caught.message).toMatch(/--resume/)

        const onDisk = await readdir(sessions)

        const markers = onDisk.filter(
            (name) => name.startsWith('.rotation') && name.endsWith('.json'),
        )

        expect(markers).toHaveLength(1)

        const raw: { status?: string; bundleId?: string } = JSON.parse(
            await readFile(join(sessions, markers[0]!), 'utf8'),
        )

        expect(raw.status).toBe('submitted')
        expect(raw.bundleId).toBe('bundle-timeout')
        expect(unlinked.some((path) => path.endsWith('default-next.json'))).toBe(false)
    })
})

test('rotation without --resume refuses an existing marker and does not authorize again', async () => {
    await withStage(async () => {
        const { keystorePath, sessions } = await stageDir()
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
                rotateDeps(keystorePath, {
                    readGuardCleanup: typedMock<SessionRotateDeps['readGuardCleanup']>(async () => ({ anyCalls: [], checkers: [] })),
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(async () => {
                        throw new Error(
                            'Timeout waiting for bundle bundle-timeout to reach final status. Current status: 100',
                        )
                    }),
                }),
            ),
        ).rejects.toMatchObject({ code: 'ROTATION_SUBMITTED' })

        const before: { newSessionName?: string; bundleId?: string } = JSON.parse(
            await readFile(join(sessions, '.rotation.json'), 'utf8'),
        )

        const signed: Hex[] = []

        const signTypedData = mock(async () => {
            throw new Error('signTypedData should not run')
        })

        const sendPreparedCalls = mock(async () => {
            throw new Error('sendPreparedCalls should not run')
        })

        await expect(
            executeSessionRotate(
                {
                    env: 'stage',
                    chain: 'base',
                    keystorePath,
                    password: 'pw',
                    narrow: true,
                    newName: 'default-other',
                },
                rotateDeps(keystorePath, {
                    readGuardCleanup: typedMock<SessionRotateDeps['readGuardCleanup']>(async () => ({ anyCalls: [], checkers: [] })),
                    signTypedData,
                    sendPreparedCalls,
                    executeSignedCalls: typedMock<SessionRotateDeps['executeSignedCalls']>(
                        async (_deps: unknown, params: { calls: { data: Hex }[] }) => {
                            for (const call of params.calls) signed.push(call.data)

                            return signedCallsResult(testFeeCap(), 'bundle-second', txHash)
                        },
                    ),
                }),
            ),
        ).rejects.toThrow(/tw session rotate --resume/)
        expect(signed).toEqual([])
        expect(signTypedData).not.toHaveBeenCalled()
        expect(sendPreparedCalls).not.toHaveBeenCalled()

        const after: { newSessionName?: string; bundleId?: string } = JSON.parse(
            await readFile(join(sessions, '.rotation.json'), 'utf8'),
        )

        expect(after.newSessionName).toBe(before.newSessionName)
        expect(after.bundleId).toBe(before.bundleId)
    })
})

test('resume after the pointer moved finishes cleanup and signs nothing', async () => {
    await withStage(async () => {
        const { keystorePath, sessions } = await stageDir()
        await writeFile(join(sessions, 'default-next.json'), '{}\n')
        const hash = computeSessionKeyHash(newAddress)
        await writeFile(
            join(sessions, '.rotation.json'),
            `${JSON.stringify(
                await sealRotationMarker(
                    {
                        oldSessionName: 'default',
                        newSessionName: 'default-next',
                        status: 'submitted',
                        bundleId: 'bundle-done',
                        chain: 'base',
                        chainId: 8453,
                        newKeyHash: hash,
                        narrow: true,
                        fullAccess: false,
                        account,
                        oldKeyHash: computeSessionKeyHash(oldAddress),
                        permissions: { kind: 'narrow' },
                    },
                    'pw',
                ),
                null,
                2,
            )}\n`,
        )

        const signTypedData = mock(async () => {
            throw new Error('signTypedData should not run')
        })

        const sendPreparedCalls = mock(async () => {
            throw new Error('sendPreparedCalls should not run')
        })

        const executeSigned = mock(async () => {
            throw new Error('executeSignedCalls should not run')
        })

        const result = await executeSessionRotate(
            {
                env: 'stage',
                chain: 'base',
                keystorePath,
                password: 'pw',
                resume: true,
            },
            rotateDeps(keystorePath, {
                readKeystoreBundle: typedMock<SessionRotateDeps['readKeystoreBundle']>(async () => {
                    const bundle = rootBundle()
                    bundle.root.sessionRef.active = 'default-next'

                    return bundle
                }),
                readGuardCleanup: typedMock<SessionRotateDeps['readGuardCleanup']>(async () => ({ anyCalls: [], checkers: [] })),
                getKeys: typedMock<SessionRotateDeps['getKeys']>(async () => testBaseKeys(hash)),
                signTypedData,
                sendPreparedCalls,
                executeSignedCalls: executeSigned,
            }),
        )

        expect(result.status).toBe('complete')
        expect(result.newSessionName).toBe('default-next')
        expect(signTypedData).not.toHaveBeenCalled()
        expect(sendPreparedCalls).not.toHaveBeenCalled()
        expect(executeSigned).not.toHaveBeenCalled()
        const onDisk = await readdir(sessions)
        expect(onDisk).not.toContain('.rotation.json')
        expect(onDisk).not.toContain('default.json')
        expect(onDisk).toContain('default-next.json')
    })
})
