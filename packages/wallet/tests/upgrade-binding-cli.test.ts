import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
    encodeAbiParameters,
    getAddress,
    parseAbiParameters,
    zeroAddress,
    type Address,
} from 'viem'
import { hashAuthorization, hashTypedData } from 'viem/utils'
import { INTENT_TYPES, type AuthorizeKey } from '@nubl/relayer-client'
import { emptyHex, hex, parseHex } from './helpers/hex'
import { parseJson } from './helpers/parse-json'

const walletDir = resolve(import.meta.dir, '..')

const PASSWORD = 'test-password'

const LOCAL_PROXY = '0x1111111111111111111111111111111111111111'

const LOCAL_ORCH = '0x2222222222222222222222222222222222222222'

const ATTACKER = getAddress('0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF')

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const TX_HASH = `0x${'ab'.repeat(32)}`

const SEND_NONCE = 4n

type UpgradeMode = 'honest-upgrade' | 'bad-capabilities' | 'bad-chain' | 'bad-nonce' | 'bad-call'

type SendMode = 'honest-send' | 'expiry-zero' | 'huge-gas'

type Mode = UpgradeMode | SendMode

type Recorded = { method: string; body: string }

type JsonRpcRequestBody = { id?: number; method?: string; params?: unknown }

type DevEnv = {
    RELAYER_URL_DEV: string
    ACCOUNT_PROXY_31337: string
    ORCHESTRATOR_31337: string
    ACCOUNT_31337: string
    SIMPLE_FUNDER_31337: string
    SIMULATOR_31337: string
    SIMPLE_SETTLER_31337: string
    ESCROW_31337: string
    MULTI_SIG_SIGNER_31337: string
}

function pool() {
    return {
        signerCount: 1,
        totalCapacity: 1,
        totalPending: 0,
        availableCapacity: 1,
        signers: [],
    }
}

function capabilities(chainId: number, delegation: Address, orchestrator: Address) {
    return {
        [`0x${chainId.toString(16)}`]: {
            contracts: {
                orchestrator,
                delegation,
                simulator: '0xDAD7c34d0c41698B227D3C5ee3d6d88A78c63a65',
            },
            pool: pool(),
        },
    }
}

type RpcPayload = {
    address?: string
    delegation?: string
    from?: string
    calls?: Array<{ to?: string; data?: string; value?: string }>
    capabilities?: {
        authorizeKeys?: unknown[]
        meta?: {
            expiry?: string
            nonce?: string
            fee_payer?: string
            fee_token?: string
            fee_max_amount?: string
        }
    }
}

function firstParam(params: unknown): RpcPayload {
    const value = Array.isArray(params) ? params[0] : params

    if (value === undefined || value === null) return {}

    // SAFETY: wallet_prepare* params[0] is the request object this stub unpacks.
    return value as RpcPayload
}

async function honestUpgradePayload(input: {
    address: Address
    delegation: Address
    chainId: number
    orchestrator: Address
    txNonce: number
    authorizeKeys: unknown[]
}) {
    const mod = await import('../../relayer-client/src/helpers/bindPreparedUpgrade.ts')
    const accountAddress = getAddress(input.address)
    const delegation = getAddress(input.delegation)
    const orchestrator = getAddress(input.orchestrator)

    // SAFETY: this stub forwards authorizeKeys from the prepare request into the upgrade builder.
    const { calls, executionData } = mod.buildUpgradeExecution(
        input.authorizeKeys as readonly AuthorizeKey[],
        accountAddress,
    )

    const authDigest = hashAuthorization({
        chainId: input.chainId,
        contractAddress: delegation,
        nonce: input.txNonce,
    })

    const domain = {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId: input.chainId,
        verifyingContract: orchestrator,
    }

    const execDigest = hashTypedData({
        domain,
        types: mod.SIGNED_CALL_TYPES,
        primaryType: 'SignedCall',
        message: {
            multichain: false,
            eoa: accountAddress,
            calls,
            nonce: mod.UPGRADE_PRECALL_NONCE,
        },
    })

    return {
        chainId: `0x${input.chainId.toString(16)}`,
        digests: { auth: authDigest, exec: execDigest },
        typedData: {
            domain,
            types: mod.SIGNED_CALL_TYPES,
            primaryType: 'SignedCall',
            message: {
                multichain: false,
                eoa: accountAddress,
                calls: calls.map((call) => ({
                    to: call.to,
                    value: call.value.toString(),
                    data: call.data,
                })),
                nonce: mod.UPGRADE_PRECALL_NONCE.toString(),
            },
        },
        context: {
            address: accountAddress,
            chainId: `0x${input.chainId.toString(16)}`,
            authorization: {
                contractAddress: delegation,
                chainId: input.chainId,
                nonce: input.txNonce,
            },
            preCall: {
                eoa: accountAddress,
                executionData,
                nonce: mod.UPGRADE_PRECALL_NONCE.toString(),
                signature: '0x',
            },
        },
        capabilities: { authorizeKeys: input.authorizeKeys },
    }
}

