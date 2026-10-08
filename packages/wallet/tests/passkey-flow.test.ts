import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams, type ChildProcess } from 'node:child_process'
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    encodeAbiParameters,
    keccak256,
    parseAbiParameters,
    stringToHex,
    type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
    computeKeyHash,
    encodeP256PublicKey,
    encodeSecp256k1Key,
    keyTypeToEnum,
} from '@nubl/relayer-client'

const PORT = 18545

const RPC_URL = `http://127.0.0.1:${PORT}`

const walletDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function resolveAnvilBin(): string {
    const fromEnv = process.env.ANVIL?.trim()

    if (fromEnv) return fromEnv
    const found = Bun.which('anvil')

    if (!found) throw new Error('anvil not found on PATH; set ANVIL to the anvil binary')

    return found
}

let anvil: ChildProcess | undefined

function hexToBytes(hex: Hex): Buffer {
    return Buffer.from(hex.slice(2), 'hex')
}

function bytesToHex(bytes: Buffer): Hex {
    return `0x${bytes.toString('hex')}`
}

function pad32(bytes: Buffer): Buffer {
    if (bytes.length > 32) throw new Error(`coordinate is ${bytes.length} bytes`)

    return Buffer.concat([Buffer.alloc(32 - bytes.length), bytes])
}

function authenticatorData(flags: number): Buffer {
    const data = Buffer.alloc(37)
    data.write('rpIdHash-example', 0, 'ascii')
    data[32] = flags
    data.writeUInt32BE(1, 33)

    return data
}

function clientDataJSON(digest: Hex): Buffer {
    const challenge = hexToBytes(digest).toString('base64url')

    if (challenge.length !== 43) {
        throw new Error(`expected 43-char base64url challenge, got ${challenge.length}`)
    }

    return Buffer.from(
        `{"type":"webauthn.get","challenge":"${challenge}","origin":"https://example.com"}`,
    )
}

function parseDerSignature(der: Buffer): { r: bigint; s: bigint } {
    let i = 0

    if (der[i++] !== 0x30) throw new Error('bad DER signature')
    i += 1

    if (der[i++] !== 0x02) throw new Error('bad DER r')
    const rLength = der[i++] ?? 0
    const r = BigInt(`0x${der.subarray(i, i + rLength).toString('hex')}`)
    i += rLength

    if (der[i++] !== 0x02) throw new Error('bad DER s')
    const sLength = der[i++] ?? 0
    const s = BigInt(`0x${der.subarray(i, i + sLength).toString('hex')}`)

    return { r, s }
}

function signWebAuthn(
    privateKey: KeyObject,
    authData: Buffer,
    clientData: Buffer,
): { r: bigint; s: bigint } {
    const clientHash = createHash('sha256').update(clientData).digest()
    const preimage = Buffer.concat([authData, clientHash])
    const signer = createSign('SHA256')
    signer.update(preimage)
    signer.end()

    return parseDerSignature(signer.sign(privateKey))
}

function generateP256(): { privateKey: KeyObject; publicKey: Hex } {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const jwk = publicKey.export({ format: 'jwk' })

    if (!jwk.x || !jwk.y) throw new Error('P-256 JWK is missing x/y')
    const x = bytesToHex(pad32(Buffer.from(jwk.x, 'base64url')))
    const y = bytesToHex(pad32(Buffer.from(jwk.y, 'base64url')))

    return { privateKey, publicKey: encodeP256PublicKey(x, y) }
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })

    const body = (await response.json()) as { result?: unknown; error?: { message?: string } }

    if (!response.ok || body.error) {
        throw new Error(body.error?.message ?? `${method} failed`)
    }

    return body.result
}

async function waitForRpc(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            await rpc('eth_chainId', [])

            return
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }

    throw new Error('anvil did not start')
}

