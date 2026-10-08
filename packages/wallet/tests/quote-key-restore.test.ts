import { expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData, type Address, type Hex } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import { restoreQuoteKeyExpiryCall } from '../src/lib/quote-key-expiry'
import { recoverPendingQuoteSpend } from '../src/lib/quote-spend-lifecycle'
import {
    pendingQuoteLimitPath,
    writePendingQuoteLimit,
    type PendingQuoteLimitRecord,
} from '../src/lib/quote-spend-pending'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address

const PUBLIC_KEY = '0x1234' as Hex

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

const APPROVE = '0x095ea7b3' as Hex

const TRANSFER = '0xa9059cbb' as Hex

const NOW = 1_700_000_000n

const INSTALLED = NOW + 7200n

const ROOT_SHORT = NOW + 30n

const THIRTY_DAYS = NOW + 30n * 24n * 60n * 60n

function snapshot(input: {
    expiry: bigint
    selector?: Hex
    limit?: bigint
}) {
    return {
        expiry: input.expiry,
        keyType: 0,
        isSuperAdmin: false,
        publicKey: PUBLIC_KEY,
        permissions: input.selector ? [{ target: USDC, selector: input.selector }] : [],
        limits: [{ token: USDC, period: 0, limit: input.limit ?? 5n }],
    }
}

test('testRestoreOfNeverUndoesRootShorten', () => {
    const previous = { expiry: 0n, keyType: 0, isSuperAdmin: false, publicKey: PUBLIC_KEY }
    const installed = snapshot({ expiry: INSTALLED, selector: APPROVE })
    const live = snapshot({ expiry: ROOT_SHORT, selector: APPROVE })
    const differences: string[] = []

    const calls = restoreQuoteKeyExpiryCall({
        account: ACCOUNT,
        previous,
        keyStillExists: true,
        installed,
        live,
        differences,
    })

    expect(calls).toEqual([])
    expect(differences.join('; ')).toContain(`expiry: expected ${INSTALLED}, found ${ROOT_SHORT}`)
})

test('testRestoreWritesStaleExpiryOverRootShorten', () => {
    const previous = {
        expiry: THIRTY_DAYS,
        keyType: 0,
        isSuperAdmin: false,
        publicKey: PUBLIC_KEY,
    }

    const installed = snapshot({ expiry: INSTALLED, selector: APPROVE })
    const live = snapshot({ expiry: ROOT_SHORT, selector: APPROVE })
    const differences: string[] = []

    const calls = restoreQuoteKeyExpiryCall({
        account: ACCOUNT,
        previous,
        keyStillExists: true,
        installed,
        live,
        differences,
    })

    expect(calls).toEqual([])
    expect(differences.join('; ')).toContain(`expiry: expected ${INSTALLED}, found ${ROOT_SHORT}`)
    expect(differences.join('; ')).not.toContain(`found ${THIRTY_DAYS}`)
})

test('testRestoreOntoReregisteredSameHashKeepsNewRights', () => {
    const previous = { expiry: 0n, keyType: 0, isSuperAdmin: false, publicKey: PUBLIC_KEY }
    const installed = snapshot({ expiry: INSTALLED, selector: APPROVE })
    const live = snapshot({ expiry: ROOT_SHORT, selector: TRANSFER })
    const differences: string[] = []

    const calls = restoreQuoteKeyExpiryCall({
        account: ACCOUNT,
        previous,
        keyStillExists: true,
        installed,
        live,
        differences,
    })

    expect(calls).toEqual([])
    const text = differences.join('; ')
    expect(text).toContain(`expiry: expected ${INSTALLED}, found ${ROOT_SHORT}`)
    expect(text).toContain('permissions:')
    expect(text).toContain(APPROVE)
    expect(text).toContain(TRANSFER)
})

test('testIntended_mismatchLeavesTheGrantAndIgnoresSpentPeriodStartAndCheckers', () => {
    const previous = { expiry: 0n, keyType: 0, isSuperAdmin: false, publicKey: PUBLIC_KEY }
    const installed = snapshot({ expiry: INSTALLED, selector: APPROVE, limit: 5n })

    const withRuntimeFields = (expiry: bigint) => {
        const key = snapshot({ expiry, selector: APPROVE, limit: 5n })

        return {
            ...key,
            limits: key.limits.map((limit) => ({
                ...limit,
                spent: 5n,
                currentSpent: 5n,
                lastUpdated: NOW,
                periodStart: NOW,
            })),
            checkers: [ACCOUNT],
        }
    }

    const ignored: string[] = []

    const restored = restoreQuoteKeyExpiryCall({
        account: ACCOUNT,
        previous,
        keyStillExists: true,
        installed,
        live: withRuntimeFields(INSTALLED),
        differences: ignored,
    })

    expect(ignored).toEqual([])
    expect(restored).toHaveLength(1)
    const restoredCall = decodeFunctionData({ abi: accountAbi, data: restored[0]!.data })
    expect(restoredCall.functionName).toBe('authorize')
    expect(restoredCall.args?.[0]).toMatchObject({ expiry: 0, publicKey: PUBLIC_KEY })

    const differences: string[] = []

    const calls = restoreQuoteKeyExpiryCall({
        account: ACCOUNT,
        previous,
        keyStillExists: true,
        installed,
        live: withRuntimeFields(ROOT_SHORT),
        differences,
    })

    expect(calls).toEqual([])
    expect(differences).toEqual([`expiry: expected ${INSTALLED}, found ${ROOT_SHORT}`])
})

