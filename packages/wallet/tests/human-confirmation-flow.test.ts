import { beforeAll, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { encodeFunctionResult, toFunctionSelector, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { executeSessionCreate as executeSessionCreateImpl } from '../src/lib/session-create'
import { executeSessionCreate } from './helpers/stub-execute'
import { accountAbi } from '@nubl/contracts/abis'
import { ANY_FUNCTION_SELECTOR, ANY_TARGET, INTENT_TYPES } from '@nubl/relayer-client'
import { computeSessionKeyHash } from '../src/lib/session-common'
import {
    parseDaemonResponse,
    type DaemonResponse,
    type DaemonTypedData,
} from '../src/lib/session-daemon-protocol'
import {
    createRootKeystore,
    createSessionKeystore,
    writeRootKeystoreFile,
    writeSessionKeystoreFile,
    resolveSessionKeystorePath,
    type AnySessionKeystore,
    type KeystoreBundle,
    type LoginSessionKeystoreV2,
    type RelayerSessionKeystoreV2,
} from '../src/lib/keystore'
import { hex, parseHex, repeatedHex } from './helpers/hex'
import { parseJson } from './helpers/parse-json'

type SessionCreateDepsArg = NonNullable<Parameters<typeof executeSessionCreateImpl>[1]>

const walletDir = resolve(import.meta.dir, '..')

const rootPrivateKey = repeatedHex('11', 32)

const sessionPrivateKey = repeatedHex('22', 32)

const password = 'proof-password'

const recipient = '0x1111111111111111111111111111111111111111'

type McpToolArgument =
    | string
    | number
    | boolean
    | null
    | McpToolArgument[]
    | { [key: string]: McpToolArgument }

function frame(message: {
    jsonrpc: string
    id?: number
    method: string
    params?: {
        protocolVersion?: string
        capabilities?: { [key: string]: never }
        clientInfo?: { name: string; version: string }
        name?: string
        arguments?: { [key: string]: McpToolArgument }
    }
}): string {
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
    args: { [key: string]: McpToolArgument },
    env: Record<string, string | undefined> = {},
): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        const child: ChildProcessWithoutNullStreams = spawn('bun', ['src/cli.ts', '--mcp'], {
            cwd: walletDir,
            env: { ...process.env, ...env },
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        })

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

    await writeRootKeystoreFile(keystorePath, {
        ...root,
        checkpoint: 'delegated',
        addresses: { ...root.addresses, delegated: root.addresses.root },
    })
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

const anyTarget = '0x3232323232323232323232323232323232323232'

const anySelector = '0x32323232'

const maxSpendRaw = (2n ** 256n - 1n).toString()

test('MCP session_export with TW_PASSWORD does not write a decryptable session key', async () => {
    const outputPath = join(home, 'stolen.session.json')

    const output = await callMcpTool(
        'session_export',
        {
            sessionName: 'default',
            output: outputPath,
            overwrite: true,
            env: 'dev',
            keystorePath,
        },
        {
            TW_PASSWORD: password,
            TW_EXPORT_PASSWORD: 'attacker-chosen-export-password',
            HOME: home,
        },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('EXPORT PRIVATE KEYS')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain(sessionPrivateKey)
    expect(existsSync(outputPath)).toBe(false)
})

test('MCP session_create wildcard permissions cannot proceed without the full-access phrase', async () => {
    const output = await callMcpTool(
        'session_create',
        {
            sessionName: 'wildcard',
            env: 'dev',
            fullAccess: false,
            target: anyTarget,
            selector: anySelector,
            spendLimitRaw: maxSpendRaw,
            keystorePath,
        },
        { TW_PASSWORD: password, HOME: home },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('CREATE FULL ACCESS SESSION')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('getNonce')
})

test('non-TTY session_create wildcard permissions cannot proceed without the full-access phrase', async () => {
    const result = await runCli(
        [
            'session',
            'create',
            'wildcard-cli',
            '--env',
            'dev',
            '--target',
            anyTarget,
            '--selector',
            anySelector,
            '--spend-limit-raw',
            maxSpendRaw,
            '--keystore-path',
            keystorePath,
            '--json',
        ],
        { TW_PASSWORD: password, HOME: home },
    )

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(result.output).toContain('CREATE FULL ACCESS SESSION')
    expect(result.output).not.toContain('getNonce')
    expect(result.output).not.toContain(rootPrivateKey)
})

test('MCP session_rotate wildcard permissions cannot proceed without the full-access phrase', async () => {
    const output = await callMcpTool(
        'session_rotate',
        {
            env: 'dev',
            fullAccess: false,
            target: anyTarget,
            selector: anySelector,
            spendLimitRaw: maxSpendRaw,
            keystorePath,
        },
        { TW_PASSWORD: password, HOME: home },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('ROTATE FULL ACCESS SESSION')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('getNonce')
})

test('non-TTY session_rotate wildcard permissions cannot proceed without the full-access phrase', async () => {
    const result = await runCli(
        [
            'session',
            'rotate',
            '--env',
            'dev',
            '--target',
            anyTarget,
            '--selector',
            anySelector,
            '--spend-limit-raw',
            maxSpendRaw,
            '--keystore-path',
            keystorePath,
            '--json',
        ],
        { TW_PASSWORD: password, HOME: home },
    )

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(result.output).toContain('ROTATE FULL ACCESS SESSION')
    expect(result.output).not.toContain('getNonce')
})

test('MCP permissions_grant wildcard call cannot proceed without the full-access phrase', async () => {
    const output = await callMcpTool(
        'permissions_grant',
        {
            keyRef: 'default',
            type: 'call',
            target: anyTarget,
            selector: anySelector,
            env: 'dev',
            keystorePath,
        },
        { TW_PASSWORD: password, HOME: home },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('CREATE FULL ACCESS SESSION')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('getNonce')
})

test('non-TTY permissions_grant wildcard call cannot proceed without the full-access phrase', async () => {
    const result = await runCli(
        [
            'permissions',
            'grant',
            'default',
            '--type',
            'call',
            '--target',
            anyTarget,
            '--selector',
            anySelector,
            '--env',
            'dev',
            '--keystore-path',
            keystorePath,
            '--json',
        ],
        { TW_PASSWORD: password, HOME: home },
    )

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(result.output).toContain('CREATE FULL ACCESS SESSION')
    expect(result.output).not.toContain('getNonce')
})

test('MCP escrow_create cannot move USDC without human confirmation', async () => {
    const output = await callMcpTool(
        'escrow_create',
        {
            amount: '1',
            seller: '0x1111111111111111111111111111111111111111',
            oracle: '0x2222222222222222222222222222222222222222',
            deadline: '24h',
            env: 'dev',
            keystorePath,
            yes: true,
            confirmationPhrase: 'SEND USDC',
        },
        { TW_PASSWORD: password, HOME: home },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('SEND USDC')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('getNonce')
})

test('MCP escrow_refund cannot move USDC without human confirmation', async () => {
    const output = await callMcpTool(
        'escrow_refund',
        {
            escrowId: `0x${'ab'.repeat(32)}`,
            env: 'dev',
            keystorePath,
        },
        { TW_PASSWORD: password, HOME: home },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('SEND USDC')
    expect(output).toContain('"isError":true')
})

test('MCP account_create cannot install a wildcard session without the phrase', async () => {
    const freshHome = mkdtempSync(join(tmpdir(), 'tw-h3-create-'))
    const freshKeystore = join(freshHome, 'account.json')

    const output = await callMcpTool(
        'account_create',
        {
            env: 'dev',
            keystorePath: freshKeystore,
        },
        { TW_PASSWORD: password, HOME: freshHome },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('CREATE FULL ACCESS SESSION')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('accountProxy')
    expect(output).not.toContain(sessionPrivateKey)
    expect(existsSync(freshKeystore)).toBe(false)
})

test('MCP account_delegate cannot install a wildcard session without the phrase', async () => {
    const output = await callMcpTool(
        'account_delegate',
        {
            chain: 'anvil',
            env: 'dev',
            keystorePath,
        },
        { TW_PASSWORD: 'wrong-password', HOME: home },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('CREATE FULL ACCESS SESSION')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('Unsupported state')
    expect(output).not.toContain(sessionPrivateKey)
    expect(output).not.toContain(rootPrivateKey)
})

test('daemon socket refuses unlock of an unreadable session and does not return the raw key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-h3-daemon-'))
    const socketPath = join(dir, 'session.sock')
    const previous = process.env.TW_AGENT_SOCK
    process.env.TW_AGENT_SOCK = socketPath
    const { runSessionDaemon } = await import('../src/lib/session-daemon')
    const { SessionDaemonClient } = await import('../src/lib/session-daemon-client')
    const daemon = await runSessionDaemon()

    try {
        const unlock = await runCli(
            [
                'daemon',
                'unlock',
                'default',
                '--env',
                'dev',
                '--keystore-path',
                keystorePath,
                '--json',
            ],
            { TW_PASSWORD: password, HOME: home, TW_AGENT_SOCK: socketPath },
        )

        expect(unlock.status).not.toBe(0)
        expect(unlock.output).toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(unlock.output).toContain('UNLOCK FULL ACCESS SESSION')
        expect(unlock.output).not.toContain(sessionPrivateKey)
        const client = new SessionDaemonClient(socketPath)
        const secrets = await client.getSessionSecrets('default')
        const serialized = JSON.stringify(secrets)
        expect(serialized).not.toContain(sessionPrivateKey)
        expect(secrets?.ok).toBe(false)
    } finally {
        await daemon.stop()

        if (previous === undefined) {
            delete process.env.TW_AGENT_SOCK
        } else {
            process.env.TW_AGENT_SOCK = previous
        }
    }
})

test('MCP session_create minute period with no amount requires confirmation before decrypt', async () => {
    const output = await callMcpTool(
        'session_create',
        {
            sessionName: 'per-minute',
            env: 'dev',
            spendPeriod: 'minute',
            keystorePath,
        },
        { TW_PASSWORD: 'wrong-password', HOME: home },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('CREATE FULL ACCESS SESSION')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('Unsupported state')
    expect(output).not.toContain('getNonce')
    expect(output).not.toContain(rootPrivateKey)
})

test('MCP session_create hour period at 10 USDC requires confirmation before decrypt', async () => {
    const output = await callMcpTool(
        'session_create',
        {
            sessionName: 'per-hour',
            env: 'dev',
            spendPeriod: 'hour',
            spendLimit: '10',
            keystorePath,
        },
        { TW_PASSWORD: 'wrong-password', HOME: home },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('CREATE FULL ACCESS SESSION')
    expect(output).toContain('"isError":true')
    expect(output).not.toContain('Unsupported state')
    expect(output).not.toContain('getNonce')
})

test('MCP permissions_grant raw 10000000 per minute on a non-USDC token requires confirmation', async () => {
    const tokens = [
        ['WBTC', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'],
        ['native', '0x0000000000000000000000000000000000000000'],
        ['zero-decimal', '0x0000000000000000000000000000000000000001'],
    ] as const

    for (const [label, token] of tokens) {
        const output = await callMcpTool(
            'permissions_grant',
            {
                keyRef: 'default',
                type: 'spend',
                token,
                spendLimitRaw: '10000000',
                period: 'minute',
                env: 'dev',
                keystorePath,
            },
            { TW_PASSWORD: 'wrong-password', HOME: home },
        )

        const labeled = `${label}\n${output}`
        expect(labeled).toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(labeled).toContain('CREATE FULL ACCESS SESSION')
        expect(labeled).toContain('"isError":true')
        expect(labeled).not.toContain('Unable to connect')
        expect(labeled).not.toContain('Unsupported state')
        expect(labeled).not.toContain('getNonce')
    }
})

const usdc: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const increaseAllowance = '0x39509351'

const orchestratorIntent: DaemonTypedData = {
    domain: {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId: 31337,
        verifyingContract: '0x11050FEC41B66730E91c46Bfd25EBFF3B16F5bcC',
    },
    types: INTENT_TYPES,
    primaryType: 'Intent',
    message: {
        multichain: false,
        eoa: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        calls: [],
        nonce: 1n,
        payer: '0x0000000000000000000000000000000000000000',
        paymentToken: usdc,
        paymentMaxAmount: 1_000_000_000n,
        combinedGas: 0n,
        encodedPreCalls: [],
        encodedFundTransfers: [],
        settler: '0x0000000000000000000000000000000000000000',
        expiry: 0n,
    },
}

async function startDaemon(socketPath: string) {
    const previous = process.env.TW_AGENT_SOCK
    process.env.TW_AGENT_SOCK = socketPath
    const { runSessionDaemon } = await import('../src/lib/session-daemon')
    const { SessionDaemonClient } = await import('../src/lib/session-daemon-client')
    const daemon = await runSessionDaemon()

    return {
        client: new SessionDaemonClient(socketPath),
        stop: async () => {
            await daemon.stop()

            if (previous === undefined) delete process.env.TW_AGENT_SOCK
            else process.env.TW_AGENT_SOCK = previous
        },
    }
}

/** DaemonTypedData cannot express these partial Intent types; an untyped local caller of the socket can. */
const partialIntentSignRequest = JSON.stringify({
    id: 'partial-intent',
    method: 'sign',
    params: {
        sessionName: 'default',
        typedData: {
            domain: {
                name: 'Orchestrator',
                version: '0.5.5',
                chainId: 31337,
                verifyingContract: '0x11050FEC41B66730E91c46Bfd25EBFF3B16F5bcC',
            },
            types: {
                EIP712Domain: [
                    { name: 'name', type: 'string' },
                    { name: 'version', type: 'string' },
                    { name: 'chainId', type: 'uint256' },
                    { name: 'verifyingContract', type: 'address' },
                ],
                Intent: [
                    { name: 'nonce', type: 'uint256' },
                    { name: 'paymentToken', type: 'address' },
                    { name: 'paymentMaxAmount', type: 'uint256' },
                ],
            },
            primaryType: 'Intent',
            message: {
                nonce: '$bigint:1',
                paymentToken: usdc,
                paymentMaxAmount: '$bigint:1000000000',
            },
        },
    },
})

function signRaw(socketPath: string, line: string): Promise<DaemonResponse> {
    return new Promise((resolvePromise, reject) => {
        const socket = connect(socketPath, () => socket.write(`${line}\n`))
        let buffer = ''

        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8')
            const newline = buffer.indexOf('\n')

            if (newline === -1) return
            socket.destroy()
            resolvePromise(parseDaemonResponse(buffer.slice(0, newline)))
        })
        socket.on('error', reject)
    })
}

test('non-TTY daemon unlock of an unreadable session cannot sign an Orchestrator intent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-h3-unlock-'))
    const socketPath = join(dir, 'session.sock')
    const daemon = await startDaemon(socketPath)

    try {
        const unlock = await runCli(
            [
                'daemon',
                'unlock',
                'default',
                '--env',
                'dev',
                '--keystore-path',
                keystorePath,
                '--json',
            ],
            { TW_PASSWORD: password, HOME: home, TW_AGENT_SOCK: socketPath },
        )

        expect(unlock.status).not.toBe(0)
        expect(unlock.output).toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(unlock.output).toContain('UNLOCK FULL ACCESS SESSION')
        expect(unlock.output).not.toContain('Unsupported state')
        expect(unlock.output).not.toContain(sessionPrivateKey)
        const listed = await daemon.client.list()

        if (listed?.ok) {
            expect(listed.result.keys).toHaveLength(0)
        }

        const signed = await daemon.client.sign('default', orchestratorIntent)
        expect(signed?.ok).toBe(false)
        expect(JSON.stringify(signed)).not.toContain(sessionPrivateKey)
    } finally {
        await daemon.stop()
    }
})

test('MCP daemon_unlock of an unreadable session cannot sign an Orchestrator intent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-h3-unlock-mcp-'))
    const socketPath = join(dir, 'session.sock')
    const daemon = await startDaemon(socketPath)

    try {
        const output = await callMcpTool(
            'daemon_unlock',
            {
                sessionName: 'default',
                env: 'dev',
                keystorePath,
            },
            { TW_PASSWORD: password, HOME: home, TW_AGENT_SOCK: socketPath },
        )

        expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(output).toContain('UNLOCK FULL ACCESS SESSION')
        expect(output).toContain('"isError":true')
        expect(output).not.toContain('Unsupported state')
        expect(output).not.toContain(sessionPrivateKey)
        const signed = await daemon.client.sign('default', orchestratorIntent)
        expect(signed?.ok).toBe(false)
    } finally {
        await daemon.stop()
    }
})

test('MCP session_create increaseAllowance on USDC requires confirmation before decrypt', async () => {
    const output = await callMcpTool(
        'session_create',
        {
            sessionName: 'allowance',
            env: 'dev',
            target: usdc,
            selector: increaseAllowance,
            keystorePath,
        },
        { TW_PASSWORD: 'wrong-password', HOME: home },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('CREATE FULL ACCESS SESSION')
    expect(output).not.toContain('Unsupported state')
    expect(output).not.toContain('getNonce')
})

test('MCP permissions_grant increaseAllowance on USDC requires confirmation before decrypt', async () => {
    const output = await callMcpTool(
        'permissions_grant',
        {
            keyRef: 'default',
            type: 'call',
            target: usdc,
            selector: increaseAllowance,
            env: 'dev',
            keystorePath,
        },
        { TW_PASSWORD: 'wrong-password', HOME: home },
    )

    expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(output).toContain('CREATE FULL ACCESS SESSION')
    expect(output).not.toContain('Unsupported state')
    expect(output).not.toContain('getNonce')
})

test('a second 10 USDC daily session_create requires confirmation and the first does not', async () => {
    let existing: ScriptedKey[] = []
    const chainServer = await serveJson(8545, (message) => chainResponder(existing)(message))

    try {
        const first = await callMcpTool(
            'session_create',
            {
                sessionName: 'daily-one',
                env: 'dev',
                keystorePath,
            },
            { TW_PASSWORD: 'wrong-password', HOME: home },
        )

        expect(first).not.toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(first).toContain('Unsupported state')

        existing = [
            {
                hash: repeatedHex('ab', 32),
                calls: [],
                spends: [{ token: usdc, period: 2, limit: 10_000_000n }],
            },
        ]

        const second = await callMcpTool(
            'session_create',
            {
                sessionName: 'daily-two',
                env: 'dev',
                keystorePath,
            },
            { TW_PASSWORD: 'wrong-password', HOME: home },
        )

        expect(second).toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(second).toContain('CREATE FULL ACCESS SESSION')
        expect(second).not.toContain('Unsupported state')
    } finally {
        await chainServer.close()
    }
})

test('MCP session rotate --narrow and session revoke are refused without the phrase', async () => {
    const rotate = await callMcpTool(
        'session_rotate',
        {
            env: 'dev',
            narrow: true,
            keystorePath,
        },
        { TW_PASSWORD: 'wrong-password', HOME: home },
    )

    expect(rotate).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(rotate).toContain('ROTATE FULL ACCESS SESSION')
    expect(rotate).not.toContain('Unsupported state')

    const revoke = await callMcpTool(
        'session_revoke',
        {
            sessionName: 'default',
            force: true,
            env: 'dev',
            keystorePath,
        },
        { TW_PASSWORD: 'wrong-password', HOME: home },
    )

    expect(revoke).toContain('HUMAN_CONFIRMATION_REQUIRED')
    expect(revoke).not.toContain('Unsupported state')
    expect(revoke).not.toContain(rootPrivateKey)
})

const sessionAddress = privateKeyToAccount(sessionPrivateKey).address

const sessionKeyHash = computeSessionKeyHash(sessionAddress)

const getKeysSelector = toFunctionSelector('getKeys()')

const spendInfosSelector = toFunctionSelector('spendAndExecuteInfos(bytes32[])')

const packedInfosSelector = toFunctionSelector('canExecutePackedInfos(bytes32)')

const callCheckerSelector = toFunctionSelector('callCheckerInfos(bytes32)')

const ANY_KEYHASH =
    '0x3232323232323232323232323232323232323232323232323232323232323232'

type ChainScript = {
    keys: ScriptedKey[]
    anyCalls?: { target: Address; selector: Hex }[]
    checkers?: { keyHash: Hex; target: Address; checker: Address }[]
}

type ScriptedKey = {
    hash: Hex
    calls: { target: Address; selector: Hex }[]
    spends: { token: Address; period: number; limit: bigint }[]
}

function packCall(target: string, selector: string): Hex {
    const packed = (BigInt(target) << 96n) | BigInt(selector)

    return parseHex(`0x${packed.toString(16).padStart(64, '0')}`)
}

function encodeChainView(keys: ScriptedKey[]): { getKeys: Hex; spend: Hex } {
    return {
        getKeys: encodeFunctionResult({
            abi: accountAbi,
            functionName: 'getKeys',
            result: [
                keys.map(() => ({
                    expiry: 0,
                    keyType: 0,
                    isSuperAdmin: false,
                    publicKey: hex('0x'),
                })),
                keys.map((key) => key.hash),
            ],
        }),
        spend: encodeFunctionResult({
            abi: accountAbi,
            functionName: 'spendAndExecuteInfos',
            result: [
                keys.map((key) =>
                    key.spends.map((spend) => ({
                        token: spend.token,
                        period: spend.period,
                        limit: spend.limit,
                        spent: 0n,
                        lastUpdated: 0n,
                        currentSpent: 0n,
                        current: 0n,
                    })),
                ),
                keys.map((key) => key.calls.map((call) => packCall(call.target, call.selector))),
            ],
        }),
    }
}

const wildcardOnChain: ScriptedKey = {
    hash: sessionKeyHash,
    calls: [{ target: ANY_TARGET, selector: ANY_FUNCTION_SELECTOR }],
    spends: [
        {
            token: '0x0000000000000000000000000000000000000000',
            period: 6,
            limit: 2n ** 256n - 1n,
        },
    ],
}

const narrowOnChain: ScriptedKey = {
    hash: sessionKeyHash,
    calls: [{ target: usdc, selector: '0xa9059cbb' }],
    spends: [{ token: usdc, period: 2, limit: 10_000_000n }],
}

const narrowRelayerPermissions = [
    { type: 'call', to: usdc, selector: '0xa9059cbb' },
    {
        type: 'spend',
        token: usdc,
        limit: '0x989680',
        spent: '0x0',
        period: 'day',
    },
]

const wildcardRelayerPermissions = [
    { type: 'call', to: ANY_TARGET, selector: ANY_FUNCTION_SELECTOR },
]

function relayerKeys(permissions: unknown[]): Record<string, unknown[]> {
    return {
        '0x7a69': [
            {
                hash: sessionKeyHash,
                expiry: '0x0',
                type: 'secp256k1',
                role: 'normal',
                publicKey: '0x',
                permissions,
            },
        ],
    }
}

type JsonRpcStubId = string | number | null

type JsonRpcStubRequest = { id?: JsonRpcStubId; method?: string; params?: unknown }

type RelayerKeyTable = ReturnType<typeof relayerKeys>

type JsonRpcStubResponse = {
    jsonrpc: '2.0'
    id: JsonRpcStubId
    result?: string | RelayerKeyTable | null
    error?: { code: number; message: string }
}

function jsonRpcReply(
    body: string,
    respond: (message: JsonRpcStubRequest) => JsonRpcStubResponse,
): JsonRpcStubResponse | JsonRpcStubResponse[] {
    const parsed = parseJson<JsonRpcStubRequest | JsonRpcStubRequest[]>(body)

    if (Array.isArray(parsed)) return parsed.map((message) => respond(message))

    return respond(parsed)
}

async function serveJson(
    port: number,
    respond: (message: JsonRpcStubRequest) => JsonRpcStubResponse,
): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
            let payload: unknown

            try {
                payload = jsonRpcReply(Buffer.concat(chunks).toString('utf8'), respond)
            } catch (error) {
                payload = {
                    jsonrpc: '2.0',
                    id: null,
                    error: {
                        code: -32000,
                        message: error instanceof Error ? error.message : String(error),
                    },
                }
            }

            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(payload))
        })
    })

    await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolvePromise())
    })
    const address = server.address()

    if (!address || typeof address === 'string') {
        throw new Error('json-rpc stub failed to bind')
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise((resolvePromise) => {
                server.close(() => resolvePromise())
            }),
    }
}

