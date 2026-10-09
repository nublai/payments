import { afterEach, expect, mock, test } from 'bun:test'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    encodeFunctionData,
    encodeFunctionResult,
    parseAbi,
    toFunctionSelector,
    zeroAddress,
    type Address,
    type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { accountAbi } from '@nubl/contracts/abis'
import { INTENT_TYPES, type GetKeysResponse } from '@nubl/relayer-client'
import { runSessionDaemon } from '../src/lib/session-daemon'
import { SessionDaemonClient } from '../src/lib/session-daemon-client'
import type { DaemonTypedData } from '../src/lib/session-daemon-protocol'
import { executePermissionsRevoke } from '../src/lib/permissions-revoke'
import { parseKeyHash } from '../src/lib/permissions-common'
import { executeSessionUnlock } from '../src/lib/session-unlock'
import { sessionOnChainRequiresPhrase } from '../src/lib/session-gates'
import { computeSessionKeyHash } from '../src/lib/session-common'
import { emptyHex, parseHex, repeatedHex } from './helpers/hex'
import { testKeystoreBundle } from './helpers/keystore-bundle'
import { parseJson } from './helpers/parse-json'

const TEST_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945388cf6f64f6b5f8a6d4f7e7a3fa8f8ff7f0' as const

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8'

const ESCROW = '0x05f9597eed844410b7c0746A1C584188d0644730'

const SPENDER = '0x9999999999999999999999999999999999999999'

const originalSocket = process.env.TW_AGENT_SOCK

afterEach(() => {
    if (originalSocket) process.env.TW_AGENT_SOCK = originalSocket
    else delete process.env.TW_AGENT_SOCK
})

function transfer(amount: bigint): Hex {
    return encodeFunctionData({
        abi: parseAbi(['function transfer(address to, uint256 amount)']),
        functionName: 'transfer',
        args: [SPENDER, amount],
    })
}

function orchestratorIntent(
    calls: { to: Address; value: bigint; data: Hex }[],
    paymentMaxAmount = 0n,
): DaemonTypedData {
    return {
        domain: {
            name: 'Orchestrator',
            version: '0.5.5',
            chainId: 31337,
            verifyingContract: ORCHESTRATOR,
        },
        types: INTENT_TYPES,
        primaryType: 'Intent' as const,
        message: {
            multichain: false,
            eoa: '0x1111111111111111111111111111111111111111',
            calls,
            nonce: 1n,
            payer: zeroAddress,
            paymentToken: paymentMaxAmount === 0n ? zeroAddress : USDC,
            paymentMaxAmount,
            combinedGas: 0n,
            encodedPreCalls: emptyHex(),
            encodedFundTransfers: emptyHex(),
            settler: zeroAddress,
            expiry: 0n,
        },
    }
}

