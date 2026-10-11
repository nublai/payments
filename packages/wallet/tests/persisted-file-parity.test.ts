import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { generatePrivateKey } from 'viem/accounts'
import { readAgentChannelRegistry } from '../src/lib/agent-channel-registry'
import {
    createRootKeystore,
    createSessionKeystore,
    isRootKeystoreV2,
    readKeystoreBundle,
    readSessionKeystoreFile,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
} from '../src/lib/keystore'
import { hasLegacyRecipientAlias } from '../src/lib/legacy-recipient-aliases'
import { readPendingQuoteLimit } from '../src/lib/quote-spend-pending'
import { getDefaultDeps, SessionRotateError } from '../src/lib/session-rotate'

const ACCOUNT = '0x1111111111111111111111111111111111111111'

const KEY_HASH = `0x${'ab'.repeat(32)}`

function validRotationMarker() {
    return {
        oldSessionName: 'default',
        newSessionName: 'default-next',
        status: 'pending',
        chain: 'base',
        chainId: 8453,
        newKeyHash: KEY_HASH,
        narrow: true,
        fullAccess: false,
    }
}

function validPendingQuote() {
    return {
        version: 1,
        account: ACCOUNT,
        keyHash: KEY_HASH,
        chainId: 8453,
        env: 'dev',
        rpcUrl: 'http://127.0.0.1:8545',
        relayerUrl: 'http://127.0.0.1:8787',
        slots: [],
    }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'persisted-file-parity-'))

    try {
        await run(dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

test('readSessionKeystoreFile keeps extra fields and rejects the same invalid files as main', async () => {
    await withTempDir(async (dir) => {
        const session = await createSessionKeystore({
            password: 'pw',
            sessionPrivateKey: generatePrivateKey(),
            network: {
                env: 'dev',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'http://127.0.0.1:8545',
                chainId: 31337,
            },
            delegated: ACCOUNT,
            name: 'default',
        })

        const path = join(dir, 'sessions', 'default.json')

        const withExtra = Object.assign({}, session, { extra: 'kept' })
        await writeSessionKeystoreFile(path, withExtra)

        const loaded = await readSessionKeystoreFile(path)
        expect(JSON.parse(JSON.stringify(loaded)).extra).toBe('kept')

        const rewritten = join(dir, 'sessions', 'rewritten.json')
        await writeSessionKeystoreFile(rewritten, loaded, { overwrite: true })
        const raw = JSON.parse(await readFile(rewritten, 'utf8'))
        expect(raw.extra).toBe('kept')

        const missingName = join(dir, 'missing-name.json')
        await writeFile(missingName, `${JSON.stringify({ ...session, name: undefined })}\n`)
        await expect(readSessionKeystoreFile(missingName)).rejects.toThrow(
            `Unsupported session keystore format at ${missingName}`,
        )

        const wrongType = join(dir, 'wrong-type.json')
        await writeFile(wrongType, `${JSON.stringify({ ...session, name: 12 })}\n`)
        await expect(readSessionKeystoreFile(wrongType)).rejects.toThrow(
            `Unsupported session keystore format at ${wrongType}`,
        )

        const asArray = join(dir, 'array.json')
        await writeFile(asArray, `${JSON.stringify([session])}\n`)
        await expect(readSessionKeystoreFile(asArray)).rejects.toThrow(
            `Unsupported session keystore format at ${asArray}`,
        )

        const asNull = join(dir, 'null.json')
        await writeFile(asNull, 'null\n')
        await expect(readSessionKeystoreFile(asNull)).rejects.toThrow(
            `Unsupported session keystore format at ${asNull}`,
        )

        const protoPath = join(dir, 'proto.json')
        const protoFile = `{"version":2,"createdAt":${JSON.stringify(session.createdAt)},"name":"default","checkpoint":${JSON.stringify(session.checkpoint)},"network":${JSON.stringify(session.network)},"kdf":${JSON.stringify(session.kdf)},"crypto":${JSON.stringify(session.crypto)},"addresses":${JSON.stringify(session.addresses)},"secrets":${JSON.stringify(session.secrets)},"__proto__":{"admin":true}}`
        await writeFile(protoPath, protoFile)
        const protoLoaded = await readSessionKeystoreFile(protoPath)
        expect(Object.hasOwn(protoLoaded, '__proto__')).toBe(true)
        expect(JSON.parse(JSON.stringify(protoLoaded)).admin).toBeUndefined()

        const agent = {
            ...session,
            kind: 'agent',
            secrets: {
                ...session.secrets,
                encryptionDevice: session.secrets.sessionPrivateKey,
            },
        }

        const protoChPath = join(dir, 'proto-ch.json')
        await writeFile(
            protoChPath,
            `${JSON.stringify(agent).replace(/}$/, ',"namedChannels":{"__proto__":5}}')}\n`,
        )
        await expect(readSessionKeystoreFile(protoChPath)).rejects.toThrow(
            `Unsupported session keystore format at ${protoChPath}`,
        )

        const protoChOkPath = join(dir, 'proto-ch-ok.json')
        await writeFile(
            protoChOkPath,
            `${JSON.stringify(agent).replace(/}$/, ',"namedChannels":{"__proto__":{"streamId":"s","secretHash":"h"}}}')}\n`,
        )
        const protoChOk = await readSessionKeystoreFile(protoChOkPath)

        if (protoChOk.kind !== 'agent' || protoChOk.namedChannels === undefined) {
            throw new Error('expected agent namedChannels')
        }

        expect(Object.hasOwn(protoChOk.namedChannels, '__proto__')).toBe(true)

        const corrupt = join(dir, 'corrupt.json')
        await writeFile(corrupt, '{"version":2,')
        await expect(readSessionKeystoreFile(corrupt)).rejects.toBeInstanceOf(SyntaxError)
    })
})

test('readKeystoreBundle and isRootKeystoreV2 accept extras and reject the same invalid roots as main', async () => {
    await withTempDir(async (dir) => {
        const root = await createRootKeystore({
            password: 'pw',
            rootPrivateKey: generatePrivateKey(),
            env: 'dev',
            relayerUrl: 'http://127.0.0.1:8787',
            rpcUrl: 'http://127.0.0.1:8545',
            chainId: 31337,
        })

        const session = await createSessionKeystore({
            password: 'pw',
            sessionPrivateKey: generatePrivateKey(),
            network: root.network,
            delegated: root.addresses.root,
            name: 'default',
        })


        const rootPath = join(dir, 'default.keystore.json')
        await writeRootKeystoreFile(rootPath, Object.assign({}, root, { extra: true }))
        await writeSessionKeystoreFile(join(dir, 'sessions', 'default.json'), session)

        expect(isRootKeystoreV2(Object.assign({}, root, { extra: true }))).toBe(true)
        expect(isRootKeystoreV2({ version: 2 })).toBe(false)
        expect(isRootKeystoreV2({ ...root, createdAt: 1 })).toBe(false)
        expect(isRootKeystoreV2([root])).toBe(false)
        expect(isRootKeystoreV2(null)).toBe(false)

        const bundle = await readKeystoreBundle(rootPath)
        expect(JSON.parse(JSON.stringify(bundle.root)).extra).toBe(true)

        const missing = join(dir, 'missing-fields.json')
        await writeFile(missing, JSON.stringify({ version: 2, sessionRef: { active: 'default' } }))
        await expect(readKeystoreBundle(missing)).rejects.toThrow('expected version 2 split keystore')

        const corrupt = join(dir, 'corrupt-root.json')
        await writeFile(corrupt, '{"version":2,')
        await expect(readKeystoreBundle(corrupt)).rejects.toThrow(
            `Failed to parse keystore JSON at ${corrupt}`,
        )
    })
})

test('readAgentChannelRegistry keeps extras, accepts string arrays, and maps ENOENT to empty', async () => {
    await withTempDir(async (dir) => {
        const keystorePath = join(dir, 'default.keystore.json')
        await expect(readAgentChannelRegistry(keystorePath)).resolves.toEqual({
            version: 1,
            channels: {},
        })

        const path = join(dir, 'agent-channels.json')
        await writeFile(path, `${JSON.stringify({ version: 1, channels: { a: 'b' }, extra: 3 })}\n`)
        const loaded = await readAgentChannelRegistry(keystorePath)
        expect(loaded.channels).toEqual({ a: 'b' })
        expect(JSON.parse(JSON.stringify(loaded)).extra).toBe(3)

        await writeFile(path, `${JSON.stringify({ version: 1, channels: ['only'] })}\n`)
        const fromArray = await readAgentChannelRegistry(keystorePath)
        expect(Object.values(fromArray.channels)).toEqual(['only'])

        await writeFile(path, `${JSON.stringify({ version: 2, channels: {} })}\n`)
        await expect(readAgentChannelRegistry(keystorePath)).rejects.toThrow(
            `Unsupported agent channel registry format at ${path}`,
        )

        await writeFile(path, `${JSON.stringify({ version: 1, channels: { a: 1 } })}\n`)
        await expect(readAgentChannelRegistry(keystorePath)).rejects.toThrow(
            `Invalid agent channel registry entry at ${path}`,
        )

        await writeFile(path, '{"version":1,"channels":{"__proto__":5}}\n')
        await expect(readAgentChannelRegistry(keystorePath)).rejects.toThrow(
            `Invalid agent channel registry entry at ${path}`,
        )

        await writeFile(path, 'null\n')
        await expect(readAgentChannelRegistry(keystorePath)).rejects.toThrow(
            `Unsupported agent channel registry format at ${path}`,
        )

        await writeFile(path, '{"version":1,')
        await expect(readAgentChannelRegistry(keystorePath)).rejects.toBeInstanceOf(SyntaxError)
    })
})

test('hasLegacyRecipientAlias matches main on valid, malformed, and extra-field files', async () => {
    const contactsPath = join(homedir(), '.config', 'agentic-payments', 'tw', 'contacts.json')
    let previous: string | null = null

    try {
        previous = await readFile(contactsPath, 'utf8').catch(() => null)
        await mkdir(join(homedir(), '.config', 'agentic-payments', 'tw'), { recursive: true })

        await writeFile(
            contactsPath,
            `${JSON.stringify({
                version: 1,
                contacts: { Vitalik: { address: ACCOUNT }, extra: 1 },
                leftover: true,
            })}\n`,
        )
        await expect(hasLegacyRecipientAlias('vitalik')).resolves.toBe(true)
        await expect(hasLegacyRecipientAlias('missing')).resolves.toBe(false)

        await writeFile(contactsPath, `${JSON.stringify({ version: 1, contacts: null })}\n`)
        await expect(hasLegacyRecipientAlias('vitalik')).resolves.toBe(false)

        await writeFile(contactsPath, `${JSON.stringify({ version: 2, contacts: { Vitalik: {} } })}\n`)
        await expect(hasLegacyRecipientAlias('vitalik')).resolves.toBe(false)

        await writeFile(contactsPath, 'null\n')
        await expect(hasLegacyRecipientAlias('vitalik')).resolves.toBe(false)

        await writeFile(contactsPath, '{"version":1,')
        await expect(hasLegacyRecipientAlias('vitalik')).resolves.toBe(false)

        await writeFile(contactsPath, `${JSON.stringify({ version: 1, contacts: ['Vitalik'] })}\n`)
        await expect(hasLegacyRecipientAlias('0')).resolves.toBe(true)

        await writeFile(contactsPath, '{"version":1,"contacts":{"__proto__":{},"alice":1}}\n')
        await expect(hasLegacyRecipientAlias('__proto__')).resolves.toBe(true)
        await expect(hasLegacyRecipientAlias('alice')).resolves.toBe(true)
    } finally {
        if (previous === null) {
            await rm(contactsPath, { force: true })
        } else {
            await writeFile(contactsPath, previous, 'utf8')
        }
    }
})

test('readPendingQuoteLimit keeps extras and matches main error messages', async () => {
    await withTempDir(async (dir) => {
        const keystorePath = join(dir, 'default.keystore.json')
        const path = `${keystorePath}.pending-quote-limit.json`

        expect(await readPendingQuoteLimit(keystorePath)).toBeUndefined()

        await writeFile(path, `${JSON.stringify({ ...validPendingQuote(), extra: 'kept' })}\n`)
        const loaded = await readPendingQuoteLimit(keystorePath)
        expect(loaded?.account).toBe(ACCOUNT)
        expect(loaded === undefined ? undefined : JSON.parse(JSON.stringify(loaded)).extra).toBe('kept')

        await writeFile(path, `${JSON.stringify({ version: 2, account: ACCOUNT, slots: [] })}\n`)
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toThrow(
            `Unsupported pending quote limit at ${path}.`,
        )

        await writeFile(path, `${JSON.stringify({ version: 1, account: 'not-an-address', slots: [] })}\n`)
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toThrow(
            `Pending quote limit at ${path} is incomplete.`,
        )

        await writeFile(path, `${JSON.stringify({ version: 1, account: ACCOUNT, slots: {} })}\n`)
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toThrow(
            `Pending quote limit at ${path} is incomplete.`,
        )

        await writeFile(
            path,
            `${JSON.stringify({ ...validPendingQuote(), callGrants: { target: ACCOUNT } })}\n`,
        )
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toThrow(
            `Pending quote limit at ${path} has invalid call grants.`,
        )

        await writeFile(path, 'null\n')
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toBeInstanceOf(TypeError)

        await writeFile(
            path,
            `${JSON.stringify({ ...validPendingQuote(), callGrants: [null] })}\n`,
        )
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toBeInstanceOf(TypeError)

        const expiry = {
            previous: '1',
            installed: '2',
            keyType: 0,
            isSuperAdmin: false,
            publicKey: KEY_HASH,
        }

        await writeFile(
            path,
            `${JSON.stringify({ ...validPendingQuote(), keyExpiry: { ...expiry, publicKey: 'zz', permissions: {} } })}\n`,
        )
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toThrow(
            `Pending quote limit at ${path} has an invalid key expiry.`,
        )

        await writeFile(
            path,
            `${JSON.stringify({ ...validPendingQuote(), keyExpiry: { ...expiry, publicKey: 'zz', limits: {} } })}\n`,
        )
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toThrow(
            `Pending quote limit at ${path} has an invalid key expiry.`,
        )

        await writeFile(
            path,
            `${JSON.stringify({
                ...validPendingQuote(),
                keyExpiry: {
                    ...expiry,
                    permissions: [{ target: 'x', selector: '0xa9059cbb' }],
                    limits: {},
                },
            })}\n`,
        )
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toThrow(
            `Pending quote limit at ${path} has an invalid key permission.`,
        )

        await writeFile(
            path,
            `${JSON.stringify({ ...validPendingQuote(), keyExpiry: { ...expiry, permissions: [null] } })}\n`,
        )
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toBeInstanceOf(TypeError)

        await writeFile(
            path,
            `${JSON.stringify({ ...validPendingQuote(), keyExpiry: { ...expiry, limits: [null] } })}\n`,
        )
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toBeInstanceOf(TypeError)

        await writeFile(path, '{"version":1,')
        await expect(readPendingQuoteLimit(keystorePath)).rejects.toBeInstanceOf(SyntaxError)

        await writeFile(
            path,
            `${JSON.stringify({
                ...validPendingQuote(),
                keyExpiry: {
                    previous: '1',
                    installed: '2',
                    keyType: 0,
                    isSuperAdmin: false,
                    publicKey: KEY_HASH,
                    extra: true,
                },
            })}\n`,
        )
        const withExpiry = await readPendingQuoteLimit(keystorePath)
        expect(
            withExpiry?.keyExpiry === undefined
                ? undefined
                : JSON.parse(JSON.stringify(withExpiry.keyExpiry)).extra,
        ).toBe(true)
    })
})

test('readRotationIntent matches main errors for invalid marker files', async () => {
    await withTempDir(async (dir) => {
        const rootPath = join(dir, 'default.keystore.json')
        const sessions = join(dir, 'sessions')
        await mkdir(sessions)
        const readRotationIntent = getDefaultDeps().readRotationIntent

        expect(await readRotationIntent(rootPath, 'sessions')).toBeNull()

        const markerPath = join(sessions, '.rotation.json')
        await writeFile(markerPath, `${JSON.stringify({ ...validRotationMarker(), extra: 9 })}\n`)
        const loaded = await readRotationIntent(rootPath, 'sessions')
        expect(loaded?.oldSessionName).toBe('default')
        expect(loaded?.status).toBe('pending')
        expect(loaded === null ? undefined : JSON.parse(JSON.stringify(loaded)).extra).toBeUndefined()

        await writeFile(markerPath, `${JSON.stringify({ ...validRotationMarker(), oldSessionName: 1 })}\n`)
        await expect(readRotationIntent(rootPath, 'sessions')).rejects.toThrow(
            'Invalid rotation intent payload.',
        )

        await writeFile(markerPath, `${JSON.stringify({ ...validRotationMarker(), chain: 'ethereum' })}\n`)
        await expect(readRotationIntent(rootPath, 'sessions')).rejects.toBeInstanceOf(SessionRotateError)
        await expect(readRotationIntent(rootPath, 'sessions')).rejects.toMatchObject({
            code: 'ROTATION_MARKER_MISMATCH',
            message: 'Rotation marker is missing the chain it was started on.',
        })

        await writeFile(markerPath, `${JSON.stringify({ ...validRotationMarker(), chainId: 8453.5 })}\n`)
        await expect(readRotationIntent(rootPath, 'sessions')).rejects.toMatchObject({
            code: 'ROTATION_MARKER_MISMATCH',
            message: 'Rotation marker is missing its chain id.',
        })

        await writeFile(markerPath, `${JSON.stringify([validRotationMarker()])}\n`)
        await expect(readRotationIntent(rootPath, 'sessions')).rejects.toThrow(
            'Invalid rotation intent payload.',
        )

        await writeFile(markerPath, 'null\n')
        await expect(readRotationIntent(rootPath, 'sessions')).rejects.toThrow(
            'Invalid rotation intent payload.',
        )

        await writeFile(markerPath, '{"oldSessionName":')
        await expect(readRotationIntent(rootPath, 'sessions')).rejects.toBeInstanceOf(SyntaxError)

        await writeFile(markerPath, `${JSON.stringify({ ...validRotationMarker(), narrow: 'yes' })}\n`)
        await expect(readRotationIntent(rootPath, 'sessions')).rejects.toMatchObject({
            code: 'ROTATION_MARKER_MISMATCH',
            message: 'Rotation marker is missing its permission flags.',
        })

        await writeFile(
            markerPath,
            `${JSON.stringify({ ...validRotationMarker(), account: '0xzz', oldKeyHash: 'x' })}\n`,
        )
        await expect(readRotationIntent(rootPath, 'sessions')).rejects.toMatchObject({
            code: 'ROTATION_MARKER_MISMATCH',
            message: 'Rotation marker account is not a valid address.',
        })

        await writeFile(
            markerPath,
            `${JSON.stringify({ ...validRotationMarker(), account: '0xzz', permissions: 5 })}\n`,
        )
        await expect(readRotationIntent(rootPath, 'sessions')).rejects.toMatchObject({
            code: 'ROTATION_MARKER_MISMATCH',
            message: 'Rotation marker account is not a valid address.',
        })

        await writeFile(
            markerPath,
            `${JSON.stringify({
                ...validRotationMarker(),
                mac: 'a'.repeat(64),
                macKdf: {
                    memoryCost: 1,
                    timeCost: 1,
                    parallelism: 1,
                    hashLength: 32,
                    salt: 'c2FsdHNhbHRzYWx0',
                    evil: 1,
                    type: 0,
                },
            })}\n`,
        )
        const withMacKdf = await readRotationIntent(rootPath, 'sessions')
        expect(withMacKdf?.macKdf).toEqual({
            memoryCost: 1,
            timeCost: 1,
            parallelism: 1,
            hashLength: 32,
            salt: 'c2FsdHNhbHRzYWx0',
        })
        expect(JSON.parse(JSON.stringify(withMacKdf?.macKdf)).evil).toBeUndefined()
    })
})