function chainResponder(keys: ScriptedKey[] | ChainScript | 'error') {
    return (message: JsonRpcStubRequest): JsonRpcStubResponse => {
        const id = message.id ?? null

        if (message.method === 'eth_chainId') {
            return { jsonrpc: '2.0', id, result: '0x7a69' }
        }

        if (message.method !== 'eth_call') {
            return { jsonrpc: '2.0', id, result: '0x0' }
        }

        if (keys === 'error') {
            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32003, message: 'permission lookup failed' },
            }
        }

        const params: [{ data?: string }] | undefined = Array.isArray(message.params)
            ? [message.params[0]]
            : undefined

        const data = (params?.[0]?.data ?? '').toLowerCase()
        const script: ChainScript = Array.isArray(keys) ? { keys } : keys
        const view = encodeChainView(script.keys)

        if (data.startsWith(getKeysSelector)) {
            return { jsonrpc: '2.0', id, result: view.getKeys }
        }

        if (data.startsWith(spendInfosSelector)) {
            return { jsonrpc: '2.0', id, result: view.spend }
        }

        if (data.startsWith(packedInfosSelector)) {
            const hash = `0x${data.slice(10, 74)}`

            const packed =
                hash === ANY_KEYHASH.toLowerCase()
                    ? (script.anyCalls ?? []).map((call) => packCall(call.target, call.selector))
                    : []

            return {
                jsonrpc: '2.0',
                id,
                result: encodeFunctionResult({
                    abi: accountAbi,
                    functionName: 'canExecutePackedInfos',
                    result: packed,
                }),
            }
        }

        if (data.startsWith(callCheckerSelector)) {
            const hash = `0x${data.slice(10, 74)}`

            const rows = (script.checkers ?? []).filter(
                (checker) => checker.keyHash.toLowerCase() === hash,
            )

            return {
                jsonrpc: '2.0',
                id,
                result: encodeFunctionResult({
                    abi: accountAbi,
                    functionName: 'callCheckerInfos',
                    result: rows.map((checker) => ({
                        target: checker.target,
                        checker: checker.checker,
                    })),
                }),
            }
        }

        return {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: `unexpected eth_call ${data.slice(0, 10)}` },
        }
    }
}

