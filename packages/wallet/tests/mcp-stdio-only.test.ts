import { expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseJson } from './helpers/parse-json'

const walletDir = resolve(import.meta.dir, '..')

const tcpListenState = '0A'

type ListenSocket = {
    family: 'tcp' | 'tcp6'
    port: number
}

type McpToolListMessage = {
    id: number
    result: {
        tools: Array<{ name: string }>
    }
}

function frame(message: {
    jsonrpc: string
    id?: number
    method: string
    params?: {
        protocolVersion?: string
        capabilities?: { tools?: { listChanged: boolean } }
        clientInfo?: { name: string; version: string }
    }
}): string {
    return `${JSON.stringify(message)}\n`
}

function childPids(pid: number): number[] {
    let text = ''

    try {
        text = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
    } catch {
        return []
    }

    const pids: number[] = []

    for (const part of text.trim().split(/\s+/)) {
        if (part === '') continue
        const child = Number.parseInt(part, 10)

        if (!Number.isInteger(child)) continue
        pids.push(child)
    }

    return pids
}

function processTree(pid: number): number[] {
    const seen: number[] = []
    const pending = [pid]

    while (pending.length > 0) {
        const current = pending.pop()

        if (current === undefined) continue

        if (seen.includes(current)) continue
        seen.push(current)

        for (const child of childPids(current)) pending.push(child)
    }

    return seen
}

function socketInodes(pid: number): Set<string> {
    const inodes = new Set<string>()
    let fds: string[]

    try {
        fds = readdirSync(`/proc/${pid}/fd`)
    } catch {
        return inodes
    }

    for (const fd of fds) {
        let target = ''

        try {
            target = readlinkSync(`/proc/${pid}/fd/${fd}`)
        } catch {
            continue
        }

        if (!target.startsWith('socket:[') || !target.endsWith(']')) continue
        inodes.add(target.slice('socket:['.length, -1))
    }

    return inodes
}

function parseListenLine(
    family: 'tcp' | 'tcp6',
    line: string,
    inodes: ReadonlySet<string>,
): ListenSocket | null {
    const parts = line.trim().split(/\s+/)
    const local = parts[1]
    const state = parts[3]
    const inode = parts[9]

    if (local === undefined || state !== tcpListenState || inode === undefined) return null

    if (!inodes.has(inode)) return null

    const port = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16)

    if (!Number.isInteger(port)) return null

    return { family, port }
}

function listenSockets(pid: number): ListenSocket[] {
    const inodes = socketInodes(pid)
    const found: ListenSocket[] = []

    const tables: Array<{ family: 'tcp' | 'tcp6'; path: string }> = [
        { family: 'tcp', path: '/proc/net/tcp' },
        { family: 'tcp6', path: '/proc/net/tcp6' },
    ]

    for (const table of tables) {
        const lines = readFileSync(table.path, 'utf8').split('\n').slice(1)

        for (const line of lines) {
            const socket = parseListenLine(table.family, line, inodes)

            if (socket === null) continue
            found.push(socket)
        }
    }

    return found
}

function treeListenSockets(pid: number): ListenSocket[] {
    if (process.platform !== 'linux') {
        throw new Error('TCP listen scan reads /proc/net/tcp and only runs on Linux')
    }

    const sockets: ListenSocket[] = []

    for (const id of processTree(pid)) {
        for (const socket of listenSockets(id)) sockets.push(socket)
    }

    return sockets
}

const developmentServerText = 'Started development server'

type JsonRpcMessage = {
    jsonrpc: string
}

function nonJsonRpcStdoutLines(stdout: string): string[] {
    const lines: string[] = []

    for (const line of stdout.split('\n')) {
        if (line === '') continue

        try {
            const message = parseJson<JsonRpcMessage>(line)

            if (message.jsonrpc === '2.0') continue
            lines.push(line)
        } catch {
            lines.push(line)
        }
    }

    return lines
}

function toolNames(stdout: string): string[] {
    for (const line of stdout.split('\n')) {
        if (!line.includes('"id":2') || !line.includes('"tools"')) continue

        const message = parseJson<McpToolListMessage>(line)

        return message.result.tools.map((tool) => tool.name)
    }

    throw new Error(`tools/list response missing\n${stdout}`)
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

function runMcp(): Promise<{ pid: number; stdout: string; stop: () => void }> {
    return new Promise((resolvePromise, reject) => {
        const env = { ...process.env }

        delete env.PORT

        const child: ChildProcessWithoutNullStreams = spawn('bun', ['src/cli.ts', '--mcp'], {
            cwd: walletDir,
            env,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''

        const timer = setTimeout(() => {
            killChild(child)
            reject(new Error(`MCP initialize/tools/list timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        }, 20_000)

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk

            if (!stdout.includes('"id":1') || !stdout.includes('"id":2')) return
            clearTimeout(timer)

            const pid = child.pid

            if (pid === undefined) {
                killChild(child)
                reject(new Error('MCP process has no pid'))

                return
            }

            resolvePromise({
                pid,
                stdout,
                stop: () => {
                    killChild(child)
                },
            })
        })
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk
        })
        child.on('error', (error: Error) => {
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
                    clientInfo: { name: 'mcp-stdio-only', version: '0.0.0' },
                },
            }),
        )
        child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
        child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    })
}

test.serial(
    'nubl --mcp stdout is JSON-RPC only',
    async () => {
        const session = await runMcp()

        try {
            const names = toolNames(session.stdout)

            expect(session.stdout).toContain('"id":1')
            expect(names).toContain('address')
            expect(names).toContain('send')
            expect(names).toContain('account_balance')
            expect({
                startedDevelopmentServer: session.stdout.includes(developmentServerText),
                nonJsonRpcStdoutLines: nonJsonRpcStdoutLines(session.stdout),
            }).toEqual({
                startedDevelopmentServer: false,
                nonJsonRpcStdoutLines: [],
            })
        } finally {
            session.stop()
        }
    },
    20_000,
)

// /proc/net/tcp is Linux-only. skipIf reports a skip on other platforms
// instead of treating a missing scan as a pass.
test.skipIf(process.platform !== 'linux').serial(
    'nubl --mcp has no TCP listen socket (skipped off Linux: /proc/net/tcp is unavailable)',
    async () => {
        const session = await runMcp()

        try {
            await new Promise((resolvePromise) => {
                setTimeout(resolvePromise, 200)
            })

            expect(treeListenSockets(session.pid)).toEqual([])
        } finally {
            session.stop()
        }
    },
    20_000,
)
