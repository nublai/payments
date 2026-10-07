/**
 * JSON-RPC Method Registry
 *
 * Central registry of all available JSON-RPC methods.
 * Each method is mapped to its handler function.
 */

import type { MethodRegistry } from '../types'
import type { Env } from '../../types/env'
import { handleHealth, handleLive, handleReady } from './health'
import { handleGetCapabilities } from './getCapabilities'
import { handlePrepareCalls } from './prepareCalls'
import { handleSendPreparedCalls } from './sendPreparedCalls'
import { handleGetCallsStatus } from './getCallsStatus'
import { handlePrepareUpgradeAccount } from './prepareUpgradeAccount'
import { handleUpgradeAccount } from './upgradeAccount'
import { handleIssueBindNonce } from './issueBindNonce'
import { handleBindAccount } from './bindAccount'
import { handleGetKeys } from './getKeys'
import { handleGetAssets } from './stubs'
import { handleGetCallsHistory } from './getCallsHistory'
import { handleVerifySignature } from './verifySignature'

/**
 * Create the method registry with all available methods
 *
 * @param _env - Cloudflare Worker environment (passed to ctx in dispatcher)
 */
export function createMethods(_env: Env): MethodRegistry {
    return {
        // Health methods
        wallet_health: handleHealth,
        wallet_live: handleLive,
        wallet_ready: handleReady,

        // Capabilities
        wallet_getCapabilities: handleGetCapabilities,

        // Calls methods
        wallet_prepareCalls: handlePrepareCalls,
        wallet_sendPreparedCalls: handleSendPreparedCalls,
        wallet_getCallsStatus: handleGetCallsStatus,

        // Keys methods
        wallet_getKeys: handleGetKeys,

        // Account methods
        wallet_prepareUpgradeAccount: handlePrepareUpgradeAccount,
        wallet_upgradeAccount: handleUpgradeAccount,
        wallet_issueBindNonce: handleIssueBindNonce,
        wallet_bindAccount: handleBindAccount,

        // Calls history
        wallet_getCallsHistory: handleGetCallsHistory,

        // Stub methods (not yet implemented - return METHOD_NOT_IMPLEMENTED error)
        wallet_getAssets: handleGetAssets,
        wallet_verifySignature: handleVerifySignature,
    }
}

/**
 * List of all available method names
 */
export const METHOD_NAMES = [
    // Health
    'wallet_health',
    'wallet_live',
    'wallet_ready',
    // Capabilities
    'wallet_getCapabilities',
    // Calls
    'wallet_prepareCalls',
    'wallet_sendPreparedCalls',
    'wallet_getCallsStatus',
    'wallet_getCallsHistory',
    // Keys & Assets
    'wallet_getKeys',
    'wallet_getAssets',
    // Account upgrade
    'wallet_prepareUpgradeAccount',
    'wallet_upgradeAccount',
    'wallet_issueBindNonce',
    'wallet_bindAccount',
    // Signature
    'wallet_verifySignature',
] as const

export type MethodName = (typeof METHOD_NAMES)[number]
