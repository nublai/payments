import { spawn } from 'node:child_process'
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'

/**
 * Simulate the exact calls we would sign, on the wallet's own chain RPC.
 * `eth_simulateV1` (validation off, so the account does not need to be an
 * EOA and gas is not bought from its ETH). If that method is missing, fork
 * the same RPC with anvil and run `eth_simulateV1` there. If neither works,
 * refuse.
 *
 * Base `https://mainnet.base.org` and Polygon `https://polygon.drpc.org`
 * both answered `eth_simulateV1` on 2026-10-07. The result's `calls[].returnData`
 * and `calls[].status` are what we read.
 */

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address
const BALANCE_OF = '0x70a08231'

export class RelaySimulationRejected extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RelaySimulationRejected'
    }
}

export type SimulatedCall = {
    to: Address
    data: Hex
    value: bigint
}

export type SimulatedWatch =
    | { kind: 'native'; role: 'origin' | 'output' | 'other' }
    | { kind: 'erc20'; token: Address; role: 'origin' | 'output' | 'other' }

export type SimulateRelayQuoteInput = {
    rpcUrl: string
    chainId: number
    user: Address
    calls: SimulatedCall[]
    watches: SimulatedWatch[]
    cap: bigint
    sameChain: boolean
    minimumOutput?: bigint
    request?: (method: string, params: unknown[]) => Promise<unknown>
}

type BalanceBook = {
    native: bigint
    tokens: Map<string, bigint>
}

function padAddress(address: Address): string {
    return address.toLowerCase().slice(2).padStart(64, '0')
}

function balanceOfData(token: Address, user: Address): Hex {
    return `${BALANCE_OF}${padAddress(user)}` as Hex
}

function getEthBalanceData(user: Address): Hex {
    return encodeFunctionData({
        abi: [
            {
                name: 'getEthBalance',
                type: 'function',
                stateMutability: 'view',
                inputs: [{ name: 'addr', type: 'address' }],
                outputs: [{ type: 'uint256' }],
            },
        ],
        functionName: 'getEthBalance',
        args: [user],
    })
}

function decodeWord(data: unknown): bigint {
    if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    const body = data.slice(2)
    if (body.length === 0) return 0n
    if (body.length > 64) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    return BigInt(data)
}

function isMethodMissing(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return (
        message.includes('-32601') ||
        /method .*not found/i.test(message) ||
        /does not exist/i.test(message)
    )
}

