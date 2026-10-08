import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'
import net from 'node:net'

const LOCALHOST = '127.0.0.1'

const INPUT_CHAIN_PORT = 8545

const OUTPUT_CHAIN_PORT = 8546

function isPortOpen(port: number, host = LOCALHOST, timeoutMs = 150): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket()
        let settled = false

        const done = (result: boolean) => {
            if (settled) return
            settled = true
            socket.destroy()
            resolve(result)
        }

        socket.setTimeout(timeoutMs)
        socket.once('connect', () => done(true))
        socket.once('timeout', () => done(false))
        socket.once('error', () => done(false))
        socket.connect(port, host)
    })
}

export default defineWorkersConfig(async () => {
    const forceCrosschain = process.env.FORCE_CROSSCHAIN_TESTS === '1'

    const [isInputChainUp, isOutputChainUp] = await Promise.all([
        isPortOpen(INPUT_CHAIN_PORT),
        isPortOpen(OUTPUT_CHAIN_PORT),
    ])

    const shouldSkipCrosschain = !forceCrosschain && !(isInputChainUp && isOutputChainUp)

    if (shouldSkipCrosschain) {
        console.log(
            `[vitest] Skipping crosschain tests: expected local RPCs on ${LOCALHOST}:${INPUT_CHAIN_PORT} and ${LOCALHOST}:${OUTPUT_CHAIN_PORT}. Set FORCE_CROSSCHAIN_TESTS=1 to override.`,
        )
    }

    return {
        test: {
            // Force fully-serial execution to avoid local loopback port exhaustion
            // (EADDRNOTAVAIL) in Miniflare/workerd under high worker concurrency.
            fileParallelism: false,
            maxWorkers: 1,
            minWorkers: 1,
            poolOptions: {
                workers: {
                    singleWorker: true,
                    wrangler: { configPath: './wrangler.toml' },
                },
            },
            exclude: [
                'sdk/**',
                'node_modules/**',
                ...(shouldSkipCrosschain ? ['test/crosschain/**'] : []),
            ],
        },
    }
})
