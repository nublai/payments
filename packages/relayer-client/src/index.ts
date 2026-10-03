/**
 * @agentic-payments/relayer-client
 *
 * Slim, Viem-style SDK for the EIP-7702 Relayer Orchestrator system.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createPublicClient, http } from 'viem'
 * import { baseSepolia } from 'viem/chains'
 * import { relayerActions, waitForBundle } from '@agentic-payments/relayer-client'
 *
 * // Create client with relayer actions
 * const client = createPublicClient({
 *   chain: baseSepolia,
 *   transport: http('https://sepolia.base.org')
 * }).extend(relayerActions({
 *   relayerUrl: 'https://relayer.example.com'
 * }))
 *
 * // 1. Prepare calls
 * const prepared = await client.prepareCalls({
 *   from: accountAddress,
 *   calls: [{ target, value: 0n, data }]
 * })
 *
 * // 2. Sign with viem
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

// Decorators
export { relayerActions, type RelayerActions } from './decorators'

// Actions (standalone functions)
export {
    // Health
    checkHealth,
    getCapabilities,
    // Calls lifecycle
    prepareCalls,
    sendPreparedCalls,
    getCallsStatus,
    getCallsHistory,
    // Account
    upgradeAccount,
    // Keys
    getKeys,
    // Signature verification
    verifySignature,
    // Polling helper (standalone utility)
    waitForBundle,
    // Types - Calls lifecycle
    type PrepareCallsParams,
    type PrepareCallsResponse,
    type PrepareCallsContext,
    type SendPreparedCallsParams,
    type SendPreparedCallsResponse,
    type GetCallsStatusParams,
    type GetCallsHistoryParams,
    type GetCallsHistoryResponse,
    type CallsHistoryItem,
    type WaitForBundleParams,
    // Types - Account
    type UpgradeAccountParams,
    type AuthorizeKey,
    type CallPermission,
    type SpendPermission,
    type Permission,
    type SpendPeriod,
    type KeyType,
    // Types - Keys
    type GetKeysParams,
    type GetKeysResponse,
    type AuthorizedKeyInfo,
    type PermissionInfo,
    type SpendPermissionInfo,
    type CallPermissionInfo,
    // Types - Signature verification
    type VerifySignatureParams,
    type VerifySignatureResponse,
    type SignatureProof,
} from './actions'

// JSON-RPC Transport
export {
    createJsonRpcTransport,
    createRelayerTransport,
    JsonRpcClientError,
    type JsonRpcTransport,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type JsonRpcError,
} from './transport'

// Utils - Signature wrapping
export { wrapSignature } from './utils'

// Utils - ERC-1271 digest transform
export {
    computeErc1271Digest,
    ERC1271_SIGN_TYPEHASH,
    DOMAIN_TYPEHASH_ONLY_VERIFYING_CONTRACT,
} from './utils'

// Utils - Key computation
export { computeKeyHash, encodeSecp256k1Key, type KeyType as KeyTypeUtil } from './utils'

// Utils - Error decoding
export { decodeIntentError, isKnownIntentError, INTENT_ERRORS, type IntentErrorName } from './utils'

// Utils - Constants
export {
    ANY_TARGET,
    EMPTY_CALLDATA_SELECTOR,
    ANY_FUNCTION_SELECTOR,
    ERC20_SELECTORS,
} from './utils'

// Utils - Serialization
export {
    bigIntReplacer,
    serializeCall,
    serializeIntent,
    serializeContext,
    deserializeContext,
    getChainIdFromContext,
    type SerializedCall,
    type SerializedIntent,
} from './utils'

// Utils - Account
export { isDelegatedAccount } from './utils'

// Types
export type {
    RelayerClientConfig,
    RelayerPublicClient,
    Keypair,
    AccountInfo,
    Call,
    Intent,
    SignedIntent,
    Transfer,
    SignedAuthorization,
    EIP712Domain,
    // Response types
    CreateAccountResponse,
    HealthResponse,
    CapabilitiesResponse,
    BundleStatusResponse,
} from './types'

export type { HttpAuthOptions } from './httpAuth'
export type { EthHttpSigner } from '@slicekit/erc8128'

// EIP-712 type definitions (for advanced use cases)
export { INTENT_TYPES, FUNDING_TYPES } from './types'

// Chain helpers
export { getChain, isKnownChain, getKnownChainIds } from './chains'

// Optional DX helpers
export {
    createRelayerClient,
    getChainKeys,
    findAuthorizedKey,
    signPreparedCalls,
    executePreparedCalls,
    type CreateRelayerClientParams,
    type CreatedRelayerClient,
    type SignPreparedCallsParams,
    type SignPreparedCallsResult,
    type SignPreparedCallsSigner,
    type TypedDataSignerInput,
    type DelegatedDigestSignerInput,
    type ExecutePreparedCallsParams,
    type ExecutePreparedCallsResult,
} from './helpers'

// Escrow
export {
    computeEscrowId,
    createEscrowCalls,
    getEscrowStatus,
    refundEscrowCalls,
    signSettlement,
    writeSettlementCalls,
    type CreateEscrowParams,
    type EscrowStatus,
} from './escrow/index.js'
