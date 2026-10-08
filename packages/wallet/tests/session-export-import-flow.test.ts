import { expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generatePrivateKey } from 'viem/accounts'
import { getDefaultKeystorePath } from '../src/lib/account-create'
import {
    createRootKeystore,
    createSessionKeystore,
    decryptSessionKeystore,
    resolveSessionKeystorePath,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
} from '../src/lib/keystore'
import { executeSessionExport, resolveSessionExportPasswords } from '../src/lib/session-export'
import { executeSessionImport } from '../src/lib/session-import'

test('executeSessionExport re-encrypts a session into output file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-session-export-'))
    const rootPath = join(dir, 'default.keystore.json')
    const outputPath = join(dir, 'worker-1.session.json')

    try {
        const root = await createRootKeystore({
            password: 'old',
            rootPrivateKey: generatePrivateKey(),
            env: 'prod',
            relayerUrl: 'https://relayer.example',
            rpcUrl: 'https://rpc.example',
            chainId: 8453,
            activeSession: 'default',
            sessionsDir: 'sessions',
        })

        root.addresses.delegated = root.addresses.root
        root.checkpoint = 'complete'

        const session = await createSessionKeystore({
            password: 'old',
            sessionPrivateKey: generatePrivateKey(),
            network: root.network,
            delegated: root.addresses.root,
            name: 'default',
            checkpoint: 'authorized',
        })

        await writeRootKeystoreFile(rootPath, root)
        await writeSessionKeystoreFile(
            resolveSessionKeystorePath(rootPath, 'default', 'sessions'),
            session,
        )

        const result = await executeSessionExport({
            env: 'prod',
            sessionName: 'default',
            output: outputPath,
            keystorePath: rootPath,
            password: 'old',
            exportPassword: 'new',
        })

        expect(result.status).toBe('complete')

        const exportedRaw = JSON.parse(await readFile(outputPath, 'utf8'))
        expect(exportedRaw.addresses.delegated).toBe(root.addresses.root)
        await expect(decryptSessionKeystore(exportedRaw, 'new')).resolves.toBeTruthy()
        await expect(decryptSessionKeystore(exportedRaw, 'old')).rejects.toBeTruthy()
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('executeSessionImport installs a session-only profile file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-session-import-'))
    const inputPath = join(dir, 'worker-1.session.json')
    const profile = `worker-${Date.now()}`

    try {
        const network = {
            env: 'prod',
            relayerUrl: 'https://relayer.example',
            rpcUrl: 'https://rpc.example',
            chainId: 8453,
        }

        const portable = await createSessionKeystore({
            password: 'pw',
            sessionPrivateKey: generatePrivateKey(),
            network,
            delegated: '0x1111111111111111111111111111111111111111',
            name: 'worker-1',
            checkpoint: 'authorized',
        })

        await writeSessionKeystoreFile(inputPath, portable, { overwrite: true })

        const result = await executeSessionImport({
            input: inputPath,
            profile,
        })

        expect(result.status).toBe('complete')
        expect(result.sessionPath.endsWith(`/profiles/${profile}/session.json`)).toBe(true)
    } finally {
        await rm(join(process.env.HOME ?? '', '.config', 'agentic-payments', 'tw', 'profiles', profile), {
            recursive: true,
            force: true,
        })
        await rm(dir, { recursive: true, force: true })
    }
})

test('executeSessionImport stores non-prod session profiles under env directory', async () => {
    const profile = 'worker-dev'
    const inputPath = '/tmp/worker-dev.session.json'

    const accessMock = mock(async (path: string) => {
        // Simulate ENOENT for conflict checks.
        throw new Error(`ENOENT: no such file or directory, access '${path}'`)
    })

    const result = await executeSessionImport(
        {
            input: inputPath,
            profile,
            env: 'dev',
        } as any,
        {
            readSessionKeystoreFile: mock(async () => ({ version: 2 })),
            writeSessionKeystoreFile: mock(async () => {}),
            access: accessMock,
            mkdir: mock(async () => undefined),
        },
    )

    expect(result.status).toBe('complete')
    expect(result.sessionPath.endsWith(`/profiles/dev/${profile}/session.json`)).toBe(true)
})

test('executeSessionImport keeps profile path aligned with default keystore resolution', async () => {
    const profile = 'worker-stage'
    const env = 'stage'
    const inputPath = '/tmp/worker-stage.session.json'

    const result = await executeSessionImport(
        {
            input: inputPath,
            profile,
            env,
        } as any,
        {
            readSessionKeystoreFile: mock(async () => ({ version: 2 })),
            writeSessionKeystoreFile: mock(async () => {}),
            access: mock(async () => {
                throw new Error('ENOENT: no such file or directory')
            }),
            mkdir: mock(async () => undefined),
        },
    )

    expect(result.status).toBe('complete')
    expect(dirname(result.sessionPath)).toBe(dirname(getDefaultKeystorePath(env, profile)))
})

test('resolveSessionExportPasswords reads stdin once when both stdin flags are set', async () => {
    const readPasswordFromStdin = mock(() => 'stdin-secret')

    const result = await resolveSessionExportPasswords(
        { passwordStdin: true, exportPasswordStdin: true },
        {
            readPasswordFromStdin,
            promptForExistingPassword: async () => 'ignored',
            promptForExportPassword: async () => 'ignored',
            isInteractive: false,
        },
    )

    expect(result).toEqual({
        password: 'stdin-secret',
        exportPassword: 'stdin-secret',
    })
    expect(readPasswordFromStdin).toHaveBeenCalledTimes(1)
})
