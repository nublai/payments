#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { z } from 'zod'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

type BundleTelemetry = {
    bundleId?: string
    paymentEnabled?: boolean
    simulationGas?: string
    combinedGas?: string
    estimatedTxGas?: string
    actualGasUsed?: string
    simulationDelta?: string
    combinedDelta?: string
    txEstimateDelta?: string
}

type ParsedArgs = {
    file?: string
    paymentOnly: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
    const out: ParsedArgs = {
        paymentOnly: false,
    }

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]

        if (arg === '--file' || arg === '-f') {
            out.file = argv[i + 1]
            i += 1
            continue
        }

        if (arg === '--payment-only') {
            out.paymentOnly = true
            continue
        }

        if (arg === '--help' || arg === '-h') {
            printHelp()
            process.exit(0)
        }
    }

    return out
}

function printHelp(): void {
    console.log(`Telemetry summary for relayer bundle gas logs

Usage:
  bun run scripts/telemetry-summary.ts [--file <path>] [--payment-only]

Examples:
  bunx wrangler tail --env stage --format json | bun run scripts/telemetry-summary.ts
  bun run scripts/telemetry-summary.ts --file /path/to/wrangler-log.json
  bun run scripts/telemetry-summary.ts --payment-only
`)
}

function toBigInt(value: string | undefined): bigint | null {
    if (!value) return null

    try {
        return BigInt(value)
    } catch {
        return null
    }
}

function percentile(values: bigint[], p: number): bigint {
    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)

    return sorted[Math.min(rank, sorted.length - 1)]
}

const TelemetryRowSchema = z
    .object({
        msg: z.literal('bundle gas telemetry'),
        bundleId: z.string().optional().catch(undefined),
        paymentEnabled: z.boolean().optional().catch(undefined),
        simulationGas: z.string().optional().catch(undefined),
        combinedGas: z.string().optional().catch(undefined),
        estimatedTxGas: z.string().optional().catch(undefined),
        actualGasUsed: z.string().optional().catch(undefined),
        simulationDelta: z.string().optional().catch(undefined),
        combinedDelta: z.string().optional().catch(undefined),
        txEstimateDelta: z.string().optional().catch(undefined),
    })
    .passthrough()

function maybeParseJsonString(input: string): Json | null {
    const trimmed = input.trim()

    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return null
    }

    try {
        // SAFETY: a `{...}` JSON value is the Json union this script walks.
        return JSON.parse(trimmed) as Json
    } catch {
        return null
    }
}

function extractTelemetry(value: Json, out: BundleTelemetry[]): void {
    if (Array.isArray(value)) {
        for (const item of value) {
            extractTelemetry(item, out)
        }

        return
    }

    if (value !== null && Object.getPrototypeOf(value) === Object.prototype) {
        const row = TelemetryRowSchema.safeParse(value)

        if (row.success) {
            out.push({
                bundleId: row.data.bundleId,
                paymentEnabled: row.data.paymentEnabled,
                simulationGas: row.data.simulationGas,
                combinedGas: row.data.combinedGas,
                estimatedTxGas: row.data.estimatedTxGas,
                actualGasUsed: row.data.actualGasUsed,
                simulationDelta: row.data.simulationDelta,
                combinedDelta: row.data.combinedDelta,
                txEstimateDelta: row.data.txEstimateDelta,
            })
        }

        for (const child of Object.values(value)) {
            extractTelemetry(child, out)
        }

        return
    }

    const text = z.string().safeParse(value)

    if (text.success && text.data.includes('bundle gas telemetry')) {
        const parsed = maybeParseJsonString(text.data)

        if (parsed !== null) extractTelemetry(parsed, out)
    }
}