function evilAuthPayload(input: {
    chainId: number
    contract: Address
    nonce: number
    address: Address
}) {
    const authDigest = hashAuthorization({
        chainId: input.chainId,
        contractAddress: getAddress(input.contract),
        nonce: input.nonce,
    })

    return {
        chainId: `0x${input.chainId.toString(16)}`,
        digests: { auth: authDigest, exec: `0x${'00'.repeat(32)}` },
        typedData: {
            domain: {
                name: 'Orchestrator',
                version: '0.5.5',
                chainId: input.chainId,
                verifyingContract: LOCAL_ORCH,
            },
            types: {
                SignedCall: [
                    { name: 'multichain', type: 'bool' },
                    { name: 'eoa', type: 'address' },
                    { name: 'calls', type: 'Call[]' },
                    { name: 'nonce', type: 'uint256' },
                ],
                Call: [
                    { name: 'to', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'data', type: 'bytes' },
                ],
            },
            primaryType: 'SignedCall',
            message: {
                multichain: false,
                eoa: input.address,
                calls: [{ to: ATTACKER, value: '0', data: '0xdeadbeef' }],
                nonce: '1',
            },
        },
        context: {
            authorization: {
                contractAddress: getAddress(input.contract),
                chainId: input.chainId,
                nonce: input.nonce,
            },
            preCall: {
                eoa: input.address,
                executionData: '0x',
                nonce: '1',
            },
        },
    }
}

function attackerCallPayload(input: {
    address: Address
    delegation: Address
    chainId: number
    orchestrator: Address
    txNonce: number
}) {
    const accountAddress = getAddress(input.address)
    const calls = [{ to: ATTACKER, value: 0n, data: hex('0xdeadbeef') }]

    const executionData = encodeAbiParameters(
        parseAbiParameters('(address to, uint256 value, bytes data)[]'),
        [calls],
    )

    const authDigest = hashAuthorization({
        chainId: input.chainId,
        contractAddress: getAddress(input.delegation),
        nonce: input.txNonce,
    })

    const domain = {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId: input.chainId,
        verifyingContract: getAddress(input.orchestrator),
    }

    const nonce = 1n << 64n

    const execDigest = hashTypedData({
        domain,
        types: {
            SignedCall: [
                { name: 'multichain', type: 'bool' },
                { name: 'eoa', type: 'address' },
                { name: 'calls', type: 'Call[]' },
                { name: 'nonce', type: 'uint256' },
            ],
            Call: [
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'data', type: 'bytes' },
            ],
        },
        primaryType: 'SignedCall',
        message: {
            multichain: false,
            eoa: accountAddress,
            calls,
            nonce,
        },
    })

    return {
        digests: { auth: authDigest, exec: execDigest },
        typedData: {
            domain,
            types: {
                SignedCall: [
                    { name: 'multichain', type: 'bool' },
                    { name: 'eoa', type: 'address' },
                    { name: 'calls', type: 'Call[]' },
                    { name: 'nonce', type: 'uint256' },
                ],
                Call: [
                    { name: 'to', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'data', type: 'bytes' },
                ],
            },
            primaryType: 'SignedCall',
            message: {
                multichain: false,
                eoa: accountAddress,
                calls: calls.map((call) => ({
                    to: call.to,
                    value: call.value.toString(),
                    data: call.data,
                })),
                nonce: nonce.toString(),
            },
        },
        context: {
            authorization: {
                contractAddress: getAddress(input.delegation),
                chainId: input.chainId,
                nonce: input.txNonce,
            },
            preCall: {
                eoa: accountAddress,
                executionData,
                nonce: nonce.toString(),
            },
        },
    }
}

