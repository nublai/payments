import { beforeAll, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hex } from 'viem'
import {
    createRootKeystore,
    createSessionKeystore,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
    resolveSessionKeystorePath,
} from '../src/lib/keystore'

const walletDir = resolve(import.meta.dir, '..')
const rootPrivateKey = `0x${'11'.repeat(32)}` as Hex
const sessionPrivateKey = `0x${'22'.repeat(32)}` as Hex
const password = 'proof-password'
const recipient = '0x1111111111111111111111111111111111111111'

function frame(message: unknown): string {
    return `${JSON.stringify(message)}\n`
}

function killChild(child: ChildProcessWithoutNullStreams): void {
    if (!child.pid) {
        child.kill('SIGTERM')
        return
    }
    try {
        process.kill(-child.pid, 'SIGTERM')
    } catch {
        child.kill('SIGTERM')
    }
}

function runCli(
    args: string[],
    env: Record<string, string | undefined> = {},
): Promise<{ status: number; output: string }> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn('bun', ['src/cli.ts', ...args], {
            cwd: walletDir,
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        let output = ''
        const timer = setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error(`CLI timed out\n${output}`))
        }, 20_000)
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            output += chunk
        })
        child.stderr.on('data', (chunk) => {
            output += chunk
        })
        child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.on('close', (code) => {
            clearTimeout(timer)
            resolvePromise({ status: code ?? 1, output })
        })
    })
}

