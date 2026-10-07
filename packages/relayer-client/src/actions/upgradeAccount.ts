/**
 * Upgrade an EOA to a delegated account via the relayer
 *
 * Uses the two-step JSON-RPC flow with two signatures:
 * 1. wallet_prepareUpgradeAccount - get auth + exec digests
 * 2. wallet_upgradeAccount - submit both signed digests
 */

import { getAddress, type Address, type Hex, type WalletClient, type Account } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { RelayerPublicClient, CreateAccountResponse } from '../types'
import { createRelayerTransport, JsonRpcClientError } from '../transport'
import { bindPreparedUpgrade } from '../helpers/bindPreparedUpgrade'
import { PreparedCallsBindingError } from '../helpers/bindPreparedCalls'
import type {
    RpcAuthorizeKey,
    RpcCallPermission,
    RpcKeyType,
    RpcPermission,
    RpcPrepareUpgradeResult,
    RpcSpendPeriod,
    RpcSpendPermission,
    RpcUpgradeAccountResult,
} from '../rpc-schema'

/** Base params for upgradeAccount */
interface UpgradeAccountBaseParams {
    /** The EOA address that will become a delegated account */
    accountAddress: Address
    /** Delegation target address (Account implementation) */
    delegation: Address
    /** Chain id from the caller. Never taken from the relayer payload. */
    chainId?: number
    /** Local orchestrator. Never taken from the relayer payload. */
    orchestrator?: Address
    /** Optional keys to authorize during upgrade */
    authorizeKeys?: AuthorizeKey[]
}

/** Params with private key signing */
export interface UpgradeAccountWithKeyParams extends UpgradeAccountBaseParams {
    /** Private key for signing (owner's key) */
    signerKey: Hex
    walletClient?: never
}

/** Params with WalletClient signing */
export interface UpgradeAccountWithWalletParams extends UpgradeAccountBaseParams {
    /** Wallet client for signing (must have account configured) */
    walletClient: WalletClient
    signerKey?: never
}

/** Combined params - provide either signerKey OR walletClient */
export type UpgradeAccountParams = UpgradeAccountWithKeyParams | UpgradeAccountWithWalletParams

/**
 * Key types supported for authorization
 *
 * Maps to Account.KeyType enum:
 * - Secp256k1 = 0: Standard Ethereum EOA keys
 * - External = 1: Delegated to an external ISigner contract
 * - P256 = 2: WebAuthn passkey (public key is 64-byte x||y)
 */
export type KeyType = RpcKeyType

/**
 * Spend period for spending limits
 */
export type SpendPeriod = RpcSpendPeriod

/**
 * Call permission
 */
export type CallPermission = RpcCallPermission

/**
 * Spend permission
 */
export type SpendPermission = RpcSpendPermission

/**
 * Permission types
 */
export type Permission = RpcPermission

/**
 * Key authorization request
 */
export type AuthorizeKey = RpcAuthorizeKey

const DELEGATION_CODE_PREFIX = '0xef0100'

function readOrchestratorAddress(chainId: number): Address {
    const raw = process.env[`ORCHESTRATOR_${chainId}`]?.trim()
    if (!raw) {
        throw new PreparedCallsBindingError(
            `Refusing to sign account upgrade: set ORCHESTRATOR_${chainId} or pass orchestrator`,
        )
    }
    return getAddress(raw)
}
const DEFAULT_DELEGATION_CONFIRMATION_TIMEOUT_MS = 15_000
const DEFAULT_DELEGATION_CONFIRMATION_INTERVAL_MS = 500

function normalizeTxHash(value: unknown): Hex | undefined {
    if (typeof value !== 'string') return undefined

    const withoutPrefix = value.startsWith('0x') ? value.slice(2) : value
    if (!/^[a-fA-F0-9]{64}$/.test(withoutPrefix)) return undefined

    return `0x${withoutPrefix}` as Hex
}

function isDelegationConfirmationRace(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.message.includes('Delegation not confirmed after transaction mined')
}

function getTxHashFromError(error: unknown): Hex | undefined {
    if (error instanceof JsonRpcClientError) {
        if (error.data && typeof error.data === 'object') {
            const maybeTxHash = (error.data as { txHash?: unknown }).txHash
            const normalizedTxHash = normalizeTxHash(maybeTxHash)
            if (normalizedTxHash) return normalizedTxHash
        }
    }

    if (!(error instanceof Error)) return undefined
    const match = error.message.match(/(?:0x)?[a-fA-F0-9]{64}/)
    return match ? normalizeTxHash(match[0]) : undefined
}