function installAnvilDeployments(): () => void {
    const values: Record<string, string> = {
        ORCHESTRATOR_31337: ORCHESTRATOR,
        SIMPLE_FUNDER_31337: '0x0000000000000000000000000000000000000004',
        SIMULATOR_31337: '0x0000000000000000000000000000000000000005',
        ACCOUNT_31337: '0x0000000000000000000000000000000000000003',
        ACCOUNT_PROXY_31337: '0x1111111111111111111111111111111111111111',
        SIMPLE_SETTLER_31337: '0x5386d1026e1598177e03eA52cbF1a0994ADF5eaE',
        ESCROW_31337: ESCROW,
        MULTI_SIG_SIGNER_31337: '0x0000000000000000000000000000000000000008',
    }

    const previous: Record<string, string | undefined> = {}

    for (const [key, value] of Object.entries(values)) {
        previous[key] = process.env[key]
        process.env[key] = value
    }

    return () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

async function loadPhraseLess() {
    const restore = installAnvilDeployments()
    const dir = await mkdtemp(join(tmpdir(), 'tw-h3-daemon-'))
    process.env.TW_AGENT_SOCK = join(dir, 'session.sock')
    const daemon = await runSessionDaemon()
    const client = new SessionDaemonClient()
    const account = privateKeyToAccount(TEST_PRIVATE_KEY)

    const load = await client.loadKey({
        name: 'default',
        privateKey: TEST_PRIVATE_KEY,
        address: account.address,
        durationSeconds: 60,
        env: 'dev',
    })

    expect(load?.ok).toBe(true)

    return { daemon, client, restore }
}

test('a phrase-less session refuses non-Orchestrator typed data and signMessage', async () => {
    const { daemon, client, restore } = await loadPhraseLess()

    try {
        const other = await client.sign('default', {
            ...orchestratorIntent([]),
            domain: { name: 'session-daemon-test', version: '1', chainId: 8453, verifyingContract: ORCHESTRATOR },
        })

        expect(other?.ok).toBe(false)

        if (other && !other.ok) {
            expect(other.error.message).toContain('Orchestrator')
        }

        const message = await client.signMessage('default', '0x1234')
        expect(message?.ok).toBe(false)

        if (message && !message.ok) {
            expect(message.error.message).toContain('cannot sign messages')
        }
    } finally {
        await daemon.stop()
        restore()
    }
})

test('a phrase-less session refuses increaseAllowance, transferFrom, and an unknown target', async () => {
    const { daemon, client, restore } = await loadPhraseLess()

    try {
        const increase = encodeFunctionData({
            abi: parseAbi(['function increaseAllowance(address spender, uint256 addedValue)']),
            functionName: 'increaseAllowance',
            args: [SPENDER, 1_000_000_000n],
        })

        const from = encodeFunctionData({
            abi: parseAbi(['function transferFrom(address from, address to, uint256 amount)']),
            functionName: 'transferFrom',
            args: [SPENDER, SPENDER, 1_000_000_000n],
        })

        for (const data of [increase, from]) {
            const signed = await client.sign(
                'default',
                orchestratorIntent([{ to: USDC, value: 0n, data }]),
            )

            expect(signed?.ok).toBe(false)

            if (signed && !signed.ok) expect(signed.error.message).toContain('narrow')
        }

        const unknown = await client.sign(
            'default',
            orchestratorIntent([{ to: SPENDER, value: 0n, data: transfer(1n) }]),
        )

        expect(unknown?.ok).toBe(false)
    } finally {
        await daemon.stop()
        restore()
    }
})

test('a phrase-less session allows an in-budget USDC transfer and refuses a cumulative one past 10/day', async () => {
    const { daemon, client, restore } = await loadPhraseLess()
    const account = privateKeyToAccount(TEST_PRIVATE_KEY)

    try {
        const first = orchestratorIntent([{ to: USDC, value: 0n, data: transfer(6_000_000n) }])
        const signed = await client.sign('default', first)
        expect(signed?.ok).toBe(true)

        if (signed?.ok) {
            expect(signed.result).toBe(await account.signTypedData(first))
        }

        const second = await client.sign(
            'default',
            orchestratorIntent([{ to: USDC, value: 0n, data: transfer(6_000_000n) }]),
        )

        expect(second?.ok).toBe(false)

        if (second && !second.ok) expect(second.error.message).toContain('10 USDC')

        const escrowData = encodeFunctionData({
            abi: parseAbi([
                'function escrow((bytes12 salt, address depositor, address recipient, address token, uint256 escrowAmount, uint256 refundAmount, uint256 refundTimestamp, address settler, address sender, bytes32 settlementId, uint256 senderChainId)[] escrows)',
            ]),
            functionName: 'escrow',
            args: [
                [
                    {
                        salt: repeatedHex('ab', 12),
                        depositor: account.address,
                        recipient: SPENDER,
                        token: USDC,
                        escrowAmount: 1_000_000_000n,
                        refundAmount: 0n,
                        refundTimestamp: 0n,
                        settler: zeroAddress,
                        sender: zeroAddress,
                        settlementId: repeatedHex('00', 32),
                        senderChainId: 8453n,
                    },
                ],
            ],
        })

        const escrow = await client.sign(
            'default',
            orchestratorIntent([{ to: ESCROW, value: 0n, data: escrowData }]),
        )

        expect(escrow?.ok).toBe(false)
    } finally {
        await daemon.stop()
        restore()
    }
})

test('permissions revoke without the phrase refuses to drop the USDC spend rule', async () => {
    const decrypt = mock(async () => ({ rootPrivateKey: repeatedHex('11', 32) }))
    const keyHash = parseKeyHash(`0x${'aa'.repeat(32)}`)
    const account = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    await expect(
        executePermissionsRevoke(
            {
                env: 'dev',
                chain: 'anvil',
                keystorePath: '/tmp/revoke-phrase.json',
                keyHash,
                rule: `spend:${USDC}:day`,
                password: 'pw',
            },
            {
                withKeystoreLock: async (_path, action) => action(),
                readKeystoreBundle: mock(async () => testKeystoreBundle(account, account, 31337, 'dev')),
                listSessionNames: mock(async () => []),
                readSessionKeystoreFile: mock(async () =>
                    testKeystoreBundle(account, account, 31337, 'dev').session,
                ),
                getKeys: mock(async (): Promise<GetKeysResponse> => ({
                    '0x7a69': [
                        {
                            hash: keyHash,
                            expiry: '0x0',
                            type: 'secp256k1',
                            role: 'normal',
                            publicKey: '0x',
                            permissions: [
                                { type: 'call', to: USDC, selector: '0xa9059cbb' },
                                {
                                    type: 'spend',
                                    token: USDC,
                                    period: 'day',
                                    limit: '0x989680',
                                    spent: '0x0',
                                },
                            ],
                        },
                    ],
                })),
                readSessionChainGuard: mock(async () => ({
                    key: {
                        hash: keyHash,
                        expiry: '0',
                        permissions: [
                            { type: 'call', to: USDC, selector: '0xa9059cbb' },
                            { type: 'spend', token: USDC, period: 'day', limit: '10000000' },
                        ],
                    },
                    anyCalls: [],
                    checkerCount: 0,
                })),
                decryptRootKeystore: decrypt,
            },
        ),
    ).rejects.toThrow(/REVOKE FULL ACCESS SESSION/)
    expect(decrypt).not.toHaveBeenCalled()
})

const sessionAddress = privateKeyToAccount(TEST_PRIVATE_KEY).address

const sessionKeyHash = computeSessionKeyHash(sessionAddress)

function packCall(target: string, selector: string): Hex {
    const packed = (BigInt(target) << 96n) | BigInt(selector)

    return parseHex(`0x${packed.toString(16).padStart(64, '0')}`)
}

function installRpcRedirect(hosts: Record<string, string>): () => void {
    const original = globalThis.fetch

    const redirected = async (input: string | URL | Request, init?: RequestInit) => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

        const target = Object.entries(hosts).find(([host]) => url.includes(host))?.[1]

        if (!target) return original(input, init)

        const body =
            init?.body ??
            (typeof input !== 'string' && !(input instanceof URL) ? await input.clone().text() : undefined)

        return original(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
        })
    }

    globalThis.fetch = Object.assign(redirected, { preconnect: original.preconnect })

    return () => {
        globalThis.fetch = original
    }
}

