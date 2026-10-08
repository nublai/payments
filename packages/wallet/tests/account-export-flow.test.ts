import { expect, mock, test } from 'bun:test'
import {
    assertCanExportPrivateKeys,
    executeAccountExport,
    resolveAccountExportPassword,
} from '../src/lib/account-export'
import type { RelayerRootKeystoreV2, RelayerSessionKeystoreV2 } from '../src/lib/keystore'

function makeRootKeystore(overrides?: Partial<RelayerRootKeystoreV2>): RelayerRootKeystoreV2 {
    return {
        version: 2,
        createdAt: '2026-02-19T00:00:00.000Z',
        checkpoint: 'complete',
        network: {
            env: 'prod',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'https://mainnet.base.org',
            chainId: 8453 },
        addresses: {
            root: '0x1111111111111111111111111111111111111111',
            delegated: '0x3333333333333333333333333333333333333333' },
        sessionRef: {
            active: 'default',
            dir: 'sessions' },
        kdf: {
            name: 'argon2id',
            params: {
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1,
                hashLength: 32,
                salt: 'dGVzdA==' } },
        crypto: { algorithm: 'aes-256-gcm' },
        secrets: {
            rootPrivateKey: { nonce: 'a', ciphertext: 'b', tag: 'c' } },
        ...overrides }
}

function makeSessionKeystore(
    overrides?: Partial<RelayerSessionKeystoreV2>,
): RelayerSessionKeystoreV2 {
    return {
        version: 2,
        createdAt: '2026-02-19T00:00:00.000Z',
        name: 'default',
        checkpoint: 'authorized',
        network: {
            env: 'prod',
            relayerUrl: 'https://relayer.example',
            rpcUrl: 'https://rpc.example',
            chainId: 8453 },
        kdf: {
            name: 'argon2id',
            params: {
                memoryCost: 19456,
                timeCost: 2,
                parallelism: 1,
                hashLength: 32,
                salt: 'dGVzdA==' } },
        crypto: { algorithm: 'aes-256-gcm' },
        addresses: {
            session: '0x2222222222222222222222222222222222222222',
            delegated: '0x1111111111111111111111111111111111111111' },
        secrets: {
            sessionPrivateKey: { nonce: 'd', ciphertext: 'e', tag: 'f' } },
        ...overrides }
}

test('executeAccountExport returns metadata by default without decrypting', async () => {
    const root = makeRootKeystore()
    const session = makeSessionKeystore()

    const decrypt = mock(async () => {
        throw new Error('should not decrypt in metadata mode')
    })

    const result = await executeAccountExport(
        {
            env: 'prod',
            keystorePath: '/tmp/test-keystore.json',
            showPrivate: false },
        {
            readKeystoreBundle: mock(async () => ({
                rootPath: '/tmp/test-keystore.json',
                sessionPath: '/tmp/sessions/default.json',
                root,
                session })),
            decryptRootKeystore: decrypt,
            decryptSessionKeystore: decrypt },
    )

    expect(result.type).toBe('account_export')
    expect(result.status).toBe('complete')
    expect(result.addresses.root).toBe(root.addresses.root)
    expect(result.addresses.session).toBe(session.addresses.session)
    expect(result.secrets).toBeUndefined()
    expect(decrypt).toHaveBeenCalledTimes(0)
})

test('executeAccountExport includes secrets when --show-private is enabled', async () => {
    const root = makeRootKeystore()
    const session = makeSessionKeystore()

    const rootPrivateKey =
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

    const sessionPrivateKey =
        '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7'

    const result = await executeAccountExport(
        {
            env: 'prod',
            keystorePath: '/tmp/test-keystore.json',
            showPrivate: true,
            password: 'password' },
        {
            readKeystoreBundle: mock(async () => ({
                rootPath: '/tmp/test-keystore.json',
                sessionPath: '/tmp/sessions/default.json',
                root,
                session })),
            decryptRootKeystore: mock(async () => ({ rootPrivateKey })),
            decryptSessionKeystore: mock(async () => ({ sessionPrivateKey })) },
    )

    expect(result.secrets?.rootPrivateKey).toBe(rootPrivateKey)
    expect(result.secrets?.sessionPrivateKey).toBe(sessionPrivateKey)
})