function relayerResponder(result: RelayerKeyTable | 'error') {
    return (message: { id?: JsonRpcStubId }): JsonRpcStubResponse => {
        if (result === 'error') {
            return {
                jsonrpc: '2.0',
                id: message.id ?? null,
                error: { code: -32003, message: 'Failed to read key permissions' },
            }
        }

        return { jsonrpc: '2.0', id: message.id ?? null, result }
    }
}

async function expectUnlockRequiresPhrase(
    chain: ScriptedKey[] | ChainScript | 'error' | 'down',
    relayer: RelayerKeyTable | 'error',
) {
    const chainServer = chain === 'down' ? undefined : await serveJson(8545, chainResponder(chain))
    const relayerServer = await serveJson(0, relayerResponder(relayer))
    const env = { TW_PASSWORD: password, HOME: home, RELAYER_URL_DEV: relayerServer.url }
    const dir = mkdtempSync(join(tmpdir(), 'tw-h3-chain-'))
    const socketPath = join(dir, 'session.sock')
    const daemon = await startDaemon(socketPath)

    try {
        const unlock = await runCli(
            [
                'daemon',
                'unlock',
                'default',
                '--env',
                'dev',
                '--keystore-path',
                keystorePath,
                '--json',
            ],
            { ...env, TW_AGENT_SOCK: socketPath },
        )

        expect(unlock.status).not.toBe(0)
        expect(unlock.output).toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(unlock.output).toContain('UNLOCK FULL ACCESS SESSION')
        expect(unlock.output).not.toContain('Unsupported state')
        expect(unlock.output).not.toContain(sessionPrivateKey)
        const signed = await daemon.client.sign('default', orchestratorIntent)
        expect(signed?.ok).toBe(false)
        expect(JSON.stringify(signed)).not.toContain(sessionPrivateKey)

        const output = await callMcpTool(
            'daemon_unlock',
            { sessionName: 'default', env: 'dev', keystorePath },
            { ...env, TW_AGENT_SOCK: socketPath },
        )

        expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(output).toContain('UNLOCK FULL ACCESS SESSION')
        expect(output).toContain('"isError":true')
        expect(output).not.toContain('Unsupported state')
        expect(output).not.toContain(sessionPrivateKey)
        const signedAgain = await daemon.client.sign('default', orchestratorIntent)
        expect(signedAgain?.ok).toBe(false)
    } finally {
        await daemon.stop()
        await chainServer?.close()
        await relayerServer.close()
    }
}

