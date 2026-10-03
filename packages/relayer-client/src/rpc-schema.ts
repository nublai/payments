/**
 * Shared RPC wire schema types sourced from the relayer package.
 *
 * This keeps relayer-client aligned with server-side JSON-RPC contracts.
 */

export type {
    ChainCapabilities as RpcChainCapabilities,
    GetCapabilitiesParams as RpcGetCapabilitiesParams,
    GetCapabilitiesResult as RpcGetCapabilitiesResult,
} from '@towns-labs/relayer/rpc/schema/getCapabilities'
export type {
    PrepareCallsContext as RpcPrepareCallsContext,
    PrepareCallsResult as RpcPrepareCallsResult,
} from '@towns-labs/relayer/rpc/schema/prepareCalls'
export type {
    SendPreparedCallsParams as RpcSendPreparedCallsParams,
    SendPreparedCallsResult as RpcSendPreparedCallsResult,
} from '@towns-labs/relayer/rpc/schema/sendPreparedCalls'
export type { GetCallsStatusResult as RpcGetCallsStatusResult } from '@towns-labs/relayer/rpc/schema/getCallsStatus'
export type {
    GetCallsHistoryParams as RpcGetCallsHistoryParams,
    GetCallsHistoryResult as RpcGetCallsHistoryResult,
} from '@towns-labs/relayer/rpc/schema/getCallsHistory'
export type {
    AuthorizedKeyResponse as RpcAuthorizedKeyResponse,
    GetKeysParams as RpcGetKeysParams,
    GetKeysResult as RpcGetKeysResult,
    PermissionResponse as RpcPermissionResponse,
    SpendPermissionResponse as RpcSpendPermissionResponse,
} from '@towns-labs/relayer/rpc/schema/getKeys'
export type {
    AuthorizeKey as RpcAuthorizeKey,
    CallPermission as RpcCallPermission,
    KeyType as RpcKeyType,
    Permission as RpcPermission,
    PrepareUpgradeResult as RpcPrepareUpgradeResult,
    SpendPeriod as RpcSpendPeriod,
    SpendPermission as RpcSpendPermission,
    UpgradeAccountContext as RpcUpgradeAccountContext,
    UpgradeAccountResult as RpcUpgradeAccountResult,
} from '@towns-labs/relayer/rpc/schema/upgradeAccount'
export type {
    ValidSignatureProof as RpcValidSignatureProof,
    VerifySignatureParams as RpcVerifySignatureParams,
    VerifySignatureResult as RpcVerifySignatureResult,
} from '@towns-labs/relayer/rpc/schema/verifySignature'