async function serveChain(input: {
    chainId: number
    calls: { target: Address; selector: Hex }[]
    spends: { token: Address; period: number; limit: bigint }[]
    anyCalls?: { target: Address; selector: Hex }[]
    port?: number
}) {
    const getKeysSelector = toFunctionSelector('getKeys()')
    const spendSelector = toFunctionSelector('spendAndExecuteInfos(bytes32[])')
    const packedSelector = toFunctionSelector('canExecutePackedInfos(bytes32)')
    const checkerSelector = toFunctionSelector('callCheckerInfos(bytes32)')
    const anyKeyhash = `0x${'32'.repeat(32)}`

    const reply = (parsed: { id?: unknown; method?: string; params?: [{ data?: string }] }) => {
            const id = parsed.id ?? null
            const data = (parsed.params?.[0]?.data ?? '').toLowerCase()
            let result = '0x'

            if (parsed.method === 'eth_chainId') {
                result = `0x${input.chainId.toString(16)}`
            } else if (data.startsWith(getKeysSelector)) {
                result = encodeFunctionResult({
                    abi: accountAbi,
                    functionName: 'getKeys',
                    result: [
                        [
                            {
                                expiry: 0,
                                keyType: 0,
                                isSuperAdmin: false,
                                publicKey: '0x',
                            },
                        ],
                        [sessionKeyHash],
                    ],
                })
            } else if (data.startsWith(spendSelector)) {
                result = encodeFunctionResult({
                    abi: accountAbi,
                    functionName: 'spendAndExecuteInfos',
                    result: [
                        [
                            input.spends.map((spend) => ({
                                token: spend.token,
                                period: spend.period,
                                limit: spend.limit,
                                spent: 0n,
                                lastUpdated: 0n,
                                currentSpent: 0n,
                                current: 0n,
                            })),
                        ],
                        [input.calls.map((call) => packCall(call.target, call.selector))],
                    ],
                })
            } else if (data.startsWith(packedSelector)) {
                const hash = `0x${data.slice(10, 74)}`

                const packed =
                    hash === anyKeyhash
                        ? (input.anyCalls ?? []).map((call) => packCall(call.target, call.selector))
                        : []

                result = encodeFunctionResult({
                    abi: accountAbi,
                    functionName: 'canExecutePackedInfos',
                    result: packed,
                })
            } else if (data.startsWith(checkerSelector)) {
                result = encodeFunctionResult({
                    abi: accountAbi,
                    functionName: 'callCheckerInfos',
                    result: [],
                })
            }

            return { jsonrpc: '2.0', id, result }
    }

    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
            const parsed = parseJson<
                | { id?: unknown; method?: string; params?: [{ data?: string }] }
                | { id?: unknown; method?: string; params?: [{ data?: string }] }[]
            >(Buffer.concat(chunks).toString('utf8'))

            const payload = Array.isArray(parsed) ? parsed.map((message) => reply(message)) : reply(parsed)
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(payload))
        })
    })

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(input.port ?? 0, '127.0.0.1', () => resolve())
    })
    const address = server.address()

    if (!address || typeof address === 'string') throw new Error('stub failed to bind')

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve())
            }),
    }
}