test('getKeys permissions [] for an on-chain wildcard requires the unlock phrase', async () => {
    await expectUnlockRequiresPhrase([wildcardOnChain], relayerKeys([]))
}, 60_000)

test('a getKeys answer that lies with a narrow 10 USDC/day list still requires the phrase', async () => {
    await expectUnlockRequiresPhrase([wildcardOnChain], relayerKeys(narrowRelayerPermissions))
}, 60_000)

test('a getKeys error requires the unlock phrase', async () => {
    await expectUnlockRequiresPhrase([wildcardOnChain], 'error')
}, 60_000)

test('an unreachable chain RPC requires the unlock phrase even when getKeys is narrow', async () => {
    await expectUnlockRequiresPhrase('down', relayerKeys(narrowRelayerPermissions))
}, 60_000)

test('an honest narrow key read from chain unlocks with the password only', async () => {
    const chainServer = await serveJson(8545, chainResponder([narrowOnChain]))
    const relayerServer = await serveJson(0, relayerResponder(relayerKeys(wildcardRelayerPermissions)))
    const env = { TW_PASSWORD: password, HOME: home, RELAYER_URL_DEV: relayerServer.url }
    const dir = mkdtempSync(join(tmpdir(), 'tw-h3-narrow-'))
    const socketPath = join(dir, 'session.sock')

    try {
    const daemon = await startDaemon(socketPath)

    try {
        const unlock = await runCli(
            [
                'daemon',
                'unlock',
                'default',
                '--env',
                'dev',
                '--keystore-path',
                keystorePath,
                '--json',
            ],
            { ...env, TW_AGENT_SOCK: socketPath },
        )

        expect(unlock.output).not.toContain('UNLOCK FULL ACCESS SESSION')
        expect(unlock.output).not.toContain(sessionPrivateKey)
        expect(unlock.status).toBe(0)
        const listed = await daemon.client.list()
        expect(listed?.ok).toBe(true)

        if (listed?.ok) {
            expect(listed.result.keys.map((key) => key.name)).toContain('default')
        }

        const signed = await signRaw(socketPath, partialIntentSignRequest)
        expect(signed.error).toEqual({
            code: 'INVALID_REQUEST',
            message: 'Phrase-less sessions can only sign Orchestrator intents',
        })
        expect(JSON.stringify(signed)).not.toContain(sessionPrivateKey)
    } finally {
        await daemon.stop()
    }

    const mcpDir = mkdtempSync(join(tmpdir(), 'tw-h3-narrow-mcp-'))
    const mcpSocket = join(mcpDir, 'session.sock')
    const mcpDaemon = await startDaemon(mcpSocket)

    try {
        const output = await callMcpTool(
            'daemon_unlock',
            { sessionName: 'default', env: 'dev', keystorePath },
            { ...env, TW_AGENT_SOCK: mcpSocket },
        )

        expect(output).not.toContain('UNLOCK FULL ACCESS SESSION')
        expect(output).not.toContain(sessionPrivateKey)
        expect(output).toContain('"status":"complete"')
        expect(output).not.toContain('"isError":true')
        const mcpSigned = await signRaw(mcpSocket, partialIntentSignRequest)
        expect(mcpSigned.error).toEqual({
            code: 'INVALID_REQUEST',
            message: 'Phrase-less sessions can only sign Orchestrator intents',
        })
    } finally {
        await mcpDaemon.stop()
    }
    } finally {
        await chainServer.close()
        await relayerServer.close()
    }
}, 60_000)

