/**
 * Relayer SDK Actions
 *
 * All actions are standalone functions that take a RelayerClient as the first argument.
 * Use the relayerActions decorator to add them as methods to the client.
 */

// Health & Capabilities
export { checkHealth } from './checkHealth'
export { getCapabilities } from './getCapabilities'

// Calls lifecycle
export {
    prepareCalls,
    type PrepareCallsParams,
    type PrepareCallsResponse,
    type PrepareCallsContext,
} from './prepareCalls'
export {
    sendPreparedCalls,
    type SendPreparedCallsParams,
    type SendPreparedCallsResponse,
} from './sendPreparedCalls'
export { getCallsStatus, type GetCallsStatusParams } from './getCallsStatus'
export {
    getCallsHistory,
    type GetCallsHistoryParams,
    type GetCallsHistoryResponse,
    type CallsHistoryItem,
} from './getCallsHistory'

// Account
export {
    upgradeAccount,
    type UpgradeAccountParams,
    type AuthorizeKey,
    type CallPermission,
    type SpendPermission,
    type Permission,
    type SpendPeriod,
    type KeyType,
} from './upgradeAccount'

// Keys
export {
    getKeys,
    type GetKeysParams,
    type GetKeysResponse,
    type AuthorizedKeyInfo,
    type PermissionInfo,
    type SpendPermissionInfo,
    type CallPermissionInfo,
} from './getKeys'

// Signature verification
export {
    verifySignature,
    type VerifySignatureParams,
    type VerifySignatureResponse,
    type SignatureProof,
} from './verifySignature'

// Polling helper (standalone utility)
export { waitForBundle, type WaitForBundleParams } from './waitForBundle'
