import { vi } from 'vitest'

import type { Erc8128ChainClient } from '../../src/auth/erc8128/verify'
import type { RelayerChainClient } from '../../src/lib/viem-utils'
import type { RpcHandlerDeps } from '../../src/rpc/types'
import type { RelayerService } from '../../src/services/relayer'
import type { RelayerConfig } from '../../src/types/env'
import { silentLogger } from './logger'
import { testRelayerConfig } from './relayer'

export function stubRelayerChainClient(methods: {
    getCode?: RelayerChainClient['getCode']
    readContract?: RelayerChainClient['readContract']
    call?: RelayerChainClient['call']
}): RelayerChainClient {
    const getCode: RelayerChainClient['getCode'] =
        methods.getCode ?? (async () => undefined)

    const readContract: RelayerChainClient['readContract'] =
        methods.readContract ??
        (async () => {
            throw new Error('readContract not stubbed')
        })

    const call: RelayerChainClient['call'] =
        methods.call ?? (async () => ({ data: '0x' }))

    return { getCode, readContract, call }
}

export function stubErc8128ChainClient(methods: {
    getCode?: Erc8128ChainClient['getCode']
    readContract?: Erc8128ChainClient['readContract']
    verifyMessage?: Erc8128ChainClient['verifyMessage']
}): Erc8128ChainClient {
    const getCode: Erc8128ChainClient['getCode'] =
        methods.getCode ?? (async () => undefined)

    const readContract: Erc8128ChainClient['readContract'] =
        methods.readContract ??
        (async () => {
            throw new Error('readContract not stubbed')
        })

    const verifyMessage: Erc8128ChainClient['verifyMessage'] =
        methods.verifyMessage ?? (async () => false)

    return { getCode, readContract, verifyMessage }
}

export function mockedRelayerChainClient() {
    const client = stubRelayerChainClient({})

    return {
        client,
        mockGetCode: vi.spyOn(client, 'getCode'),
        mockReadContract: vi.spyOn(client, 'readContract'),
        mockCall: vi.spyOn(client, 'call'),
    }
}

export function mockedErc8128ChainClient() {
    const client = stubErc8128ChainClient({})

    return {
        client,
        mockGetCode: vi.spyOn(client, 'getCode'),
        mockReadContract: vi.spyOn(client, 'readContract'),
        mockVerifyMessage: vi.spyOn(client, 'verifyMessage'),
    }
}

export function stubPrepareRelayer(
    prepareIntent: RelayerService['prepareIntent'],
): NonNullable<RpcHandlerDeps['createRelayerService']> {
    return () => ({ prepareIntent })
}

export function fixedChainConfig(
    config: RelayerConfig = testRelayerConfig(),
): NonNullable<RpcHandlerDeps['getChainConfig']> {
    return () => config
}

export function stubUsdPrice(
    resolve: (assetUid: string) => bigint | null = () => 10n ** 18n,
): NonNullable<RpcHandlerDeps['getUsdPrice']> {
    return async (assetUid) => resolve(assetUid)
}

export { silentLogger }
