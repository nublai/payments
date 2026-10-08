/**
 * A stale paid upgrade must be replaced under the 500k hold. The sponsored
 * 1.5M cap must not apply, and the signed gas stays inside the reservation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

import { SignerDO } from '../../src/durable-objects/signer.do'
import type { Env } from '../../src/types/env'

const ACCOUNT = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)

const AUTH = JSON.stringify([
    {
        address: '0x3Be52867f8Dca2911f81076B37921c334dE29551',
        chainId: '8453',
        nonce: '0',
        r: `0x${'11'.repeat(32)}`,
        s: `0x${'22'.repeat(32)}`,
        yParity: 0,
    },
])

interface PendingRow {
    id: string
    tx_hash: string
    nonce: number
    status: string
    tx_to: string
    tx_data: Hex
    tx_value: string
    tx_authorization_list: string
    max_fee_per_gas: string
    max_priority_fee_per_gas: string
    replacement_attempts: number
    last_replacement_at: number
    paid_upgrade: number
    sent_at: number
    queued: number
}

function pendingRow(): PendingRow {
    return {
        id: 'paid-1',
        tx_hash: `0x${'aa'.repeat(32)}`,
        nonce: 4,
        status: 'pending',
        tx_to: '0x000000000000000000000000000000000000051F',
        tx_data: '0x1234',
        tx_value: '0',
        tx_authorization_list: AUTH,
        max_fee_per_gas: '1',
        max_priority_fee_per_gas: '1',
        replacement_attempts: 0,
        last_replacement_at: 0,
        paid_upgrade: 1,
        sent_at: Date.now() - 10 * 60 * 1000,
        queued: 1,
    }
}

describe('paid upgrade stale replacement', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('signs at most the 500k hold and keeps paidUpgrade', async () => {
        const row = pendingRow()
        const sent: Array<{ gas?: bigint }> = []
        const seen: Array<{ paidUpgrade?: boolean; gas?: bigint }> = []
        let estimate = 456_207n

        const signer = Object.create(SignerDO.prototype) as {
            sql: { exec: (query: string, ...args: unknown[]) => { toArray: () => PendingRow[] } }
            env: Env
            ctx: { id: { name: string } }
            ensureClients: (chainId: number) => {
                publicClient: {
                    estimateGas: () => Promise<bigint>
                    estimateFeesPerGas: () => Promise<{
                        maxFeePerGas: bigint
                        maxPriorityFeePerGas: bigint
                    }>
                }
                walletClient: {
                    sendTransaction: (tx: { gas?: bigint }) => Promise<Hex>
                }
                account: typeof ACCOUNT
            }
            tryReplaceStaleTransaction: (
                txId: string,
                chainId: number,
                signerName: string,
            ) => Promise<'replaced' | 'skipped' | 'abandoned'>
            applyCreateAccountCaps: (
                txParams: { paidUpgrade?: boolean; gas?: bigint },
                nonce: number,
                chainId: number,
                feeParams: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
            ) => Promise<{
                txParams: { paidUpgrade?: boolean; gas?: bigint }
                feeParams: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
            }>
        }

        signer.sql = {
            exec: (query: string, ...args: unknown[]) => {
                const text = query.replace(/\s+/g, ' ')

                if (text.includes("SET status = 'replacing'") && text.includes('RETURNING')) {
                    if (row.status !== 'pending') return { toArray: () => [] }
                    row.status = 'replacing'

                    return { toArray: () => [{ ...row }] }
                }

                if (text.includes('SET tx_hash')) {
                    row.tx_hash = String(args[0])
                    row.status = 'pending'
                    row.queued = 0
                    row.max_fee_per_gas = String(args[1])
                    row.max_priority_fee_per_gas = String(args[2])
                    row.replacement_attempts = Number(args[3])
                    row.last_replacement_at = Number(args[4])
                    row.sent_at = Number(args[5])

                    return { toArray: () => [] }
                }

                if (text.includes('SET queued')) return { toArray: () => [] }

                if (text.includes('SET status')) {
                    const status = text.includes("status = 'abandoned'")
                        ? 'abandoned'
                        : text.includes("status = 'pending'")
                          ? 'pending'
                          : String(args[0])

                    row.status = status

                    return { toArray: () => [] }
                }

                return { toArray: () => [] }
            },
        }
        signer.env = {
            MONITOR_QUEUE: { send: async () => {} },
            SIGNER_POOL: {
                idFromName: () => 'pool-8453',
                get: () => ({
                    fetch: async () => new Response(JSON.stringify({ allowed: true })),
                }),
            },
        } as unknown as Env
        signer.ctx = { id: { name: 'signer-8453-0' } }
        signer.ensureClients = () => ({
            publicClient: {
                estimateGas: async () => estimate,
                estimateFeesPerGas: async () => ({
                    maxFeePerGas: 1_000_000_000n,
                    maxPriorityFeePerGas: 1_000_000_000n,
                }),
            },
            walletClient: {
                sendTransaction: async (tx: { gas?: bigint }) => {
                    sent.push(tx)

                    return `0x${'bb'.repeat(32)}` as Hex
                },
            },
            account: ACCOUNT,
        })
        const originalCaps = signer.applyCreateAccountCaps.bind(signer)
        signer.applyCreateAccountCaps = async (txParams, nonce, chainId, feeParams) => {
            seen.push(txParams)

            return originalCaps(txParams, nonce, chainId, feeParams)
        }

        const replaced = await signer.tryReplaceStaleTransaction('paid-1', 8453, 'signer-8453-0')
        expect(replaced).toBe('replaced')
        expect(seen[0]?.paidUpgrade).toBe(true)
        expect(sent).toHaveLength(1)
        expect(sent[0]?.gas).toBe(456_207n)
        expect(sent[0]?.gas ?? 0n).toBeLessThanOrEqual(500_000n)

        row.status = 'pending'
        row.replacement_attempts = 0
        row.last_replacement_at = 0
        row.max_fee_per_gas = '1'
        row.max_priority_fee_per_gas = '1'
        estimate = 809_224n
        const refused = await signer.tryReplaceStaleTransaction('paid-1', 8453, 'signer-8453-0')
        expect(refused).toBe('skipped')
        expect(seen[1]?.paidUpgrade).toBe(true)
        expect(sent).toHaveLength(1)
    })
})
