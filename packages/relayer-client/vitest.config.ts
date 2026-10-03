import { defineConfig } from 'vitest/config'
import { config } from 'dotenv'
import { resolve } from 'path'

// Load local deployment env vars for tests
config({ path: resolve(__dirname, '../contracts/deployments/envs/local/.env') })

// Set defaults for crosschain mode (can be overridden by env vars)
process.env.TEST_CHAIN_ID ??= '31337'
process.env.RPC_31337 ??= 'http://127.0.0.1:8545'
process.env.RPC_41337 ??= 'http://127.0.0.1:8546'

export default defineConfig({
    test: {
        // Shared settings
        pool: 'forks',
        poolOptions: {
            forks: {
                singleFork: true,
            },
        },
        fileParallelism: false,

        // Project definitions (replaces vitest.workspace.ts)
        projects: [
            {
                test: {
                    name: 'unit',
                    include: ['test/unit/**/*.test.ts'],
                },
            },
            {
                test: {
                    name: 'integration',
                    include: ['test/scenarios/**/*.test.ts'],
                    setupFiles: ['./test/setup.ts'],
                    testTimeout: 20_000,
                    hookTimeout: 30_000,
                },
            },
            {
                test: {
                    name: 'stress',
                    include: ['test/stress/**/*.test.ts'],
                    setupFiles: ['./test/setup.ts'],
                    testTimeout: 120_000, // 2 min for stress tests
                    hookTimeout: 30_000,
                },
            },
            {
                test: {
                    name: 'remote',
                    include: ['test/remote/**/*.test.ts'],
                    setupFiles: ['./test/remote/setup.ts'],
                    testTimeout: 60_000,
                    hookTimeout: 30_000,
                },
            },
        ],
    },
})