test('a matching install snapshot still restores the previous expiry', () => {
    const previous = { expiry: 0n, keyType: 0, isSuperAdmin: false, publicKey: PUBLIC_KEY }
    const installed = snapshot({ expiry: INSTALLED, selector: APPROVE })

    const calls = restoreQuoteKeyExpiryCall({
        account: ACCOUNT,
        previous,
        keyStillExists: true,
        installed,
        live: installed,
    })

    expect(calls).toHaveLength(1)
    const decoded = decodeFunctionData({ abi: accountAbi, data: calls[0]!.data })
    expect(decoded.functionName).toBe('authorize')
    expect(decoded.args?.[0]).toMatchObject({ expiry: 0, publicKey: PUBLIC_KEY })
})

function pendingRecord(input: {
    previous: bigint
    permissions: { target: Address; selector: Hex }[]
    limit?: bigint
}): PendingQuoteLimitRecord {
    return {
        version: 1,
        account: ACCOUNT,
        keyHash: `0x${'ab'.repeat(32)}` as Hex,
        chainId: 8453,
        env: 'prod',
        rpcUrl: 'http://127.0.0.1:9',
        relayerUrl: 'http://127.0.0.1:9',
        slots: [{ token: USDC, previousLimit: null, installedLimit: (input.limit ?? 5n).toString() }],
        callGrants: [{ target: USDC, selector: APPROVE }],
        keyExpiry: {
            previous: input.previous.toString(),
            installed: INSTALLED.toString(),
            keyType: 0,
            isSuperAdmin: false,
            publicKey: PUBLIC_KEY,
            permissions: input.permissions,
            limits: [{ token: USDC, period: 0, limit: (input.limit ?? 5n).toString() }],
        },
    }
}

test('recovering a key that still matches the install restores the previous expiry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quote-match-'))
    const keystorePath = join(dir, 'alice.json')
    await writeFile(keystorePath, '{}')
    await writePendingQuoteLimit(
        keystorePath,
        pendingRecord({
            previous: 0n,
            permissions: [{ target: USDC, selector: APPROVE }],
        }),
    )
    const submitted: Hex[] = []
    await recoverPendingQuoteSpend(keystorePath, {
        readMinuteLimits: async () => new Map([[USDC.toLowerCase(), 5n]]),
        readQuoteKey: async () => ({
            status: 'live',
            key: snapshot({ expiry: INSTALLED, selector: APPROVE }),
        }),
        submit: async (_record, calls) => {
            submitted.push(...calls.map((call) => call.data))
        },
    })
    const decoded = submitted.map((data) => decodeFunctionData({ abi: accountAbi, data }))
    expect(decoded.map((call) => call.functionName)).toEqual([
        'removeSpendLimit',
        'setCanExecute',
        'authorize',
    ])
    expect(decoded[2]?.args?.[0]).toMatchObject({ expiry: 0, publicKey: PUBLIC_KEY })
    await expect(readFile(pendingQuoteLimitPath(keystorePath), 'utf8')).rejects.toThrow()
})

test('recovering after a root shorten leaves the key and reports the expiry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quote-shorten-'))
    const keystorePath = join(dir, 'alice.json')
    await writeFile(keystorePath, '{}')
    await writePendingQuoteLimit(
        keystorePath,
        pendingRecord({
            previous: 0n,
            permissions: [{ target: USDC, selector: APPROVE }],
        }),
    )
    const submitted: Hex[] = []
    await expect(
        recoverPendingQuoteSpend(keystorePath, {
            readMinuteLimits: async () => new Map([[USDC.toLowerCase(), 5n]]),
            readQuoteKey: async () => ({
                status: 'live',
                key: snapshot({ expiry: ROOT_SHORT, selector: APPROVE }),
            }),
            submit: async (_record, calls) => {
                submitted.push(...calls.map((call) => call.data))
            },
        }),
    ).rejects.toThrow(/left unchanged/)
    expect(submitted).toEqual([])
    await expect(readFile(pendingQuoteLimitPath(keystorePath), 'utf8')).rejects.toThrow()
})

test('recovering onto a re-registered key leaves the new permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quote-rereg-'))
    const keystorePath = join(dir, 'alice.json')
    await writeFile(keystorePath, '{}')
    await writePendingQuoteLimit(
        keystorePath,
        pendingRecord({
            previous: 0n,
            permissions: [{ target: USDC, selector: APPROVE }],
        }),
    )
    const submitted: Hex[] = []
    let message = ''

    try {
        await recoverPendingQuoteSpend(keystorePath, {
            readMinuteLimits: async () => new Map(),
            readQuoteKey: async () => ({
                status: 'live',
                key: snapshot({ expiry: ROOT_SHORT, selector: TRANSFER, limit: 0n }),
            }),
            submit: async (_record, calls) => {
                submitted.push(...calls.map((call) => call.data))
            },
        })
    } catch (error) {
        message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('left unchanged')
    expect(message).toContain('permissions:')
    expect(message).toContain(`expiry: expected ${INSTALLED}, found ${ROOT_SHORT}`)
    expect(submitted).toEqual([])
    await expect(readFile(pendingQuoteLimitPath(keystorePath), 'utf8')).rejects.toThrow()
})