test('executeAccountExport rejects private export without password', async () => {
    const root = makeRootKeystore()
    const session = makeSessionKeystore()
    await expect(
        executeAccountExport(
            {
                env: 'prod',
                keystorePath: '/tmp/test-keystore.json',
                showPrivate: true },
            {
                readKeystoreBundle: mock(async () => ({
                    rootPath: '/tmp/test-keystore.json',
                    sessionPath: '/tmp/sessions/default.json',
                    root,
                    session })) },
        ),
    ).rejects.toMatchObject({
        code: 'PASSWORD_REQUIRED' })
})

test('assertCanExportPrivateKeys rejects non-interactive export', async () => {
    await expect(
        assertCanExportPrivateKeys({
            showPrivate: true,
            isInteractive: false,
            promptForTypedConfirmation: async () => true }),
    ).rejects.toMatchObject({
        code: 'PRIVATE_EXPORT_CONFIRMATION_REQUIRED' })
})

test('assertCanExportPrivateKeys rejects non-interactive export even when a password is available', async () => {
    const prompt = mock(async () => {
        throw new Error('should not ask for typed confirmation')
    })

    await expect(
        assertCanExportPrivateKeys({
            showPrivate: true,
            isInteractive: false,
            promptForTypedConfirmation: prompt }),
    ).rejects.toMatchObject({
        code: 'PRIVATE_EXPORT_CONFIRMATION_REQUIRED' })
    expect(prompt).not.toHaveBeenCalled()
})

test('assertCanExportPrivateKeys rejects MCP export even on a TTY', async () => {
    const prompt = mock(async () => true)
    await expect(
        assertCanExportPrivateKeys({
            showPrivate: true,
            isInteractive: true,
            mcp: true,
            promptForTypedConfirmation: prompt }),
    ).rejects.toMatchObject({
        code: 'PRIVATE_EXPORT_CONFIRMATION_REQUIRED' })
    expect(prompt).not.toHaveBeenCalled()
})

test('assertCanExportPrivateKeys rejects failed confirmation', async () => {
    await expect(
        assertCanExportPrivateKeys({
            showPrivate: true,
            isInteractive: true,
            promptForTypedConfirmation: async () => false }),
    ).rejects.toMatchObject({
        code: 'PRIVATE_EXPORT_CONFIRMATION_FAILED' })
})

test('executeAccountExport maps invalid profile name to AccountExportError', async () => {
    await expect(
        executeAccountExport({
            env: 'prod',
            name: 'alice.dev',
            showPrivate: false }),
    ).rejects.toMatchObject({
        name: 'AccountExportError',
        code: 'INVALID_NAME' })
})

test('resolveAccountExportPassword uses env password first', async () => {
    const password = await resolveAccountExportPassword(
        {
            env: 'prod',
            json: false,
            passwordStdin: false,
            showPrivate: true,
            help: false },
        {
            envPassword: 'from-env',
            readPasswordFromStdin: () => 'ignored',
            promptForExistingPassword: async () => 'ignored',
            isInteractive: true },
    )

    expect(password).toBe('from-env')
})

test('resolveAccountExportPassword uses stdin when requested', async () => {
    const password = await resolveAccountExportPassword(
        {
            env: 'prod',
            json: false,
            passwordStdin: true,
            showPrivate: true,
            help: false },
        {
            readPasswordFromStdin: () => 'from-stdin',
            promptForExistingPassword: async () => 'ignored',
            isInteractive: true },
    )

    expect(password).toBe('from-stdin')
})

test('resolveAccountExportPassword uses existing-password prompt for interactive export', async () => {
    const password = await resolveAccountExportPassword(
        {
            env: 'prod',
            json: false,
            passwordStdin: false,
            showPrivate: true,
            help: false },
        {
            readPasswordFromStdin: () => 'ignored',
            promptForExistingPassword: async () => 'existing-password',
            isInteractive: true },
    )

    expect(password).toBe('existing-password')
})