function sendPayload(input: {
    from: Address
    calls: Array<{ to?: string; data?: string; value?: string }>
    chainId: number
    orchestrator: Address
    nonce: bigint
    expiry: string
    combinedGas: string
    payer: Address
    paymentToken: Address
    paymentMaxAmount: string
}) {
    const messageCalls = input.calls.map((call) => ({
        to: getAddress(call.to ?? zeroAddress),
        value: BigInt(call.value ?? '0'),
        data: parseHex(call.data ?? '0x'),
    }))

    const message = {
        multichain: false,
        eoa: getAddress(input.from),
        calls: messageCalls,
        nonce: input.nonce,
        payer: input.payer,
        paymentToken: input.paymentToken,
        paymentMaxAmount: BigInt(input.paymentMaxAmount),
        combinedGas: BigInt(input.combinedGas),
        encodedPreCalls: emptyHex(),
        encodedFundTransfers: emptyHex(),
        settler: zeroAddress,
        expiry: BigInt(input.expiry),
    }

    const domain = {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId: input.chainId,
        verifyingContract: getAddress(input.orchestrator),
    }

    const digest = hashTypedData({
        domain,
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message,
    })

    const wireCalls = messageCalls.map((call) => ({
        to: call.to,
        value: call.value.toString(),
        data: call.data,
    }))

    return {
        digest,
        typedData: {
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent',
            message: {
                ...message,
                calls: wireCalls,
                nonce: message.nonce.toString(),
                paymentMaxAmount: message.paymentMaxAmount.toString(),
                combinedGas: message.combinedGas.toString(),
                expiry: message.expiry.toString(),
            },
        },
        context: {
            quote: {
                quotes: [
                    {
                        chainId: `0x${input.chainId.toString(16)}`,
                        orchestrator: getAddress(input.orchestrator),
                        intent: {
                            eoa: message.eoa,
                            calls: wireCalls,
                            nonce: message.nonce.toString(),
                            combinedGas: message.combinedGas.toString(),
                            expiry: message.expiry.toString(),
                            payer: message.payer,
                            paymentToken: message.paymentToken,
                            paymentMaxAmount: message.paymentMaxAmount.toString(),
                            settler: zeroAddress,
                        },
                        extraPayment: '0x0',
                        ethPrice: '0x0',
                        paymentTokenDecimals: 6,
                        txGas: 1,
                        nativeFeeEstimate: { maxFeePerGas: 1, maxPriorityFeePerGas: 1 },
                        paymentAmount: '0',
                        feeTokenDeficit: '0x0',
                        assetDeficits: [],
                    },
                ],
                signature: '0x',
                ttl: 2_000_000_000,
            },
        },
        capabilities: { feeTotals: {}, assetDiffs: {} },
        signature: '0x',
    }
}

type MockRelayerReply =
    | string
    | ReturnType<typeof capabilities>
    | ReturnType<typeof evilAuthPayload>
    | ReturnType<typeof attackerCallPayload>
    | ReturnType<typeof sendPayload>
    | Awaited<ReturnType<typeof honestUpgradePayload>>
    | { txHash: string }
    | { id: string }
    | {
          id: string
          status: number
          receipts: Array<{
              transaction_hash: string
              block_number: string
              gas_used: string
              status: boolean
          }>
      }

class MockRelayer {
    readonly calls: Recorded[] = []
    private server: Server | undefined

    constructor(
        private readonly mode: Mode,
        private readonly chainId: number,
        private readonly orchestrator: Address,
        private readonly delegation: Address,
    ) {}

    get methods(): string[] {
        return this.calls.map((call) => call.method)
    }

    submitted(): boolean {
        return this.methods.some(
            (method) => method === 'wallet_upgradeAccount' || method === 'wallet_sendPreparedCalls',
        )
    }

    signed(): boolean {
        return this.calls.some(
            (call) =>
                (call.method === 'wallet_upgradeAccount' || call.method === 'wallet_sendPreparedCalls') &&
                (call.body.includes('"signatures"') || call.body.includes('"signature"')),
        )
    }