test('ANY_KEYHASH wildcard behind a narrow key requires the unlock phrase', async () => {
    await expectUnlockRequiresPhrase(
        {
            keys: [narrowOnChain],
            anyCalls: [{ target: ANY_TARGET, selector: ANY_FUNCTION_SELECTOR }],
        },
        relayerKeys(narrowRelayerPermissions),
    )
}, 60_000)

test('a call checker behind a narrow key requires the unlock phrase', async () => {
    await expectUnlockRequiresPhrase(
        {
            keys: [narrowOnChain],
            checkers: [
                {
                    keyHash: sessionKeyHash,
                    target: ANY_TARGET,
                    checker: '0x4444444444444444444444444444444444444444',
                },
            ],
        },
        relayerKeys(narrowRelayerPermissions),
    )
}, 60_000)

test('allowlisted escrow calls with no spend limit require the unlock phrase', async () => {
    const previous = {
        ORCHESTRATOR_31337: process.env.ORCHESTRATOR_31337,
        SIMPLE_FUNDER_31337: process.env.SIMPLE_FUNDER_31337,
        SIMULATOR_31337: process.env.SIMULATOR_31337,
        ACCOUNT_31337: process.env.ACCOUNT_31337,
        ACCOUNT_PROXY_31337: process.env.ACCOUNT_PROXY_31337,
        SIMPLE_SETTLER_31337: process.env.SIMPLE_SETTLER_31337,
        ESCROW_31337: process.env.ESCROW_31337,
        MULTI_SIG_SIGNER_31337: process.env.MULTI_SIG_SIGNER_31337,
    }

    const escrow: Address = '0x05f9597eed844410b7c0746A1C584188d0644730'
    process.env.ORCHESTRATOR_31337 = '0x11050FEC41B66730E91c46Bfd25EBFF3B16F5bcC'
    process.env.SIMPLE_FUNDER_31337 = '0x0000000000000000000000000000000000000002'
    process.env.SIMULATOR_31337 = '0x0000000000000000000000000000000000000003'
    process.env.ACCOUNT_31337 = '0x0000000000000000000000000000000000000004'
    process.env.ACCOUNT_PROXY_31337 = '0x0000000000000000000000000000000000000005'
    process.env.SIMPLE_SETTLER_31337 = '0x0000000000000000000000000000000000000006'
    process.env.ESCROW_31337 = escrow
    process.env.MULTI_SIG_SIGNER_31337 = '0x0000000000000000000000000000000000000007'

    try {
        await expectUnlockRequiresPhrase(
            [
                {
                    hash: sessionKeyHash,
                    calls: [{ target: escrow, selector: '0x657061bf' }],
                    spends: [],
                },
            ],
            relayerKeys([{ type: 'call', to: escrow, selector: '0x657061bf' }]),
        )
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}, 60_000)

test('USDC calls with no spend limit require the unlock phrase', async () => {
    await expectUnlockRequiresPhrase(
        [
            {
                hash: sessionKeyHash,
                calls: [{ target: usdc, selector: '0xa9059cbb' }],
                spends: [],
            },
        ],
        relayerKeys([{ type: 'call', to: usdc, selector: '0xa9059cbb' }]),
    )
}, 60_000)

test('two session creates started together authorize at most one 10 USDC/day key without the phrase', async () => {
    let daily = 0n
    let authorizeCount = 0

    const chainServer = await serveJson(8545, (message) =>
        chainResponder(
            daily === 0n
                ? []
                : [
                      {
                          hash: repeatedHex('cd', 32),
                          calls: [],
                          spends: [{ token: usdc, period: 2, limit: daily }],
                      },
                  ],
        )(message),
    )

    const keystorePathForRace = join(mkdtempSync(join(tmpdir(), 'tw-h3-race-')), 'account.json')
    const keyA = generatePrivateKey()
    const keyB = generatePrivateKey()

    const root = await createRootKeystore({
        password: 'pw',
        rootPrivateKey: repeatedHex('11', 32),
        env: 'dev',
        relayerUrl: 'http://127.0.0.1:8787',
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
    })

    const delegatedRoot = {
        ...root,
        checkpoint: 'delegated' as const,
        addresses: { ...root.addresses, delegated: root.addresses.root },
    }

    await writeRootKeystoreFile(keystorePathForRace, delegatedRoot)

    const seededSession = await createSessionKeystore({
        password: 'pw',
        sessionPrivateKey: keyA,
        network: root.network,
        delegated: root.addresses.root,
        name: 'default',
        checkpoint: 'authorized',
    })

    await writeSessionKeystoreFile(
        resolveSessionKeystorePath(keystorePathForRace),
        seededSession,
    )
    const account = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const hashA = computeSessionKeyHash(privateKeyToAccount(keyA).address)
    const hashB = computeSessionKeyHash(privateKeyToAccount(keyB).address)

    const bundle: KeystoreBundle = {
        rootPath: keystorePathForRace,
        sessionPath: resolveSessionKeystorePath(keystorePathForRace),
        root: {
            ...delegatedRoot,
            sessionRef: { active: 'default', dir: 'sessions' },
            addresses: {
                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                delegated: account,
            },
        },
        session: seededSession,
    }

    function makeSession(name: string, key: Hex): RelayerSessionKeystoreV2 {
        return {
            version: 2,
            createdAt: new Date().toISOString(),
            name,
            checkpoint: 'initialized',
            network: {
                env: 'dev',
                relayerUrl: 'http://127.0.0.1:8787',
                rpcUrl: 'http://127.0.0.1:8545',
                chainId: 31337,
            },
            kdf: {
                name: 'argon2id',
                params: {
                    memoryCost: 19456,
                    timeCost: 2,
                    parallelism: 1,
                    hashLength: 32,
                    salt: 'c2FsdA==',
                },
            },
            crypto: { algorithm: 'aes-256-gcm' },
            addresses: { session: privateKeyToAccount(key).address, delegated: account },
            secrets: { sessionPrivateKey: { nonce: 'n', ciphertext: 'c', tag: 't' } },
        }
    }

    const depsFor = (key: Hex): SessionCreateDepsArg => {
        function fakeCreateSessionKeystore(input: {
            name?: string
            kind?: undefined
        }): Promise<RelayerSessionKeystoreV2>
        function fakeCreateSessionKeystore(input: {
            name?: string
            kind: 'login'
        }): Promise<LoginSessionKeystoreV2>
        async function fakeCreateSessionKeystore(input: {
            name?: string
            kind?: 'login'
        }): Promise<AnySessionKeystore> {
            const session = makeSession(input.name ?? '', key)

            return input.kind === 'login' ? { ...session, kind: 'login' } : session
        }

        return {
            readKeystoreBundle: async () => bundle,
            fileExists: async () => false,
            generatePrivateKey: () => key,
            createSessionKeystore: fakeCreateSessionKeystore,
            writeSessionKeystoreFile: async () => {},
            decryptRootKeystore: async () => ({ rootPrivateKey: `0x${'11'.repeat(32)}` as const }),
            readNonce: async () => 1n,
            executeSignedCalls: async () => {
                authorizeCount += 1
                daily = 10_000_000n

                return {
                    id: `bundle-${authorizeCount}`,
                    finalStatus: {
                        success: true,
                        status: 'confirmed',
                        statusCode: 200,
                        receipt: {
                            transactionHash: `0x${'11'.repeat(32)}`,
                            blockNumber: '0x1',
                            gasUsed: '0x0',
                            status: 'success',
                        },
                    },
                    feeCap: {
                        token: '0x0000000000000000000000000000000000000000',
                        symbol: 'none',
                        amountUsdc: '0',
                        expiresIn: '1h',
                    },
                }
            },
            getKeys: async () => ({
                '0x7a69': [hashA, hashB].map((hash) => ({
                    hash,
                    expiry: '0x0',
                    type: 'secp256k1',
                    role: 'normal',
                    publicKey: '0x',
                    permissions: [],
                })),
            }),
            sleep: async () => {},
        }
    }

    try {
        const results = await Promise.allSettled([
            executeSessionCreate(
                { env: 'dev', keystorePath: keystorePathForRace, sessionName: 'race-a', password: 'pw' },
                depsFor(keyA),
            ),
            executeSessionCreate(
                { env: 'dev', keystorePath: keystorePathForRace, sessionName: 'race-b', password: 'pw' },
                depsFor(keyB),
            ),
        ])

        const fulfilled = results.filter((result) => result.status === 'fulfilled')
        const rejected = results.filter((result) => result.status === 'rejected')
        expect(authorizeCount).toBeLessThanOrEqual(1)
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        const firstRejected = rejected[0]

        if (firstRejected?.status !== 'rejected') throw new Error('expected one rejection')

        expect(String(firstRejected.reason)).toContain('HUMAN_CONFIRMATION_REQUIRED')
        expect(String(firstRejected.reason)).toContain('CREATE FULL ACCESS SESSION')
    } finally {
        await chainServer.close()
    }
}, 30_000)
