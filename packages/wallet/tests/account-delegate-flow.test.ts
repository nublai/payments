import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import type { Address } from 'viem'
import { executeAccountDelegate, resolveAccountDelegatePassword } from '../src/lib/account-delegate'
import type { RelayerRootKeystoreV2, RelayerSessionKeystoreV2 } from '../src/lib/keystore'
import { installFormerProdDeployments } from './helpers/former-deployment-env'

const ROOT_ADDRESS: Address = '0x1111111111111111111111111111111111111111'

let restoreFormerProdDeployments = () => {}

beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})

afterAll(() => {
    restoreFormerProdDeployments()
})

function makeRootKeystore(overrides?: Partial<RelayerRootKeystoreV2>): RelayerRootKeystoreV2 {
    return {
        version: 2,
        createdAt: '2026-02-26T00:00:00.000Z',
        checkpoint: 'initialized',
        network: {
            env: 'prod',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'https://mainnet.base.org',
            chainId: 8453 },
        addresses: {
            root: ROOT_ADDRESS },
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
        createdAt: '2026-02-26T00:00:00.000Z',
        name: 'default',
        checkpoint: 'initialized',
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

test('resolveAccountDelegatePassword prefers env password', async () => {
    const password = await resolveAccountDelegatePassword(
        {
            env: 'prod',
            chains: ['base'],
            passwordStdin: true,
            json: false,
            help: false },
        {
            envPassword: 'from-env',
            readPasswordFromStdin: () => {
                throw new Error('should not read stdin')
            },
            promptForExistingPassword: async () => {
                throw new Error('should not prompt')
            },
            isInteractive: true },
    )

    expect(password).toBe('from-env')
})

test('resolveAccountDelegatePassword reads stdin when requested', async () => {
    const password = await resolveAccountDelegatePassword(
        {
            env: 'prod',
            chains: ['base'],
            passwordStdin: true,
            json: false,
            help: false },
        {
            readPasswordFromStdin: () => 'stdin-password',
            promptForExistingPassword: async () => 'prompt-password',
            isInteractive: true },
    )

    expect(password).toBe('stdin-password')
})

test('resolveAccountDelegatePassword uses interactive prompt', async () => {
    const password = await resolveAccountDelegatePassword(
        {
            env: 'prod',
            chains: ['base'],
            passwordStdin: false,
            json: false,
            help: false },
        {
            readPasswordFromStdin: () => {
                throw new Error('should not read stdin')
            },
            promptForExistingPassword: async () => 'prompt-password',
            isInteractive: true },
    )

    expect(password).toBe('prompt-password')
})

test('resolveAccountDelegatePassword throws when no password source exists', async () => {
    await expect(
        resolveAccountDelegatePassword(
            {
                env: 'prod',
                chains: ['base'],
                passwordStdin: false,
                json: false,
                help: false },
            {
                readPasswordFromStdin: () => 'unused',
                promptForExistingPassword: async () => 'unused',
                isInteractive: false },
        ),
    ).rejects.toMatchObject({
        name: 'AccountDelegateError',
        code: 'PASSWORD_REQUIRED' })
})

test('executeAccountDelegate delegates or skips already delegated chains', async () => {
    const root = makeRootKeystore()
    const session = makeSessionKeystore()
    const writeRootKeystoreFile = mock(async () => {})

    const result = await executeAccountDelegate(
        {
            env: 'prod',
            chains: ['base', 'polygon'],
            keystorePath: '/tmp/alice.json',
            password: 'pw' },
        {
            readKeystoreBundle: mock(async () => ({
                format: 'split',
                rootPath: '/tmp/alice.json',
                sessionPath: '/tmp/sessions/default.json',
                root,
                session })),
            decryptRootKeystore: mock(async () => ({
                rootPrivateKey:
                    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' })),
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' })),
            getDelegatedCode: mock(async ({ network }) =>
                network.chainId === 8453 ? ('0x') : ('0xef0100'),
            ),
            delegateAccount: mock(async () => ({
                accountAddress: ROOT_ADDRESS,
                txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })),
            writeRootKeystoreFile },
    )

    expect(result.type).toBe('account_delegate')
    expect(result.hasFailures).toBe(false)
    expect(result.results).toHaveLength(2)
    expect(result.results[0]?.chain).toBe('base')
    expect(result.results[0]?.status).toBe('delegated')
    expect(result.results[1]?.chain).toBe('polygon')
    expect(result.results[1]?.status).toBe('already_delegated')
    expect(writeRootKeystoreFile).toHaveBeenCalledTimes(1)
})

test('executeAccountDelegate returns failed chain results and hasFailures=true', async () => {
    const root = makeRootKeystore()
    const session = makeSessionKeystore()

    const result = await executeAccountDelegate(
        {
            env: 'prod',
            chains: ['base', 'polygon'],
            keystorePath: '/tmp/alice.json',
            password: 'pw' },
        {
            readKeystoreBundle: mock(async () => ({
                format: 'split',
                rootPath: '/tmp/alice.json',
                sessionPath: '/tmp/sessions/default.json',
                root,
                session })),
            decryptRootKeystore: mock(async () => ({
                rootPrivateKey:
                    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' })),
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' })),
            getDelegatedCode: mock(async () => '0x'),
            delegateAccount: mock(async ({ network }) => {
                if (network.chainId === 137) {
                    throw new Error('Delegation failed: rpc error')
                }

                return {
                    accountAddress: ROOT_ADDRESS,
                    txHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
            }),
            writeRootKeystoreFile: mock(async () => {}) },
    )

    expect(result.hasFailures).toBe(true)
    expect(result.results[0]?.status).toBe('delegated')
    expect(result.results[1]?.status).toBe('failed')
    expect(result.results[1]?.errorCode).toBe('DELEGATION_FAILED')
})
