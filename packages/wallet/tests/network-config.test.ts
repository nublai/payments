import { expect, test } from 'bun:test'
import {
    ETH_ADDRESS,
    getUsdcTokenConfig,
    getEnvRelayerUrl,
    getTokenAddress,
    getTokenDecimals,
    getUsdcAddressByChainId,
    normalizeChainName,
    normalizeTokenSymbol,
    resolveNetworkConfig,
    selectDefaultChain,
} from '../src/lib/network-config'

test('resolveNetworkConfig returns chain defaults for prod/base and the relayer from RELAYER_URL_PROD', () => {
    const prodUrl = process.env.RELAYER_URL_PROD
    expect(prodUrl).toBeTruthy()
    const network = resolveNetworkConfig('prod', 'base')
    expect(network.relayerUrl).toBe(prodUrl)
    expect(network.rpcUrl).toBe('https://mainnet.base.org')
    expect(network.chainId).toBe(8453)
})

test('resolveNetworkConfig returns expected defaults for dev/anvil', () => {
    const network = resolveNetworkConfig('dev', 'anvil')
    expect(network.relayerUrl).toBe('http://127.0.0.1:8787')
    expect(network.rpcUrl).toBe('http://127.0.0.1:8545')
    expect(network.chainId).toBe(31337)
})

test('normalizeChainName supports aliases', () => {
    expect(normalizeChainName('base')).toBe('base')
    expect(normalizeChainName('polygon')).toBe('polygon')
    expect(normalizeChainName('matic')).toBe('polygon')
    expect(normalizeChainName('local')).toBe('anvil')
})

test('selectDefaultChain prefers anvil in dev and base otherwise', () => {
    expect(selectDefaultChain('prod', undefined)).toBe('base')
    expect(selectDefaultChain('stage', undefined)).toBe('base')
    expect(selectDefaultChain('dev', undefined)).toBe('anvil')
})

test('USDC mapping is centralized by chain id', () => {
    expect(getUsdcAddressByChainId(8453)).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
    expect(getUsdcAddressByChainId(137)).toBe('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359')
    expect(getUsdcAddressByChainId(137, true)).toBe('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174')
    expect(getUsdcAddressByChainId(31337)).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
})

test('polygon token config defaults to native and supports legacy override', () => {
    expect(getUsdcTokenConfig('polygon')).toEqual({
        symbol: 'USDC',
        address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    })
    expect(getUsdcTokenConfig('polygon', { legacy: true })).toEqual({
        symbol: 'USDC.e',
        address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    })
})

test('token helpers resolve ETH and USDC consistently', () => {
    expect(getTokenAddress('ETH', 'base')).toBe(ETH_ADDRESS)
    expect(getTokenAddress('USDC', 'polygon')).toBe('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359')
    expect(getTokenDecimals('ETH')).toBe(18)
    expect(getTokenDecimals('USDC')).toBe(6)
})

test('normalizeTokenSymbol is case insensitive for supported swap tokens', () => {
    expect(normalizeTokenSymbol('eth')).toBe('ETH')
    expect(normalizeTokenSymbol('UsDc')).toBe('USDC')
    expect(() => normalizeTokenSymbol('USDC.e')).toThrow('Unsupported token')
})

test('getEnvRelayerUrl reads prod and stage from env and keeps the local dev default', () => {
    expect(getEnvRelayerUrl('prod')).toBe(process.env.RELAYER_URL_PROD)
    expect(getEnvRelayerUrl('stage')).toBe(process.env.RELAYER_URL_STAGE)
    const previous = process.env.RELAYER_URL_DEV
    delete process.env.RELAYER_URL_DEV

    try {
        expect(getEnvRelayerUrl('dev')).toBe('http://127.0.0.1:8787')
        process.env.RELAYER_URL_DEV = 'http://127.0.0.1:9797'
        expect(getEnvRelayerUrl('dev')).toBe('http://127.0.0.1:9797')
    } finally {
        if (previous === undefined) delete process.env.RELAYER_URL_DEV
        else process.env.RELAYER_URL_DEV = previous
    }
})

test('getEnvRelayerUrl throws when prod or stage is unset', () => {
    const source = new URL('../src/lib/network-config.ts', import.meta.url).pathname

    const script = `
        const { getEnvRelayerUrl } = await import(${JSON.stringify(source)})
        for (const [env, key] of [['prod', 'RELAYER_URL_PROD'], ['stage', 'RELAYER_URL_STAGE']]) {
            let threw = false
            try { getEnvRelayerUrl(env) } catch (error) {
                threw = true
                if (!String(error && error.message).includes(key)) {
                    throw new Error('missing ' + key + ' in ' + error)
                }
            }
            if (!threw) throw new Error(env + ' did not throw')
        }
        process.env.RELAYER_URL_PROD = 'https://relayer.example/prod'
        process.env.RELAYER_URL_STAGE = 'https://relayer.example/stage'
        if (getEnvRelayerUrl('prod') !== 'https://relayer.example/prod') throw new Error('prod override')
        if (getEnvRelayerUrl('stage') !== 'https://relayer.example/stage') throw new Error('stage override')
        if (getEnvRelayerUrl('dev') !== 'http://127.0.0.1:8787') throw new Error('dev default')
    `

    const result = Bun.spawnSync({
        cmd: ['bun', '-e', script],
        env: {
            ...process.env,
            RELAYER_URL_PROD: '',
            RELAYER_URL_STAGE: '',
            RELAYER_URL_DEV: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
    })

    if (result.exitCode !== 0) {
        throw new Error(result.stderr.toString() || result.stdout.toString())
    }
})
