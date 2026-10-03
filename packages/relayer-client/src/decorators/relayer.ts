/**
 * Relayer actions decorator
 *
 * Adds all relayer actions as methods on a viem PublicClient.
 */

import type { PublicClient } from 'viem'
import type {
    RelayerClientConfig,
    RelayerPublicClient,
    HealthResponse,
    CapabilitiesResponse,
    BundleStatusResponse,
    CreateAccountResponse,
} from '../types'

import { checkHealth } from '../actions/checkHealth'
import { getCapabilities, type GetCapabilitiesParams } from '../actions/getCapabilities'
import {
    prepareCalls,
    type PrepareCallsParams,
    type PrepareCallsResponse,
} from '../actions/prepareCalls'
import {
    sendPreparedCalls,
    type SendPreparedCallsParams,
    type SendPreparedCallsResponse,
} from '../actions/sendPreparedCalls'
import { getCallsStatus, type GetCallsStatusParams } from '../actions/getCallsStatus'
import {
    getCallsHistory,
    type GetCallsHistoryParams,
    type GetCallsHistoryResponse,
} from '../actions/getCallsHistory'
import { upgradeAccount, type UpgradeAccountParams } from '../actions/upgradeAccount'
import { getKeys, type GetKeysParams, type GetKeysResponse } from '../actions/getKeys'
import {
    verifySignature,
    type VerifySignatureParams,
    type VerifySignatureResponse,
} from '../actions/verifySignature'

/**
 * Actions added by relayerActions decorator
 */
export type RelayerActions = {
    /** Relayer configuration (attached to client) */
    relayerConfig: RelayerClientConfig

    /** Check relayer health */
    checkHealth: () => Promise<HealthResponse>
    /** Get relayer capabilities */
    getCapabilities: (params?: GetCapabilitiesParams) => Promise<CapabilitiesResponse>
    /** Prepare calls for signing */
    prepareCalls: (params: PrepareCallsParams) => Promise<PrepareCallsResponse>
    /** Send prepared calls to the relayer */
    sendPreparedCalls: (params: SendPreparedCallsParams) => Promise<SendPreparedCallsResponse>
    /** Get calls status */
    getCallsStatus: (params: GetCallsStatusParams) => Promise<BundleStatusResponse>
    /** Get paginated history of call bundles for an EOA */
    getCallsHistory: (params: GetCallsHistoryParams) => Promise<GetCallsHistoryResponse>
    /** Upgrade an EOA to a delegated account (accepts signerKey or walletClient) */
    upgradeAccount: (params: UpgradeAccountParams) => Promise<CreateAccountResponse>
    /** Get authorized keys for a delegated account */
    getKeys: (params: GetKeysParams) => Promise<GetKeysResponse>
    /** Verify a signature for a delegated account */
    verifySignature: (params: VerifySignatureParams) => Promise<VerifySignatureResponse>
}

/**
 * Add all relayer actions to a viem PublicClient
 *
 * @example
 * ```typescript
 * import { createPublicClient, http } from 'viem'
 * import { baseSepolia } from 'viem/chains'
 * import { relayerActions, waitForBundle, wrapSignature } from '@towns-labs/relayer-client'
 *
 * const client = createPublicClient({
 *   chain: baseSepolia,
 *   transport: http('https://sepolia.base.org')
 * }).extend(relayerActions({
 *   relayerUrl: 'https://relayer.example.com'
 * }))
 *
 * // 1. Prepare
 * const prepared = await client.prepareCalls({
 *   from: accountAddress,
 *   calls: [{ target, value: 0n, data }]
 * })
 *
 * // 2. Sign (with viem)
 * const signature = await walletClient.signTypedData(prepared.typedData)
 *
 * // 3. Send
 * const { id } = await client.sendPreparedCalls({
 *   context: prepared.context,
 *   signature
 * })
 *
 * // 4. Wait for confirmation
 * const status = await waitForBundle(client, { id })
 * ```
 */
export function relayerActions(config: RelayerClientConfig) {
    return <TClient extends PublicClient>(client: TClient): RelayerActions => {
        // Attach config to client (viem pattern)
        const relayerClient = Object.assign(client, {
            relayerConfig: config,
        }) as RelayerPublicClient<TClient>

        return {
            relayerConfig: config,
            checkHealth: () => checkHealth(relayerClient),
            getCapabilities: (params) => getCapabilities(relayerClient, params),
            prepareCalls: (params) => prepareCalls(relayerClient, params),
            sendPreparedCalls: (params) => sendPreparedCalls(relayerClient, params),
            getCallsStatus: (params) => getCallsStatus(relayerClient, params),
            getCallsHistory: (params) => getCallsHistory(relayerClient, params),
            upgradeAccount: (params) => upgradeAccount(relayerClient, params),
            getKeys: (params) => getKeys(relayerClient, params),
            verifySignature: (params) => verifySignature(relayerClient, params),
        }
    }
}