    async start(port: number): Promise<number> {
        this.server = createServer(async (req, res) => {
            const chunks: Buffer[] = []

            for await (const chunk of req) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
            }

            const raw = Buffer.concat(chunks).toString('utf8')
            let body: JsonRpcRequestBody

            try {
                body = parseJson<typeof body>(raw || '{}')
            } catch {
                body = {}
            }

            const method = body.method ?? ''
            this.calls.push({ method, body: raw })

            try {
                const result = await this.reply(method, body.params)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: body.id ?? 1,
                        error: { code: -32000, message },
                    }),
                )
            }
        })
        await new Promise<void>((resolveListen, reject) => {
            this.server?.once('error', reject)
            this.server?.listen(port, '127.0.0.1', () => resolveListen())
        })
        const address = this.server.address()

        if (!address || typeof address === 'string') throw new Error('mock relayer has no port')

        return address.port
    }

    stop(): Promise<void> {
        return new Promise((resolveStop) => {
            if (!this.server) {
                resolveStop()

                return
            }

            this.server.close(() => resolveStop())
        })
    }

    private async reply(method: string, params: unknown): Promise<MockRelayerReply> {
        if (method === 'eth_chainId') return `0x${this.chainId.toString(16)}`

        if (method === 'eth_getCode') return '0x'

        if (method === 'eth_getTransactionCount') return '0x5'

        if (method === 'eth_call') return `0x${SEND_NONCE.toString(16).padStart(64, '0')}`

        if (method === 'eth_estimateGas') return '0x10000'

        if (method === 'eth_blockNumber') return '0x1'

        if (method === 'eth_getBalance') return '0x0'

        if (method === 'net_version') return String(this.chainId)

        if (method === 'wallet_getCapabilities') {
            const delegation = this.mode === 'bad-capabilities' ? ATTACKER : this.delegation

            return capabilities(this.chainId, delegation, this.orchestrator)
        }

        if (method === 'wallet_prepareUpgradeAccount') {
            const payload = firstParam(params)
            const address = getAddress(String(payload.address))
            const delegation = getAddress(String(payload.delegation ?? this.delegation))

            const keys = payload.capabilities?.authorizeKeys ?? []

            if (this.mode === 'bad-chain') {
                return evilAuthPayload({ chainId: 1, contract: ATTACKER, nonce: 5, address })
            }

            if (this.mode === 'bad-nonce') {
                return evilAuthPayload({
                    chainId: this.chainId,
                    contract: delegation,
                    nonce: 9,
                    address,
                })
            }

            if (this.mode === 'bad-call') {
                return attackerCallPayload({
                    address,
                    delegation,
                    chainId: this.chainId,
                    orchestrator: this.orchestrator,
                    txNonce: 5,
                })
            }

            return honestUpgradePayload({
                address,
                delegation,
                chainId: this.chainId,
                orchestrator: this.orchestrator,
                txNonce: 5,
                authorizeKeys: keys,
            })
        }

        if (method === 'wallet_upgradeAccount') {
            return { txHash: TX_HASH }
        }

        if (method === 'wallet_prepareCalls') {
            const payload = firstParam(params)

            const meta = payload.capabilities?.meta ?? {}
            const calls = payload.calls ?? []

            const expiry = this.mode === 'expiry-zero' ? '0' : (meta.expiry ?? '1900000000')

            const combinedGas =
                this.mode === 'huge-gas' ? (2n ** 96n - 1n).toString() : '50000'

            return sendPayload({
                from: getAddress(String(payload.from)),
                calls,
                chainId: this.chainId,
                orchestrator: this.orchestrator,
                nonce: BigInt(meta.nonce ?? SEND_NONCE.toString()),
                expiry,
                combinedGas,
                payer: getAddress(meta.fee_payer ?? zeroAddress),
                paymentToken: getAddress(meta.fee_token ?? zeroAddress),
                paymentMaxAmount: meta.fee_max_amount ?? '0',
            })
        }

        if (method === 'wallet_sendPreparedCalls') return { id: 'bundle-1' }

        if (method === 'wallet_getCallsStatus') {
            return {
                id: 'bundle-1',
                status: 200,
                receipts: [
                    {
                        transaction_hash: TX_HASH,
                        block_number: '0x1',
                        gas_used: '0x1',
                        status: true,
                    },
                ],
            }
        }

        return '0x0'
    }
}