function summarizeBucket(label: string, rows: BundleTelemetry[]): void {
    if (rows.length === 0) {
        console.log(`\n[${label}] no rows`)

        return
    }

    const simulationDeltas: bigint[] = []

    for (const r of rows) {
        const v = toBigInt(r.simulationDelta)

        if (v !== null) simulationDeltas.push(v)
    }

    const combinedDeltas: bigint[] = []

    for (const r of rows) {
        const v = toBigInt(r.combinedDelta)

        if (v !== null) combinedDeltas.push(v)
    }

    const txEstimateDeltas: bigint[] = []

    for (const r of rows) {
        const v = toBigInt(r.txEstimateDelta)

        if (v !== null) txEstimateDeltas.push(v)
    }

    const actualGasUsed: bigint[] = []

    for (const r of rows) {
        const v = toBigInt(r.actualGasUsed)

        if (v !== null) actualGasUsed.push(v)
    }

    const line = (name: string, values: bigint[]): void => {
        if (values.length === 0) {
            console.log(`  ${name}: n/a`)

            return
        }

        const p50 = percentile(values, 50)
        const p95 = percentile(values, 95)
        const p99 = percentile(values, 99)
        const min = percentile(values, 0)
        const max = percentile(values, 100)

        console.log(
            `  ${name}: count=${values.length} min=${min} p50=${p50} p95=${p95} p99=${p99} max=${max}`,
        )
    }

    console.log(`\n[${label}] rows=${rows.length}`)
    line('actualGasUsed', actualGasUsed)
    line('simulationDelta', simulationDeltas)
    line('combinedDelta', combinedDeltas)
    line('txEstimateDelta', txEstimateDeltas)

    const sample = rows[rows.length - 1]
    console.log(
        `  latest: bundleId=${sample.bundleId ?? 'n/a'} simulationGas=${sample.simulationGas ?? 'n/a'} combinedGas=${sample.combinedGas ?? 'n/a'} estimatedTxGas=${sample.estimatedTxGas ?? 'n/a'} actualGasUsed=${sample.actualGasUsed ?? 'n/a'}`,
    )
}

async function readInput(file?: string): Promise<string> {
    if (file) {
        return readFileSync(file, 'utf8')
    }

    const chunks: string[] = []

    for await (const chunk of process.stdin) {
        chunks.push(String(chunk))
    }

    return chunks.join('')
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const raw = await readInput(args.file)

    if (!raw.trim()) {
        console.error('No input data. Pass --file or pipe wrangler tail output.')
        process.exit(1)
    }

    const rows: BundleTelemetry[] = []
    const lines = raw.split(/\r?\n/)

    for (const line of lines) {
        const trimmed = line.trim()

        if (!trimmed) continue

        let parsed: Json | null = null

        try {
            // SAFETY: each wrangler-tail / log line is a JSON value.
            parsed = JSON.parse(trimmed) as Json
        } catch {
            const jsonStart = trimmed.indexOf('{')

            if (jsonStart >= 0) {
                parsed = maybeParseJsonString(trimmed.slice(jsonStart))
            }
        }

        if (parsed) {
            extractTelemetry(parsed, rows)
        }
    }

    const filtered = args.paymentOnly ? rows.filter((r) => r.paymentEnabled === true) : rows

    console.log(
        `Found telemetry rows: ${filtered.length}${args.paymentOnly ? ' (payment only)' : ''}`,
    )
    summarizeBucket('all', filtered)
    summarizeBucket(
        'paymentEnabled=true',
        filtered.filter((r) => r.paymentEnabled === true),
    )
    summarizeBucket(
        'paymentEnabled=false',
        filtered.filter((r) => r.paymentEnabled === false),
    )

    const suggestionValues = filtered
        .filter((r) => r.paymentEnabled === true)
        .map((r) => toBigInt(r.simulationDelta))
        .filter((v): v is bigint => v !== null)

    if (suggestionValues.length > 0) {
        const p95 = percentile(suggestionValues, 95)
        const p99 = percentile(suggestionValues, 99)
        const margin = 10_000n
        console.log(
            `\nSuggested PAYMENT_GAS_BUFFER baseline: p95+margin=${p95 + margin} (p95=${p95}, p99=${p99}, margin=${margin})`,
        )
    }
}

await main()