test('a key that is narrow on base and wildcard on polygon requires the phrase', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'

    const base = await serveChain({
        chainId: 8453,
        calls: [{ target: USDC, selector: '0xa9059cbb' }],
        spends: [{ token: USDC, period: 2, limit: 10_000_000n }],
    })

    const polygonUsdc = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'

    const polygon = await serveChain({
        chainId: 137,
        calls: [
            {
                target: '0x3232323232323232323232323232323232323232',
                selector: '0x32323232',
            },
        ],
        spends: [{ token: polygonUsdc, period: 6, limit: 2n ** 256n - 1n }],
    })

    process.env.TW_TEST_RPC_base = base.url
    process.env.TW_TEST_RPC_polygon = polygon.url

    // 34c5cbc reads chainConfig.rpcUrl and ignores TW_TEST_RPC_*. Redirect those hosts
    // so the old gate still sees the stubs (narrow Base, wildcard Polygon).
    const restoreFetch = installRpcRedirect({
        'mainnet.base.org': base.url,
        'polygon.drpc.org': polygon.url,
    })

    try {
        const phrase = await sessionOnChainRequiresPhrase({
            env: 'prod',
            account: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            sessionAddress,
        })

        expect(phrase).toBe(true)
    } finally {
        restoreFetch()
        delete process.env.TW_TEST_RPC_base
        delete process.env.TW_TEST_RPC_polygon

        if (previousNodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousNodeEnv
        await base.close()
        await polygon.close()
    }
})

test('executeSessionUnlock uses sessionOnChainRequiresPhrase for an ANY_KEYHASH wildcard', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'

    const chain = await serveChain({
        chainId: 31337,
        port: 8545,
        calls: [{ target: USDC, selector: '0xa9059cbb' }],
        spends: [{ token: USDC, period: 2, limit: 10_000_000n }],
        anyCalls: [
            {
                target: '0x3232323232323232323232323232323232323232',
                selector: '0x32323232',
            },
        ],
    })

    process.env.TW_TEST_RPC_anvil = chain.url
    const decrypt = mock(async () => ({ sessionPrivateKey: TEST_PRIVATE_KEY }))

    const loadKey = mock(async () => ({
        ok: true as const,
        result: { name: 'default', address: sessionAddress, expiresAt: 1 },
    }))

    try {
        await expect(
            executeSessionUnlock(
                {
                    env: 'dev',
                    keystorePath: '/tmp/real-gate.json',
                    sessionName: 'default',
                    password: 'pw',
                },
                {
                    readKeystoreBundle: mock(async () => {
                        const bundle = testKeystoreBundle(
                            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                            sessionAddress,
                            31337,
                            'dev',
                        )

                        return {
                            ...bundle,
                            root: {
                                ...bundle.root,
                                addresses: {
                                    root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                                    delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                                },
                                sessionRef: { active: 'default', dir: 'sessions' },
                            },
                        }
                    }),
                    readSessionKeystoreFile: mock(async () => {
                        const session = testKeystoreBundle(
                            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                            sessionAddress,
                            31337,
                            'dev',
                        ).session

                        return {
                            ...session,
                            network: {
                                ...session.network,
                                rpcUrl: chain.url,
                                env: 'dev',
                                chainId: 31337,
                            },
                            addresses: {
                                session: sessionAddress,
                                delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                            },
                        }
                    }),
                    decryptSessionKeystore: decrypt,
                    createDaemonClient: () => ({ loadKey }),
                },
            ),
        ).rejects.toThrow(/UNLOCK FULL ACCESS SESSION/)
        expect(decrypt).not.toHaveBeenCalled()
        expect(loadKey).not.toHaveBeenCalled()
    } finally {
        delete process.env.TW_TEST_RPC_anvil

        if (previousNodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousNodeEnv
        await chain.close()
    }
})