async function defaultRequest(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
    let response: Response
    try {
        response = await fetch(rpcUrl, {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
    } catch (error) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    if (!response.ok) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    const payload = (await response.json()) as { result?: unknown; error?: { code?: number; message?: string } }
    if (payload.error) {
        const code = payload.error.code
        const message = payload.error.message ?? 'rpc error'
        const wrapped = new Error(`${code ?? ''} ${message}`)
        if (code === -32601) throw wrapped
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    return payload.result
}

function dedupedWatches(watches: SimulatedWatch[]): SimulatedWatch[] {
    const seen = new Set<string>()
    const ordered: SimulatedWatch[] = []
    const rank = { origin: 0, output: 1, other: 2 }
    const sorted = [...watches].sort((a, b) => rank[a.role] - rank[b.role])
    for (const watch of sorted) {
        const key = watch.kind === 'native' ? 'native' : watch.token.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        ordered.push(watch)
    }
    return ordered
}

export function assertBalanceDeltas(input: {
    watches: SimulatedWatch[]
    before: BalanceBook
    after: BalanceBook
    cap: bigint
    sameChain: boolean
    minimumOutput?: bigint
}): void {
    let sawOrigin = false
    let sawOutput = false
    for (const watch of dedupedWatches(input.watches)) {
        const before =
            watch.kind === 'native'
                ? input.before.native
                : input.before.tokens.get(watch.token.toLowerCase())
        const after =
            watch.kind === 'native'
                ? input.after.native
                : input.after.tokens.get(watch.token.toLowerCase())
        if (before === undefined || after === undefined) {
            throw new RelaySimulationRejected(
                'relay.link quote could not be simulated. Refusing to sign.',
            )
        }
        const label = watch.kind === 'native' ? 'ETH' : watch.token
        if (watch.role === 'origin') {
            sawOrigin = true
            if (before - after > input.cap) {
                throw new RelaySimulationRejected(
                    `relay.link quote would spend ${before - after} of ${label}, above the quoted input of ${input.cap}.`,
                )
            }
            continue
        }
        if (watch.role === 'output' && input.sameChain) {
            sawOutput = true
            if (input.minimumOutput === undefined) {
                throw new RelaySimulationRejected(
                    'relay.link quote did not include an output minimum. Refusing to sign.',
                )
            }
            if (after < before + input.minimumOutput) {
                throw new RelaySimulationRejected(
                    `relay.link quote would deliver ${after - before} of ${label}, below the quoted minimum of ${input.minimumOutput}.`,
                )
            }
            continue
        }
        if (after < before) {
            throw new RelaySimulationRejected(
                `relay.link quote would lower ${label} by ${before - after}, which this quote did not ask to spend.`,
            )
        }
    }
    if (!sawOrigin) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    if (input.sameChain && !sawOutput) {
        throw new RelaySimulationRejected(
            'relay.link quote did not include an output minimum. Refusing to sign.',
        )
    }
}

type RpcCall = { from: Address; to: Address; data: Hex; value: string }

function probeCalls(user: Address, watches: SimulatedWatch[]): RpcCall[] {
    const probes: RpcCall[] = []
    for (const watch of watches) {
        if (watch.kind === 'native') {
            probes.push({
                from: user,
                to: MULTICALL3,
                data: getEthBalanceData(user),
                value: '0x0',
            })
            continue
        }
        probes.push({
            from: user,
            to: getAddress(watch.token),
            data: balanceOfData(watch.token, user),
            value: '0x0',
        })
    }
    return probes
}

function readBook(watches: SimulatedWatch[], words: bigint[]): BalanceBook {
    const book: BalanceBook = { native: 0n, tokens: new Map() }
    watches.forEach((watch, index) => {
        const word = words[index]
        if (word === undefined) {
            throw new RelaySimulationRejected(
                'relay.link quote could not be simulated. Refusing to sign.',
            )
        }
        if (watch.kind === 'native') book.native = word
        else book.tokens.set(watch.token.toLowerCase(), word)
    })
    return book
}

async function readBefore(
    input: SimulateRelayQuoteInput,
    watches: SimulatedWatch[],
    request: (method: string, params: unknown[]) => Promise<unknown>,
): Promise<BalanceBook> {
    const words: bigint[] = []
    for (const watch of watches) {
        if (watch.kind === 'native') {
            const result = await request('eth_getBalance', [input.user, 'latest'])
            words.push(decodeWord(result))
            continue
        }
        const result = await request('eth_call', [
            { to: watch.token, data: balanceOfData(watch.token, input.user) },
            'latest',
        ])
        words.push(decodeWord(result))
    }
    return readBook(watches, words)
}

function parseSimulateResult(result: unknown, userCallCount: number): bigint[] {
    if (!Array.isArray(result) || !result[0] || typeof result[0] !== 'object') {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    const calls = (result[0] as { calls?: unknown }).calls
    if (!Array.isArray(calls) || calls.length < userCallCount) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    for (const call of calls) {
        const row = call as { status?: string; error?: unknown }
        const status = row?.status
        const ok = status === '0x1' || status === '0x01' || status === '1'
        if (!ok || row.error) {
            throw new RelaySimulationRejected(
                'relay.link quote simulation reverted. Refusing to sign.',
            )
        }
    }
    return calls.slice(userCallCount).map((call) => {
        const row = call as { returnData?: string }
        return decodeWord(row.returnData)
    })
}

async function simulateOnce(
    input: SimulateRelayQuoteInput,
    watches: SimulatedWatch[],
    request: (method: string, params: unknown[]) => Promise<unknown>,
): Promise<BalanceBook> {
    const userCalls: RpcCall[] = input.calls.map((call) => ({
        from: input.user,
        to: call.to,
        data: call.data,
        value: `0x${call.value.toString(16)}`,
    }))
    const probes = probeCalls(input.user, watches)
    const result = await request('eth_simulateV1', [
        {
            blockStateCalls: [{ calls: [...userCalls, ...probes] }],
            validation: false,
            traceTransfers: true,
        },
        'latest',
    ])
    const words = parseSimulateResult(result, userCalls.length)
    if (words.length !== watches.length) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    return readBook(watches, words)
}

function forkAndSimulate(
    input: SimulateRelayQuoteInput,
    watches: SimulatedWatch[],
): Promise<BalanceBook> {
    return new Promise((resolve, reject) => {
        const port = 18000 + Math.floor(Math.random() * 20000)
        let settled = false
        const child = spawn(
            'anvil',
            [
                '--fork-url',
                input.rpcUrl,
                '--port',
                String(port),
                '--chain-id',
                String(input.chainId),
                '--silent',
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        const finish = (error?: Error, book?: BalanceBook) => {
            if (settled) return
            settled = true
            child.kill('SIGKILL')
            if (error) reject(error)
            else if (book) resolve(book)
            else
                reject(
                    new RelaySimulationRejected(
                        'relay.link quote could not be simulated. Refusing to sign.',
                    ),
                )
        }
        const timer = setTimeout(() => {
            finish(
                new RelaySimulationRejected(
                    'relay.link quote could not be simulated. Refusing to sign.',
                ),
            )
        }, 20_000)
        child.on('error', () => {
            clearTimeout(timer)
            finish(
                new RelaySimulationRejected(
                    'relay.link quote could not be simulated. Refusing to sign.',
                ),
            )
        })
        const started = Date.now()
        const poll = async () => {
            if (settled) return
            if (Date.now() - started > 15_000) return
            const request = (method: string, params: unknown[]) =>
                defaultRequest(`http://127.0.0.1:${port}`, method, params)
            try {
                await request('eth_chainId', [])
            } catch {
                setTimeout(() => {
                    void poll()
                }, 200)
                return
            }
            try {
                const after = await simulateOnce(input, watches, request)
                clearTimeout(timer)
                finish(undefined, after)
            } catch (error) {
                clearTimeout(timer)
                finish(
                    error instanceof RelaySimulationRejected
                        ? error
                        : new RelaySimulationRejected(
                              'relay.link quote could not be simulated. Refusing to sign.',
                          ),
                )
            }
        }
        setTimeout(() => {
            void poll()
        }, 200)
    })
}

export async function simulateRelayQuote(input: SimulateRelayQuoteInput): Promise<void> {
    if (input.sameChain && input.minimumOutput === undefined) {
        throw new RelaySimulationRejected(
            'relay.link quote did not include an output minimum. Refusing to sign.',
        )
    }
    const watches = dedupedWatches(input.watches)
    if (!watches.some((watch) => watch.role === 'origin')) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    const request = input.request ?? ((method: string, params: unknown[]) => defaultRequest(input.rpcUrl, method, params))
    let before: BalanceBook
    try {
        before = await readBefore(input, watches, request)
    } catch (error) {
        if (error instanceof RelaySimulationRejected) throw error
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }
    let after: BalanceBook
    try {
        after = await simulateOnce(input, watches, request)
    } catch (error) {
        if (error instanceof RelaySimulationRejected && !isMethodMissing(error)) throw error
        if (input.request) {
            throw error instanceof RelaySimulationRejected
                ? error
                : new RelaySimulationRejected(
                      'relay.link quote could not be simulated. Refusing to sign.',
                  )
        }
        if (!isMethodMissing(error) && error instanceof RelaySimulationRejected) throw error
        try {
            after = await forkAndSimulate(input, watches)
        } catch (forkError) {
            if (forkError instanceof RelaySimulationRejected) throw forkError
            throw new RelaySimulationRejected(
                'relay.link quote could not be simulated. Refusing to sign.',
            )
        }
    }
    assertBalanceDeltas({
        watches,
        before,
        after,
        cap: input.cap,
        sameChain: input.sameChain,
        minimumOutput: input.minimumOutput,
    })
}
