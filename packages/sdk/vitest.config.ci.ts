import { defineConfig, mergeConfig } from 'vitest/config'
import { rootConfig } from '../../vitest.config.mjs'

export default mergeConfig(
    rootConfig,
    defineConfig({
        test: {
            environment: 'happy-dom',
            name: 'test:ci',
            include: ['./src/tests/multi_ne/**/*.test.ts'],
            hookTimeout: 120_000,
            testTimeout: 120_000,
            setupFiles: './vitest.setup.ts',
            env: {
                RIVER_ENV: 'local_dev',
                BASE_CHAIN_ID: '31337',
                RIVER_CHAIN_ID: '31338',
                RIVER_ADDRESSES_RIVER_REGISTRY: '0x0000000000000000000000000000000000000000',
                BASE_ADDRESSES_APP_REGISTRY: '0x0000000000000000000000000000000000000000',
                BASE_ADDRESSES_SPACE_FACTORY: '0x0000000000000000000000000000000000000000',
                BASE_ADDRESSES_SPACE_OWNER: '0xF331FeadCAf32fe659578252Cc585CF0E1E8b128',
                BASE_ADDRESSES_BASE_REGISTRY: '0x0d7eC5826626070b6a250C9878940D070128A265',
                BASE_ADDRESSES_SUBSCRIPTION_MODULE: '0x972b3315F7593Df1DaE2cADd9Bc5c295A5394637',
                BASE_ADDRESSES_SWAP_ROUTER: '0x45f6cC8a3B9455CdbA3396097fA717757Cf10973',
                BASE_ADDRESSES_RIVER_AIRDROP: '0x5390D20Feb3dd84a08FE3E6C60D382233FeD0da6',
                BASE_ADDRESSES_UTILS_TIERED_LOG_PRICING_V2:
                    '0xA1912EBC0E21986629D2f20BD7B04319F1991521',
                BASE_ADDRESSES_UTILS_TIERED_LOG_PRICING_V3:
                    '0x3abF7ab1d0Be23bE4334bA5D8Ac7Bd9388ec7517',
                BASE_ADDRESSES_UTILS_TOWNS: '0xC0A314797CE0F4e2AAc876d0dFe518A693E78AC4',
            },
        },
        resolve: {
            conditions: ['browser'],
            alias: {
                '@connectrpc/connect-node': '@connectrpc/connect-web',
            },
        },
    }),
)
