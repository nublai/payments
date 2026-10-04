import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { createEscrowPasswordResolver, loadEscrowSessionAndSender } from '../src/lib/escrow-execute'
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