function runCli(
    args: string[],
    env: Record<string, string>,
    timeoutMs = 90_000,
    phrase?: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
        // PR 17 reads the confirmation phrase from a TTY. This is the same
        // helper passkey-flow and the local e2e scripts use. Assertions are unchanged.
        const child = spawn(
            phrase ? 'python3' : 'bun',
            phrase
                ? [
                      resolve(walletDir, '../../scripts/tw-tty-confirm.py'),
                      phrase,
                      'bun',
                      'src/cli.ts',
                      ...args,
                  ]
                : ['src/cli.ts', ...args],
            {
            cwd: walletDir,
            env: {
                ...process.env,
                HOME: mkdtempSync(join(tmpdir(), 'tw-home-')),
                TW_PASSWORD: PASSWORD,
                PATH: `/tmp/node22/bin:${process.env.HOME}/.bun/bin:${process.env.PATH ?? ''}`,
                ...env,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''

        const timer = setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error(`tw timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        }, timeoutMs)

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            stdout += chunk
        })
        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        child.on('close', (code) => {
            clearTimeout(timer)
            resolvePromise({ status: code ?? 1, stdout, stderr })
        })
    })
}

async function withServer<T>(
    mode: Mode,
    port: number,
    chainId: number,
    orchestrator: Address,
    delegation: Address,
    fn: (server: MockRelayer, url: string) => Promise<T>,
): Promise<T> {
    const server = new MockRelayer(mode, chainId, orchestrator, delegation)
    const actual = await server.start(port)
    const url = `http://127.0.0.1:${actual}`

    try {
        return await fn(server, url)
    } finally {
        await server.stop()
    }
}

let gate: Promise<unknown> = Promise.resolve()

function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = gate.then(fn, fn)
    gate = run.then(
        () => undefined,
        () => undefined,
    )

    return run
}

let sharedDir = ''

beforeAll(async () => {
    sharedDir = mkdtempSync(join(tmpdir(), 'tw-h5-profile-'))
    const keystore = join(sharedDir, 'account.json')
    await withServer('honest-upgrade', 0, 31337, LOCAL_ORCH, LOCAL_PROXY, async (_server, url) => {
        const result = await runCli(
            [
                'account',
                'create',
                '--env',
                'dev',
                '--relayer-url',
                url,
                '--rpc-url',
                url,
                '--keystore-path',
                keystore,
                '--format',
                'json',
            ],
            devEnv(url),
            90_000,
            'CREATE FULL ACCESS SESSION',
        )

        if (result.status !== 0) {
            throw new Error(
                `honest account create failed (${result.status})\n${result.stdout}\n${result.stderr}`,
            )
        }
    })
}, 90_000)

afterAll(() => {})

function profileCopy(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tw-h5-copy-'))
    cpSync(sharedDir, dir, { recursive: true })

    return join(dir, 'account.json')
}

function devEnv(url: string): DevEnv {
    return {
        RELAYER_URL_DEV: url,
        ACCOUNT_PROXY_31337: LOCAL_PROXY,
        ORCHESTRATOR_31337: LOCAL_ORCH,
        ACCOUNT_31337: '0x0000000000000000000000000000000000000003',
        SIMPLE_FUNDER_31337: '0x0000000000000000000000000000000000000004',
        SIMULATOR_31337: '0x0000000000000000000000000000000000000005',
        SIMPLE_SETTLER_31337: '0x0000000000000000000000000000000000000006',
        ESCROW_31337: '0x0000000000000000000000000000000000000007',
        MULTI_SIG_SIGNER_31337: '0x0000000000000000000000000000000000000008',
    }
}

async function runCreate(mode: UpgradeMode, keystore: string) {
    return withServer(mode, 0, 31337, LOCAL_ORCH, LOCAL_PROXY, async (server, url) => {
        const result = await runCli(
            [
                'account',
                'create',
                '--env',
                'dev',
                '--relayer-url',
                url,
                '--rpc-url',
                url,
                '--keystore-path',
                keystore,
                '--format',
                'json',
            ],
            devEnv(url),
            90_000,
            'CREATE FULL ACCESS SESSION',
        )

        return { server, result }
    })
}

async function runDelegate(mode: UpgradeMode) {
    return locked(() =>
        withServer(mode, 8545, 31337, LOCAL_ORCH, LOCAL_PROXY, async (server, url) => {
            const result = await runCli(
                [
                    'account',
                    'delegate',
                    '--env',
                    'dev',
                    '--chain',
                    'anvil',
                    '--keystore-path',
                    profileCopy(),
                    '--format',
                    'json',
                ],
                devEnv(url),
                90_000,
                'CREATE FULL ACCESS SESSION',
            )

            return { server, result }
        }),
    )
}

function assertNoSubmit(server: MockRelayer, result: { status: number; stdout: string; stderr: string }) {
    const output = `${result.stdout}\n${result.stderr}\n${server.methods.join(',')}`
    expect(server.submitted(), output).toBe(false)
    expect(server.signed(), output).toBe(false)
}

test('account create on prod refuses because contracts are not deployed', async () => {
    const keystore = join(mkdtempSync(join(tmpdir(), 'tw-h5-prod-')), 'account.json')

    const result = await runCli(
        [
            'account',
            'create',
            '--env',
            'prod',
            '--relayer-url',
            'https://127.0.0.1:9',
            '--rpc-url',
            'https://127.0.0.1:9',
            '--keystore-path',
            keystore,
            '--format',
            'json',
        ],
        { RELAYER_URL_PROD: 'https://127.0.0.1:9' },
        30_000,
        'CREATE FULL ACCESS SESSION',
    )

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/not deployed/)
}, 30_000)

test('account create refuses an attacker delegation from getCapabilities', async () => {
    const keystore = join(mkdtempSync(join(tmpdir(), 'tw-h5-create-')), 'account.json')
    const { server, result } = await runCreate('bad-capabilities', keystore)
    assertNoSubmit(server, result)
    expect(server.methods, server.methods.join(',')).not.toContain('wallet_prepareUpgradeAccount')
    expect(result.status).not.toBe(0)
}, 90_000)

test('account create refuses an authorization for the wrong chain', async () => {
    const keystore = join(mkdtempSync(join(tmpdir(), 'tw-h5-create-')), 'account.json')
    const { server, result } = await runCreate('bad-chain', keystore)
    assertNoSubmit(server, result)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/authorization digest does not match/)
}, 90_000)

test('account create refuses an authorization for the wrong nonce', async () => {
    const keystore = join(mkdtempSync(join(tmpdir(), 'tw-h5-create-')), 'account.json')
    const { server, result } = await runCreate('bad-nonce', keystore)
    assertNoSubmit(server, result)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/authorization digest does not match/)
}, 90_000)