function runTw(args: string[], timeoutMs = 90_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
        // account passkey now requires the AUTHORIZE PASSKEY phrase on a TTY.
        // The assertions below are unchanged; this only supplies that phrase.
        const child = spawn(
            'python3',
            [
                resolve(walletDir, '../../scripts/tw-tty-confirm.py'),
                'AUTHORIZE PASSKEY',
                'bun',
                'src/cli.ts',
                ...args,
            ],
            {
                cwd: walletDir,
                env: {
                    ...process.env,
                    PATH: `/tmp/node22/bin:${process.env.PATH ?? ''}`,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        )

        let stdout = ''
        let stderr = ''

        const timer = setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error(`wallet CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        }, timeoutMs)

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            stdout += chunk
        })
        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.on('close', (code) => {
            clearTimeout(timer)
            resolvePromise({ code: code ?? 1, stdout, stderr })
        })
    })
}

function parseCliJson(stdout: string): {
    type: string
    valid: boolean
    keyHash: Hex
    account: string
    implementation: string
} {
    const start = stdout.indexOf('{')
    const end = stdout.lastIndexOf('}')

    if (start < 0 || end < start) {
        throw new Error(`CLI did not print JSON:\n${stdout}`)
    }

    return JSON.parse(stdout.slice(start, end + 1))
}

function frame(message: unknown): string {
    return `${JSON.stringify(message)}\n`
}

beforeAll(async () => {
    const bin = resolveAnvilBin()
    let startupError: Error | undefined
    anvil = spawn(
        bin,
        ['--hardfork', 'osaka', '--host', '127.0.0.1', '--port', String(PORT), '--silent'],
        { stdio: 'ignore' },
    )
    anvil.once('error', (error) => {
        startupError = error
    })

    try {
        await waitForRpc()
    } catch (error) {
        const cause = startupError ?? error
        const detail = cause instanceof Error ? cause.message : String(cause)
        throw new Error(`failed to start anvil (${bin}): ${detail}`)
    }
}, 20_000)

afterAll(() => {
    if (anvil && anvil.exitCode === null) anvil.kill('SIGTERM')
})

test('p256 key hash uses Account key type 2 and x||y', () => {
    const { publicKey } = generateP256()
    expect(publicKey.slice(2)).toHaveLength(128)
    expect(keyTypeToEnum('p256')).toBe(2)
    expect(keyTypeToEnum('secp256k1')).toBe(0)
    expect(keyTypeToEnum('external')).toBe(1)

    const expected = keccak256(
        encodeAbiParameters(parseAbiParameters('uint8, bytes32'), [2, keccak256(publicKey)]),
    )

    expect(computeKeyHash('p256', publicKey)).toBe(expected)
    expect(computeKeyHash('external', publicKey)).not.toBe(expected)
    expect(
        computeKeyHash(
            'secp256k1',
            encodeSecp256k1Key('0x0000000000000000000000000000000000000001'),
        ),
    ).not.toBe(expected)
})

test('account passkey stays on the MCP tool list with send, swap, bridge, and permissions', async () => {
    const child = spawn('bun', ['src/cli.ts', '--mcp'], {
        cwd: walletDir,
        env: {
            ...process.env,
            PATH: `/tmp/node22/bin:${process.env.PATH ?? ''}`,
        },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
        stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
        stderr += chunk
    })

    const requiredTools = [
        'account_passkey',
        'send',
        'swap',
        'bridge',
        'permissions_list',
        'permissions_grant',
        'permissions_revoke',
        'permissions_show',
    ]

    const listed = new Promise<string>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
            if (child.pid) {
                try {
                    process.kill(-child.pid, 'SIGTERM')
                } catch {
                    child.kill('SIGTERM')
                }
            }

            reject(new Error(`MCP tools/list timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        }, 20_000)

        child.stdout.on('data', () => {
            if (!requiredTools.every((name) => stdout.includes(`"${name}"`))) return
            clearTimeout(timer)
            resolvePromise(stdout)
        })
    })

    child.stdin.write(
        frame({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'passkey-test', version: '0.0.0' },
            },
        }),
    )
    child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))

    try {
        const body = await listed

        for (const name of requiredTools) {
            expect(body).toContain(`"${name}"`)
        }
    } finally {
        if (child.pid) {
            try {
                process.kill(-child.pid, 'SIGTERM')
            } catch {
                child.kill('SIGTERM')
            }
        }
    }
}, 30_000)

async function verifyThroughCli(input: {
    digest: Hex
    authData: Buffer
    clientData: Buffer
    r: bigint
    s: bigint
    publicKey: Hex
}): Promise<{ code: number; stdout: string; stderr: string; json?: ReturnType<typeof parseCliJson> }> {
    const ownerKey = generatePrivateKey()
    await rpc('anvil_setBalance', [privateKeyToAccount(ownerKey).address, '0x3635C9ADC5DEA00000'])

    const result = await runTw([
        '--json',
        'account',
        'passkey',
        '--rpc-url',
        RPC_URL,
        '--private-key',
        ownerKey,
        '--public-key',
        input.publicKey,
        '--digest',
        input.digest,
        '--authenticator-data',
        bytesToHex(input.authData),
        '--client-data-json',
        bytesToHex(input.clientData),
        '--r',
        input.r.toString(),
        '--s',
        input.s.toString(),
    ])

    if (result.code === 0) {
        return { ...result, json: parseCliJson(result.stdout) }
    }

    return result
}

test('wallet CLI authorizes a real P-256 passkey and the Account accepts it on 0x100', async () => {
    const { privateKey, publicKey } = generateP256()
    const digest = keccak256(stringToHex('passkey-ts-valid'))
    const authData = authenticatorData(0x01)
    const clientData = clientDataJSON(digest)
    const { r, s } = signWebAuthn(privateKey, authData, clientData)
    expect(r).toBeGreaterThan(0n)
    expect(s).toBeGreaterThan(0n)

    const result = await verifyThroughCli({ digest, authData, clientData, r, s, publicKey })
    expect(result.stderr + result.stdout).not.toContain('PASSKEY_FAILED')

    if (!result.json) {
        throw new Error(`passkey CLI failed (${result.code})\n${result.stdout}\n${result.stderr}`)
    }

    expect(result.json.type).toBe('account_passkey')
    expect(result.json.valid).toBe(true)
    expect(result.json.keyHash).toBe(computeKeyHash('p256', publicKey))
}, 90_000)

test('wallet CLI rejects a passkey whose challenge is not the digest', async () => {
    const { privateKey, publicKey } = generateP256()
    const signedDigest = keccak256(stringToHex('passkey-ts-signed'))
    const otherDigest = keccak256(stringToHex('passkey-ts-other'))
    const authData = authenticatorData(0x01)
    const clientData = clientDataJSON(signedDigest)
    const { r, s } = signWebAuthn(privateKey, authData, clientData)

    const result = await verifyThroughCli({
        digest: otherDigest,
        authData,
        clientData,
        r,
        s,
        publicKey,
    })

    if (!result.json) {
        throw new Error(`passkey CLI failed (${result.code})\n${result.stdout}\n${result.stderr}`)
    }

    expect(result.json.valid).toBe(false)
    expect(result.json.keyHash).toBe(computeKeyHash('p256', publicKey))
}, 90_000)
