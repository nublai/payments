import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { getAddress } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { EscrowError } from '../src/lib/escrow-common'
import { createEscrowPasswordResolver, loadEscrowSessionAndSender } from '../src/lib/escrow-execute'
import { executeEscrowRefund } from '../src/lib/escrow-refund'
import { createSessionKeystore, writeSessionKeystoreFile } from '../src/lib/keystore'

test('createEscrowPasswordResolver returns provided non-empty password', async () => {
    const resolve = createEscrowPasswordResolver({ password: 'secret' })
    expect(await resolve()).toBe('secret')
    expect(await resolve()).toBe('secret')
})

test('createEscrowPasswordResolver returns provided empty password', async () => {
    const resolve = createEscrowPasswordResolver({ password: '' })
    expect(await resolve()).toBe('')
    expect(await resolve()).toBe('')
})

test('createEscrowPasswordResolver calls resolvePassword when password not provided', async () => {
    const resolve = createEscrowPasswordResolver({
        resolvePassword: async () => 'from-resolver',
    })

    expect(await resolve()).toBe('from-resolver')
    expect(await resolve()).toBe('from-resolver')
})

test('createEscrowPasswordResolver throws PASSWORD_REQUIRED when neither password nor resolvePassword', async () => {
    const resolve = createEscrowPasswordResolver({})
    await expect(resolve()).rejects.toMatchObject({
        name: 'EscrowError',
        code: 'PASSWORD_REQUIRED',
    })
})

test('loadEscrowSessionAndSender falls back to login session profile when root keystore is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-escrow-login-profile-'))
    const rootPath = join(dir, 'default.keystore.json')
    const sessionPath = join(dir, 'session.json')

    try {
        const session = await createSessionKeystore({
            password: 'password',
            sessionPrivateKey: generatePrivateKey(),
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
            delegated: '0x1111111111111111111111111111111111111111',
            name: 'default',
            checkpoint: 'authorized',
            kind: 'login',
            delegateAuth: {
                sig: '0x1234',
                expiryEpochMs: Date.now() + 60_000,
            },
            bearerToken: '0x010203',
        })

        await writeSessionKeystoreFile(sessionPath, session)

        const loaded = await loadEscrowSessionAndSender(
            {
                env: 'prod',
                keystorePath: rootPath,
            },
            8453,
        )

        expect(loaded.sessionKeystore.kind).toBe('login')
        expect(loaded.sender).toBe(getAddress(session.addresses.delegated))
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('loadEscrowSessionAndSender falls back to session-only profile when root keystore is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-escrow-session-only-profile-'))
    const rootPath = join(dir, 'default.keystore.json')
    const sessionPath = join(dir, 'session.json')

    try {
        const session = await createSessionKeystore({
            password: 'password',
            sessionPrivateKey: generatePrivateKey(),
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'https://mainnet.base.org',
                chainId: 8453,
            },
            delegated: '0x1111111111111111111111111111111111111111',
            name: 'default',
        })

        await writeSessionKeystoreFile(sessionPath, session)

        const loaded = await loadEscrowSessionAndSender(
            {
                env: 'prod',
                keystorePath: rootPath,
            },
            8453,
        )

        expect(loaded.sessionKeystore.kind).toBeUndefined()
        expect(loaded.sender).toBe(getAddress(session.addresses.delegated))
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('executeEscrowRefund reports KEYSTORE_NOT_FOUND when neither root keystore nor session.json exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-escrow-empty-profile-'))
    const rootPath = join(dir, 'default.keystore.json')
    const zeroAddress = '0x0000000000000000000000000000000000000000' as const

    const prepareCalls = mock(async () => {
        throw new Error('prepareCalls should not be called')
    })

    try {
        const err = await executeEscrowRefund(
            {
                env: 'prod',
                escrowId: `0x${'ab'.repeat(32)}`,
                keystorePath: rootPath,
                password: 'password',
            },
            {
                resolveEscrowChainNetworkContracts: mock(() => ({
                    chain: 'base' as const,
                    network: {
                        env: 'prod' as const,
                        relayerUrl: 'http://127.0.0.1:8787',
                        rpcUrl: 'https://mainnet.base.org',
                        chainId: 8453,
                    },
                    contracts: {
                        escrowAddress: zeroAddress,
                        simpleSettlerAddress: zeroAddress,
                        usdcAddress: zeroAddress,
                    },
                })),
                executeSignedCallsDeps: { prepareCalls },
            },
        ).catch((error) => error)

        expect(err).toBeInstanceOf(EscrowError)
        expect((err as EscrowError).code).toBe('KEYSTORE_NOT_FOUND')
        const cause = (err as EscrowError).cause as NodeJS.ErrnoException
        expect(cause.code).toBe('ENOENT')
        expect(cause.path).toBe(join(dir, 'session.json'))
        expect(prepareCalls).not.toHaveBeenCalled()
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