test('account create refuses an attacker call in the upgrade SignedCall', async () => {
    const keystore = join(mkdtempSync(join(tmpdir(), 'tw-h5-create-')), 'account.json')
    const { server, result } = await runCreate('bad-call', keystore)
    assertNoSubmit(server, result)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/execution data does not match|call target does not match/)
}, 90_000)

test('account create signs an honest upgrade payload', async () => {
    const keystore = join(mkdtempSync(join(tmpdir(), 'tw-h5-create-')), 'account.json')
    const { server, result } = await runCreate('honest-upgrade', keystore)
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(server.methods).toContain('wallet_upgradeAccount')
}, 90_000)

test('account delegate refuses an attacker delegation from getCapabilities', async () => {
    const { server, result } = await runDelegate('bad-capabilities')
    assertNoSubmit(server, result)
    expect(server.methods).not.toContain('wallet_prepareUpgradeAccount')
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/does not match the local account proxy/)
}, 90_000)

test('account delegate refuses an authorization for the wrong chain', async () => {
    const { server, result } = await runDelegate('bad-chain')
    assertNoSubmit(server, result)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/authorization digest does not match/)
}, 90_000)

test('account delegate refuses an authorization for the wrong nonce', async () => {
    const { server, result } = await runDelegate('bad-nonce')
    assertNoSubmit(server, result)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/authorization digest does not match/)
}, 90_000)

test('account delegate refuses an attacker call in the upgrade SignedCall', async () => {
    const { server, result } = await runDelegate('bad-call')
    assertNoSubmit(server, result)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/execution data does not match|call target does not match/)
}, 90_000)

test('account delegate signs an honest upgrade payload', async () => {
    const { server, result } = await runDelegate('honest-upgrade')
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(server.methods).toContain('wallet_upgradeAccount')
    expect(result.stdout).toContain('delegated')
}, 90_000)

test('account create and delegate use the sponsored upgrade and never send accountUpgrade', async () => {
    const keystore = join(mkdtempSync(join(tmpdir(), 'tw-h5-create-')), 'account.json')
    const runs = [await runCreate('honest-upgrade', keystore), await runDelegate('honest-upgrade')]

    for (const { server, result } of runs) {
        const output = `${result.stdout}\n${result.stderr}\n${server.methods.join(',')}`
        expect(result.status, output).toBe(0)
        expect(server.methods, output).toContain('wallet_prepareUpgradeAccount')
        expect(server.methods, output).toContain('wallet_upgradeAccount')
        expect(server.methods, output).not.toContain('wallet_prepareCalls')
        expect(server.methods, output).not.toContain('wallet_sendPreparedCalls')
        expect(server.calls.filter((call) => call.body.includes('accountUpgrade')), output).toEqual([])
    }
}, 180_000)