function callMcpTool(
    name: string,
    args: Record<string, unknown>,
    env: Record<string, string | undefined> = {},
): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn('bun', ['src/cli.ts', '--mcp'], {
            cwd: walletDir,
            env: { ...process.env, ...env },
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
            killChild(child)
            reject(new Error(`MCP ${name} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        }, 20_000)
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            stdout += chunk
            if (!stdout.includes('"id":3')) return
            clearTimeout(timer)
            killChild(child)
            resolvePromise(stdout)
        })
        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
        })
        child.stdin.write(
            frame({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'h3-confirmation', version: '0.0.0' },
                },
            }),
        )
        child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
        child.stdin.write(
            frame({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name, arguments: args },
            }),
        )
    })
}

async function listenOn8545(): Promise<{ hits: string[]; close: () => Promise<void> } | undefined> {
    const hits: string[] = []
    let server: Server
    try {
        server = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
                hits.push(Buffer.concat(chunks).toString('utf8'))
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }))
            })
        })
        await new Promise<void>((resolvePromise, reject) => {
            server.once('error', reject)
            server.listen(8545, '127.0.0.1', () => resolvePromise())
        })
    } catch {
        return undefined
    }
    return {
        hits,
        close: () =>
            new Promise((resolvePromise) => {
                server.close(() => resolvePromise())
            }),
    }
}

const home = mkdtempSync(join(tmpdir(), 'tw-h3-'))
const keystorePath = join(home, 'account.json')

beforeAll(async () => {
    const root = await createRootKeystore({
        password,
        rootPrivateKey,
        env: 'dev',
        relayerUrl: 'http://127.0.0.1:8787',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
    })
    const session = await createSessionKeystore({
        password,
        sessionPrivateKey,
        network: root.network,
        delegated: root.addresses.root,
        name: 'default',
        checkpoint: 'authorized',
    })
    await writeRootKeystoreFile(keystorePath, root)
    await writeSessionKeystoreFile(resolveSessionKeystorePath(keystorePath), session)
})

test('non-TTY account export with TW_PASSWORD does not print private keys', async () => {
    const result = await runCli(
        [
            'account',
            'export',
            '--env',
            'dev',
            '--show-private',
            '--json',
            '--keystore-path',
            keystorePath,
        ],
        { TW_PASSWORD: password, HOME: home },
    )

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('PRIVATE_EXPORT_CONFIRMATION_REQUIRED')
    expect(result.output).toContain('EXPORT PRIVATE KEYS')
    expect(result.output).not.toContain(rootPrivateKey)
    expect(result.output).not.toContain(sessionPrivateKey)
    expect(result.output).not.toContain('rootPrivateKey')
}, 30_000)

test('MCP account_export showPrivate does not print private keys', async () => {
    const output = await callMcpTool(
        'account_export',
        { env: 'dev', showPrivate: true, keystorePath },
        { TW_PASSWORD: password, HOME: home },
    )
    expect(output).toContain('PRIVATE_EXPORT_CONFIRMATION_REQUIRED')
    expect(output).toContain('EXPORT PRIVATE KEYS')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain(rootPrivateKey)
    expect(output).not.toContain(sessionPrivateKey)
    expect(output).not.toContain('rootPrivateKey')
})

test('non-TTY send with TW_PASSWORD cannot proceed without human confirmation', async () => {
    const sink = await listenOn8545()
    try {
        const result = await runCli(
            ['send', '1', recipient, '--env', 'dev', '--keystore-path', keystorePath, '--json'],
            { TW_PASSWORD: password, HOME: home },
        )
        expect(result.status).not.toBe(0)
        expect(result.output).toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(result.output).toContain('SEND USDC')
        expect(result.output).not.toContain('rootPrivateKey')
        if (sink) {
            expect(sink.hits).toEqual([])
        }
    } finally {
        await sink?.close()
    }
}, 30_000)

test('MCP send cannot proceed without human confirmation', async () => {
    const output = await callMcpTool(
        'send',
        {
            amount: '1',
            recipient,
            env: 'dev',
            keystorePath,
        },
        { TW_PASSWORD: password, HOME: home },
    )
    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('SEND USDC')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain(rootPrivateKey)
    expect(output).not.toContain('getNonce')
})

test('MCP swap yes true cannot proceed without human confirmation', async () => {
    const output = await callMcpTool(
        'swap',
        {
            from: 'USDC',
            to: 'ETH',
            amount: '1',
            env: 'dev',
            yes: true,
            keystorePath,
        },
        { TW_PASSWORD: password, HOME: home },
    )
    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('cannot pass yes')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('Re-run with --yes')
})

test('MCP bridge yes true cannot proceed without human confirmation', async () => {
    const output = await callMcpTool(
        'bridge',
        {
            token: 'USDC',
            amount: '1',
            toChain: 'base',
            env: 'dev',
            yes: true,
            keystorePath,
        },
        { TW_PASSWORD: password, HOME: home },
    )
    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('cannot pass yes')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('Re-run with --yes')
})

test('non-TTY swap --yes cannot skip confirmation', async () => {
    const result = await runCli(
        [
            'swap',
            '--from',
            'USDC',
            '--to',
            'ETH',
            '--amount',
            '1',
            '--env',
            'dev',
            '--yes',
            '--keystore-path',
            keystorePath,
        ],
        { TW_PASSWORD: password, HOME: home },
    )
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(result.output).toContain('cannot pass yes')
    expect(result.output).not.toContain('Re-run with --yes')
})

test('MCP session_create fullAccess cannot proceed without human confirmation', async () => {
    const output = await callMcpTool(
        'session_create',
        { sessionName: 'worker-admin', env: 'dev', fullAccess: true, keystorePath },
        { TW_PASSWORD: password, HOME: home },
    )
    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('CREATE FULL ACCESS SESSION')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('ANY_TARGET')
})

test('MCP session_rotate fullAccess cannot proceed without human confirmation', async () => {
    const output = await callMcpTool(
        'session_rotate',
        { env: 'dev', fullAccess: true, keystorePath },
        { TW_PASSWORD: password, HOME: home },
    )
    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('ROTATE FULL ACCESS SESSION')
    expect(output).toContain('"isError":true')
})

test('MCP account_passkey privateKey cannot proceed and does not submit a transaction', async () => {
    const hits: string[] = []
    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
            hits.push(Buffer.concat(chunks).toString('utf8'))
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }))
        })
    })
    await new Promise<void>((resolvePromise) => {
        server.listen(0, '127.0.0.1', () => resolvePromise())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
        throw new Error('mock rpc did not bind')
    }
    try {
        const output = await callMcpTool('account_passkey', {
            rpcUrl: `http://127.0.0.1:${address.port}`,
            privateKey: rootPrivateKey,
            publicKey: `0x${'ab'.repeat(64)}`,
            digest: `0x${'cd'.repeat(32)}`,
            authenticatorData: '0x01',
            clientDataJson: '0x7b7d',
            r: '1',
            s: '1',
        })
        expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(output).toContain('does not accept a raw private key over MCP')
        expect(output).toContain('"isError":true')
        expect(output).not.toContain(rootPrivateKey)
        expect(hits).toEqual([])
    } finally {
        await new Promise<void>((resolvePromise) => {
            server.close(() => resolvePromise())
        })
    }
})

test('MCP escrow_settle oraclePrivateKey cannot proceed without human confirmation', async () => {
    const output = await callMcpTool(
        'escrow_settle',
        {
            escrowId: `0x${'ab'.repeat(32)}`,
            settlementId: `0x${'cd'.repeat(32)}`,
            oracle: '0x2222222222222222222222222222222222222222',
            oraclePrivateKey: rootPrivateKey,
            env: 'dev',
            keystorePath,
        },
        { TW_PASSWORD: password, HOME: home },
    )
    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('does not accept a raw private key over MCP')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain(rootPrivateKey)
})

test('non-TTY escrow settle with TW_ORACLE_PRIVATE_KEY cannot sign without human confirmation', async () => {
    const result = await runCli(
        [
            'escrow',
            'settle',
            `0x${'ab'.repeat(32)}`,
            '--settlement-id',
            `0x${'cd'.repeat(32)}`,
            '--oracle',
            '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            '--env',
            'dev',
            '--keystore-path',
            keystorePath,
            '--json',
        ],
        {
            TW_PASSWORD: password,
            TW_ORACLE_PRIVATE_KEY:
                '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            HOME: home,
        },
    )
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(result.output).toContain('SIGN ESCROW SETTLEMENT')
    expect(result.output).not.toContain(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    )
})
