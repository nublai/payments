import type { IntentNonceProvider } from '../../src/services/relayer'
import type { RelayerConfig } from '../../src/types/env'
import { silentLogger } from './logger'

const ZERO = '0x0000000000000000000000000000000000000000'

/** Complete RelayerConfig.contracts; override the fields a test actually reads. */
export function testContracts(
    overrides: Partial<RelayerConfig['contracts']> = {},
): RelayerConfig['contracts'] {

    return {
        orchestrator: '0x0000000000000000000000000000000000000011',
        simulator: '0x0000000000000000000000000000000000000022',
        account: ZERO,
        accountProxy: ZERO,
        simpleFunder: ZERO,
        simpleSettler: ZERO,
        escrow: ZERO,
        multiSigSigner: ZERO,
        ...overrides,
    }
}

/** RelayerConfig with dummy RPC/contracts. Override any field the test needs. */
export function testRelayerConfig(overrides: Partial<RelayerConfig> = {}): RelayerConfig {
    const { contracts, ...rest } = overrides

    return {
        chainId: 8453,
        rpcUrl: 'http://localhost:8545',
        contracts: testContracts(contracts),
        ...rest,
    }
}

export { silentLogger as testLogger }

/** IntentNonceProvider that only implements acquireOrGetDraft for prepare-intent tests. */
export function testIntentNonceProvider(
    acquireOrGetDraft: IntentNonceProvider['acquireOrGetDraft'],
): IntentNonceProvider {

    return {
        acquireOrGetDraft,
        markSubmitted: async () => 'not_found',
    }
}