async function runSend(mode: SendMode) {
    return locked(() =>
        withServer(mode, 8545, 31337, LOCAL_ORCH, LOCAL_PROXY, async (server, url) => {
            const result = await runCli(
                [
                    'send',
                    '1',
                    RECIPIENT,
                    '--env',
                    'dev',
                    '--chain',
                    'anvil',
                    '--keystore-path',
                    profileCopy(),
                    '--format',
                    'json',
                ],
                devEnv(url),
                90_000,
                'SEND USDC',
            )

            return { server, result }
        }),
    )
}

test('send refuses a relayer expiry of 0', async () => {
    const { server, result } = await runSend('expiry-zero')
    assertNoSubmit(server, result)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/expiry/)
}, 90_000)

test('send refuses combined gas above the wallet ceiling', async () => {
    const { server, result } = await runSend('huge-gas')
    assertNoSubmit(server, result)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/combined gas/)
}, 90_000)

test('send signs an honest local zero-fee intent', async () => {
    const { server, result } = await runSend('honest-send')
    expect(result.status, `${result.stdout}\n${result.stderr}\n${server.methods.join(',')}`).toBe(0)
    expect(server.methods).toContain('wallet_sendPreparedCalls')
}, 90_000)

function frame(message: {
    jsonrpc: string
    id?: number
    method: string
    params?: {
        protocolVersion?: string
        capabilities?: { [key: string]: never }
        clientInfo?: { name: string; version: string }
        name?: string
        arguments?: { [key: string]: string }
    }
}): string {
    return `${JSON.stringify(message)}\n`
}

test('CLI send refuses expiry 0 and a huge combined gas', async () => {
    // PR 17 refuses MCP send before the relayer is contacted, so this stays on the interactive CLI.
    for (const mode of ['expiry-zero', 'huge-gas'] as const) {
        const { server, result } = await runSend(mode)
        const output = `${result.stdout}\n${result.stderr}\n${server.methods.join(',')}`
        expect(server.submitted(), output).toBe(false)
        expect(server.signed(), output).toBe(false)
        expect(output).toMatch(/expiry|combined gas|Refusing/)
    }
}, 120_000)

test('MCP send is refused before the relayer is contacted', async () => {
    await locked(async () => {
        await withServer('honest-send', 8545, 31337, LOCAL_ORCH, LOCAL_PROXY, async (server, url) => {
                const child: ChildProcessWithoutNullStreams = spawn('bun', ['src/cli.ts', '--mcp'], {
                    cwd: walletDir,
                    env: {
                        ...process.env,
                        HOME: mkdtempSync(join(tmpdir(), 'tw-mcp-home-')),
                        TW_PASSWORD: PASSWORD,
                        PATH: `/tmp/node22/bin:${process.env.HOME}/.bun/bin:${process.env.PATH ?? ''}`,
                        ...devEnv(url),
                    },
                    stdio: ['pipe', 'pipe', 'pipe'],
                })

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

                const replied = new Promise<void>((resolvePromise, reject) => {
                    const timer = setTimeout(() => {
                        reject(new Error(`MCP send timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
                    }, 60_000)

                    child.stdout.on('data', () => {
                        if (!stdout.includes('"id":3') && !stdout.includes('"id": 3')) return
                        clearTimeout(timer)
                        resolvePromise()
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
                            clientInfo: { name: 'h5-test', version: '0.0.0' },
                        },
                    }),
                )
                child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
                child.stdin.write(
                    frame({
                        jsonrpc: '2.0',
                        id: 3,
                        method: 'tools/call',
                        params: {
                            name: 'send',
                            arguments: {
                                amount: '1',
                                recipient: RECIPIENT,
                                env: 'dev',
                                chain: 'anvil',
                                keystorePath: profileCopy(),
                            },
                        },
                    }),
                )

                try {
                    await replied
                } finally {
                    child.kill('SIGTERM')
                }

                const output = `${stdout}\n${stderr}\n${server.methods.join(',')}`
                expect(output).toContain('HUMAN_CONFIRMATION_REQUIRED')
                expect(server.methods, output).toEqual([])
            })
    })
}, 120_000)
