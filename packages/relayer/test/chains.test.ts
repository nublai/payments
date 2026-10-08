import { describe, it, expect } from 'vitest'
import { zeroAddress } from 'viem'
import {
    loadChainsConfig,
    getChainConfig,
    getRpcUrl,
    getSupportedChainIds,
} from '../src/config/chains'

describe('chains config', () => {
    describe('loadChainsConfig', () => {
        it('loads and validates chains.json', () => {
            const config = loadChainsConfig()
            expect(config.version).toBe('1.0.0')
            expect(config.chains).toBeDefined()
            expect(Object.keys(config.chains).length).toBeGreaterThan(0)
        })

        it('returns cached config on subsequent calls', () => {
            const config1 = loadChainsConfig()
            const config2 = loadChainsConfig()
            expect(config1).toBe(config2)
        })
    })

    describe('getChainConfig', () => {
        it('returns config for Base Sepolia (84532)', () => {
            const config = getChainConfig(84532)
            expect(config).toBeDefined()
            expect(config!.name).toBe('base-sepolia')
            expect(config!.isTestnet).toBe(true)
            expect(config!.nativeCurrency.symbol).toBe('ETH')
        })

        it('returns config for Base Mainnet (8453)', () => {
            const config = getChainConfig(8453)
            expect(config).toBeDefined()
            expect(config!.name).toBe('base')
            expect(config!.isTestnet).toBe(false)
        })

        it('accepts chain ID as string', () => {
            const config = getChainConfig('84532')
            expect(config).toBeDefined()
            expect(config!.name).toBe('base-sepolia')
        })

        it('returns undefined for unknown chain', () => {
            const config = getChainConfig(999999)
            expect(config).toBeUndefined()
        })

        it('returns properly typed asset addresses', () => {
            const config = getChainConfig(84532)
            expect(config!.assets.eth.address).toBe(zeroAddress)
            expect(config!.assets.usdc.address).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
        })

        it('includes asset interop flags', () => {
            const config = getChainConfig(84532)
            expect(config!.assets.eth.interop).toBe(false)
            expect(config!.assets.usdc.interop).toBe(true)
        })
    })

    describe('getRpcUrl', () => {
        it('returns chain-specific RPC when set', () => {
            const env = {
                RPC_URL: 'https://default.rpc',
                RPC_84532: 'https://base-sepolia.rpc',
            }

            const rpc = getRpcUrl(env, 84532)
            expect(rpc).toBe('https://base-sepolia.rpc')
        })

        it('falls back to RPC_URL when chain-specific not set', () => {
            const env = {
                RPC_URL: 'https://default.rpc',
            }

            const rpc = getRpcUrl(env, 84532)
            expect(rpc).toBe('https://default.rpc')
        })

        it('returns undefined when no RPC configured', () => {
            const env = {}
            const rpc = getRpcUrl(env, 84532)
            expect(rpc).toBeUndefined()
        })

        it('accepts chain ID as string', () => {
            const env = {
                RPC_84532: 'https://base-sepolia.rpc',
            }

            const rpc = getRpcUrl(env, '84532')
            expect(rpc).toBe('https://base-sepolia.rpc')
        })
    })

    describe('getSupportedChainIds', () => {
        it('returns all chain IDs from config', () => {
            const chainIds = getSupportedChainIds()
            expect(chainIds).toContain(84532)
            expect(chainIds).toContain(8453)
        })
    })
})