async function waitForDelegationCode(
    client: RelayerPublicClient,
    accountAddress: Address,
    timeoutMs = DEFAULT_DELEGATION_CONFIRMATION_TIMEOUT_MS,
    intervalMs = DEFAULT_DELEGATION_CONFIRMATION_INTERVAL_MS,
): Promise<boolean> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
        try {
            const code = await client.getCode({ address: accountAddress })
            if (code && code.startsWith(DELEGATION_CODE_PREFIX)) {
                return true
            }
        } catch {
            // Retry until timeout if RPC is temporarily inconsistent.
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    return false
}

/**
 * Upgrade an EOA to a delegated account via the relayer
 *
 * This uses the two-step JSON-RPC flow with two signatures:
 * 1. Calls wallet_prepareUpgradeAccount to get auth + exec digests
 * 2. Signs the auth digest (raw EIP-7702 authorization)
 * 3. Signs the exec digest (EIP-712 typed data for preCall)
 * 4. Calls wallet_upgradeAccount with both signatures
 *
 * You can provide either a `signerKey` (private key) or a `walletClient` for signing.
 *
 * @example
 * ```typescript
 * // With private key
 * const result = await client.upgradeAccount({
 *   accountAddress: account.address,
 *   signerKey: privateKey,
 *   delegation: '0x...AccountProxyAddress...',
 * })
 *
 * // With WalletClient (e.g., browser wallet)
 * const result = await client.upgradeAccount({
 *   accountAddress: walletClient.account.address,
 *   walletClient,
 *   delegation: '0x...AccountProxyAddress...',
 * })
 * ```
 */
export async function upgradeAccount(
    client: RelayerPublicClient,
    params: UpgradeAccountParams,
): Promise<CreateAccountResponse> {
    try {
        // Get the account for signing - either from private key or wallet client
        let account: Account
        let walletClientForTypedData: WalletClient | undefined

        if ('signerKey' in params && params.signerKey) {
            account = privateKeyToAccount(params.signerKey)
        } else if ('walletClient' in params && params.walletClient) {
            if (!params.walletClient.account) {
                throw new Error('WalletClient must have an account configured')
            }
            account = params.walletClient.account as Account
            walletClientForTypedData = params.walletClient
        } else {
            throw new Error('Must provide either signerKey or walletClient')
        }

        const transport = createRelayerTransport(client)
        const chainId = params.chainId ?? client.relayerConfig.chainId ?? client.chain?.id
        if (chainId === undefined) {
            throw new PreparedCallsBindingError(
                'Refusing to sign account upgrade: chainId is required',
            )
        }
        const orchestrator =
            params.orchestrator ?? readOrchestratorAddress(chainId)
        const authorizeKeys = params.authorizeKeys ?? []
        const authorizationNonce = await client.getTransactionCount({
            address: params.accountAddress,
            blockTag: 'pending',
        })

        // Step 1: Get authorization data from server
        const prepared = await transport.request<RpcPrepareUpgradeResult>(
            'wallet_prepareUpgradeAccount',
            {
                address: params.accountAddress,
                delegation: params.delegation,
                chainId: `0x${chainId.toString(16)}`,
                capabilities: {
                    authorizeKeys,
                },
            },
        )

        const bound = bindPreparedUpgrade(prepared, {
            accountAddress: params.accountAddress,
            chainId,
            delegation: params.delegation,
            orchestrator,
            authorizationNonce,
            authorizeKeys,
        })

        // Step 2: Sign the EIP-7702 authorization digest we recomputed.
        if (!('sign' in account) || typeof account.sign !== 'function') {
            throw new Error('Account must support sign method')
        }
        const authSignature = await account.sign({
            hash: bound.authDigest,
        })

        // Step 3: Sign the locally rebuilt SignedCall, not the relayer typed data.
        let execSignature: Hex
        if (bound.executionData !== '0x') {
            if (walletClientForTypedData) {
                execSignature = await walletClientForTypedData.signTypedData({
                    account,
                    domain: bound.typedData.domain,
                    types: bound.typedData.types,
                    primaryType: bound.typedData.primaryType,
                    message: bound.typedData.message,
                })
            } else {
                execSignature = await account.signTypedData({
                    domain: bound.typedData.domain,
                    types: bound.typedData.types,
                    primaryType: bound.typedData.primaryType,
                    message: bound.typedData.message,
                })
            }
        } else {
            execSignature = '0x'
        }

        // Step 4: Submit both signatures
        const result = await transport.request<RpcUpgradeAccountResult>('wallet_upgradeAccount', {
            context: prepared.context,
            signatures: {
                auth: authSignature,
                exec: execSignature,
            },
        })

        const txHash = normalizeTxHash(result.txHash)

        return {
            success: true,
            accountAddress: params.accountAddress,
            txHash,
        }
    } catch (error) {
        if (isDelegationConfirmationRace(error)) {
            const recovered = await waitForDelegationCode(client, params.accountAddress)
            if (recovered) {
                return {
                    success: true,
                    accountAddress: params.accountAddress,
                    txHash: getTxHashFromError(error),
                }
            }
        }

        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        }
    }
}
