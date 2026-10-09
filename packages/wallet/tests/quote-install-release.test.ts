import { expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    createPublicClient,
    custom,
    decodeFunctionData,
    encodeFunctionResult,
    erc20Abi,
    isHex,
    toFunctionSelector,
    zeroAddress,
    type PublicClient,
} from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import { quoteSpendRecoverySuspended } from '../src/lib/quote-spend-guard'
import {
    installTrackedQuoteSpendLimit,
    maybeRecoverPendingQuoteSpend,
} from '../src/lib/quote-spend-lifecycle'
import {
    pendingQuoteLimitPath,
    type PendingQuoteLimitRecord,
} from '../src/lib/quote-spend-pending'
import { repeatedHex } from './helpers/hex'

const ACCOUNT = '0x1111111111111111111111111111111111111111'

const PUBLIC_KEY = '0x1234'

const KEY_HASH = repeatedHex('ab', 32)

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const APPROVE = '0x095ea7b3'

function chainClient(): PublicClient {
    return createPublicClient({
        transport: custom({
            async request(args) {
                if (args.method === 'eth_getBalance') {
                    return '0x0'
                }

                if (args.method === 'eth_chainId') {
                    return '0x2105'
                }

                if (args.method !== 'eth_call') {
                    throw new Error(`unexpected rpc ${args.method}`)
                }

                if (!Array.isArray(args.params)) {
                    throw new Error('unexpected rpc eth_call')
                }

                const first: unknown = args.params[0]
                const record = first === null || first === undefined ? {} : Object.assign({}, first)

                if (!('data' in record) || !isHex(record.data)) {
                    throw new Error('bad eth_call')
                }

                const data = record.data
                const selector = data.slice(0, 10)

                if (selector === toFunctionSelector('balanceOf(address)')) {
                    return encodeFunctionResult({
                        abi: erc20Abi,
                        functionName: 'balanceOf',
                        result: 0n,
                    })
                }

                const call = decodeFunctionData({ abi: accountAbi, data })

                if (call.functionName === 'spendInfos') {
                    return encodeFunctionResult({
                        abi: accountAbi,
                        functionName: 'spendInfos',
                        result: [],
                    })
                }

                if (call.functionName === 'canExecutePackedInfos') {
                    return encodeFunctionResult({
                        abi: accountAbi,
                        functionName: 'canExecutePackedInfos',
                        result: [],
                    })
                }

                if (call.functionName === 'getKey') {
                    return encodeFunctionResult({
                        abi: accountAbi,
                        functionName: 'getKey',
                        result: {
                            expiry: 0,
                            keyType: 0,
                            isSuperAdmin: false,
                            publicKey: PUBLIC_KEY,
                        },
                    })
                }

                throw new Error(`unexpected read ${call.functionName}`)
            },
        }),
    })
}

test('the release callback finishes an install inside withoutQuoteSpendRecovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quote-install-'))
    const keystorePath = join(dir, 'alice.json')
    await writeFile(keystorePath, '{}')
    const pendingPath = pendingQuoteLimitPath(keystorePath)
    const batches: ReturnType<typeof decodeFunctionData<typeof accountAbi>>[][] = []
    let recoveryTouched = false

    expect(quoteSpendRecoverySuspended()).toBe(false)

    const release = await installTrackedQuoteSpendLimit(
        {
            bound: {
                keyHash: KEY_HASH,
                account: ACCOUNT,
                nativeLimit: 0n,
                usdc: USDC,
                usdcLimit: 5n,
                frozenTokens: [] },
            network: {
                env: 'prod',
                relayerUrl: 'http://127.0.0.1:9',
                rpcUrl: 'http://127.0.0.1:9',
                chainId: 8453 },
            password: 'test',
            keystorePath,
            callGrants: [{ target: USDC, selector: APPROVE }] },
        {
            client: chainClient(),
            readMinuteLimits: async (record) => {
                const limits = new Map<string, bigint | null>()

                for (const slot of record.slots) {
                    limits.set(slot.token.toLowerCase(), BigInt(slot.installedLimit))
                }

                return limits
            },
            readQuoteKey: async (record: PendingQuoteLimitRecord) => {
                const expiry = record.keyExpiry

                if (!expiry?.permissions || !expiry.limits) {
                    throw new Error('install did not store the key snapshot')
                }

                return {
                    status: 'live' as const,
                    key: {
                        expiry: BigInt(expiry.installed),
                        keyType: expiry.keyType,
                        isSuperAdmin: expiry.isSuperAdmin,
                        publicKey: expiry.publicKey,
                        permissions: expiry.permissions,
                        limits: expiry.limits.map((limit) => ({
                            token: limit.token,
                            period: limit.period,
                            limit: BigInt(limit.limit) })) } }
            },
            submit: async (calls) => {
                expect(quoteSpendRecoverySuspended()).toBe(true)
                await readFile(pendingPath, 'utf8')
                await maybeRecoverPendingQuoteSpend(keystorePath, {
                    password: 'test',
                    readMinuteLimits: async () => {
                        recoveryTouched = true

                        return new Map()
                    },
                    submit: async () => {
                        recoveryTouched = true
                    } })
                batches.push(
                    calls.map((call) => decodeFunctionData({ abi: accountAbi, data: call.data })),
                )
            } },
    )

    expect(quoteSpendRecoverySuspended()).toBe(false)
    expect(recoveryTouched).toBe(false)
    const installCalls = batches[0] ?? []
    expect(installCalls.map((call) => call.functionName)).toEqual([
        'setSpendLimit',
        'setSpendLimit',
        'setCanExecute',
        'authorize',
    ])
    expect(installCalls[2]?.args?.[3]).toBe(true)
    const pending: PendingQuoteLimitRecord = JSON.parse(await readFile(pendingPath, 'utf8'))
    expect(pending.keyExpiry?.previous).toBe('0')
    const installedExpiry = BigInt(pending.keyExpiry?.installed ?? '0')
    expect(installedExpiry).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)))
    expect(installCalls[3]?.args?.[0]).toMatchObject({
        expiry: Number(installedExpiry),
        publicKey: PUBLIC_KEY })

    await release()

    expect(quoteSpendRecoverySuspended()).toBe(false)
    expect(recoveryTouched).toBe(false)
    const releaseCalls = batches[1] ?? []
    expect(releaseCalls.map((call) => call.functionName)).toEqual([
        'removeSpendLimit',
        'removeSpendLimit',
        'setCanExecute',
        'authorize',
    ])
    expect(releaseCalls[0]?.args?.[1]).toBe(zeroAddress)
    expect(releaseCalls[2]?.args?.[2]).toBe(APPROVE)
    expect(releaseCalls[2]?.args?.[3]).toBe(false)
    expect(releaseCalls[3]?.args?.[0]).toMatchObject({ expiry: 0, publicKey: PUBLIC_KEY })
    await expect(readFile(pendingPath, 'utf8')).rejects.toThrow()
})
