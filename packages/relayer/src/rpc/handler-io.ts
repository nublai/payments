import { getChainConfig, getChainIds } from '../config'
import { createRelayerPublicClient } from '../lib/viem-utils'
import { getFeeEstimate } from '../services/fees'
import { formatPriceForQuote, getUsdPrice } from '../services/price-oracle'
import { RelayerService, createIntentNonceProvider } from '../services/relayer'

import type { RpcContext, RpcHandlerDeps } from './types'

function defaultCreateRelayerService(
    ...args: Parameters<NonNullable<RpcHandlerDeps['createRelayerService']>>
): RelayerService {
    return new RelayerService(...args)
}

/** Resolve handler I/O, defaulting each field to the production implementation. */
export function rpcHandlerIo(ctx: RpcContext): Required<RpcHandlerDeps> {
    const deps = ctx.deps

    return {
        createRelayerPublicClient: deps?.createRelayerPublicClient ?? createRelayerPublicClient,
        getChainIds: deps?.getChainIds ?? getChainIds,
        getChainConfig: deps?.getChainConfig ?? getChainConfig,
        createRelayerService: deps?.createRelayerService ?? defaultCreateRelayerService,
        getFeeEstimate: deps?.getFeeEstimate ?? getFeeEstimate,
        getUsdPrice: deps?.getUsdPrice ?? getUsdPrice,
        formatPriceForQuote: deps?.formatPriceForQuote ?? formatPriceForQuote,
        createIntentNonceProvider: deps?.createIntentNonceProvider ?? createIntentNonceProvider,
    }
}
