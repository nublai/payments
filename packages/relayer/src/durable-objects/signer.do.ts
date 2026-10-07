/**
 * SignerDO - Durable Object for individual signer management
 *
 * Each SignerDO instance represents a single HD-derived signer. It:
 * - Self-initializes on first request (no external bootstrap needed)
 * - Manages nonce atomically via SQLite transactions
 * - Tracks pending transactions for capacity management
 * - Monitors balance and auto-pauses when low
 * - Signs and broadcasts transactions
 *
 * DO naming convention: "signer-{chainId}-{derivationIndex}"
 * Example: "signer-31337-0" for the first signer on local chain
 */

import { DurableObject } from 'cloudflare:workers'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import {
    createPublicClient,
    createWalletClient,
    http,
    encodeFunctionData,
    encodeAbiParameters,
    bytesToHex,
    parseEther,
    zeroAddress,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
    type Chain,
    type SignedAuthorization,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { orchestratorAbi, simpleFunderAbi } from '@nubl/contracts/abis'
import { createChain } from '../lib/viem-utils'
import { getChainRpcUrl } from '../lib/multi-chain-client'
import { getErrorMessage } from '../lib/logger'
import { isPendingTransactionIdUniqueConstraintError } from '../lib/sqlite-errors'

import type { Env } from '../types/env'
import type {
    RelayTransaction,
    CapacityInfo,
    SendResult,
    SignerError,
    SignerErrorCode,
    MonitorJob,
    SignerMaintenanceResult,
    IntentStruct,
} from '../types/pool'
import { getContractAddresses } from '../config/addresses'
import { getPaymentRecipient } from '../services/fees'
import {
    assertAccountUpgradeFee,
    assertAccountUpgradeGas,
} from '../rpc/methods/shared/upgrade-gas'
import {
    mapStoredTxStatusToPublicStatus as mapStoredTxStatusToPublicStatusImpl,
    computeReplacementFees,
    shouldApplyFinalization,
    shouldAttemptReplacementNow,
    shouldTriggerReplacementByFee,
    resolveNonTriggeredReplacement,
    withCleanupOnError,
    withRecoveryOnError,
} from './signer-replacement-policy'

// Default configuration
const DEFAULT_MAX_PENDING = 16
const BALANCE_CHECK_INTERVAL_MS = 300_000 // 5 minutes
const STALE_TX_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_INTENT_EXPIRY_BUFFER_SECONDS = 30
const DUPLICATE_TX_WAIT_MS = 2_000
const DUPLICATE_TX_WAIT_POLL_MS = 100
const DEFAULT_REPLACEMENT_BUMP_BPS = 1250
const DEFAULT_REPLACEMENT_TRIGGER_WEI = 0n
const DEFAULT_REPLACEMENT_MAX_ATTEMPTS = 3
const DEFAULT_REPLACEMENT_BACKOFF_MS = 30_000

interface PreparedBroadcastTransaction {
    to: Address
    data: Hex
    value: bigint
    authorizationList?: SignedAuthorization[]
    gas?: bigint
}

interface FeeParams {
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
}

interface RawFallbackBroadcastRequest extends PreparedBroadcastTransaction {
    nonce: number
    account: PrivateKeyAccount
    chain: Chain
    gas: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
}

export function mapStoredTxStatusToPublicStatus(
    storedStatus: string,
): 'pending' | 'confirmed' | 'failed' {
    return mapStoredTxStatusToPublicStatusImpl(storedStatus)
}

/**
 * Check if intent has expired or will expire within buffer
 *
 * @param expiryTimestamp - Unix timestamp when intent expires
 * @param bufferSeconds - Buffer time before expiry to consider expired (default: 30)
 * @returns true if intent is expired or will expire within buffer
 */
export function isIntentExpired(
    expiryTimestamp: bigint | string,
    bufferSeconds: number = DEFAULT_INTENT_EXPIRY_BUFFER_SECONDS,
): boolean {
    const expiry = typeof expiryTimestamp === 'string' ? BigInt(expiryTimestamp) : expiryTimestamp
    const currentTime = BigInt(Math.floor(Date.now() / 1000))
    const buffer = BigInt(bufferSeconds)
    return currentTime + buffer >= expiry
}

export function isFillTransactionUnsupportedError(message: string): boolean {
    const lower = message.toLowerCase()
    const mentionsMethod = lower.includes('eth_filltransaction')
    if (!mentionsMethod) return false

    return (
        lower.includes('not available') ||
        lower.includes('does not exist') ||
        lower.includes('method not found')
    )
}

export function buildRawFallbackBroadcastRequest(input: {
    txParams: PreparedBroadcastTransaction
    nonce: number
    chainId: number
    account: PrivateKeyAccount
    gas: bigint
    feeParams: FeeParams
}): RawFallbackBroadcastRequest {
    return {
        ...input.txParams,
        nonce: input.nonce,
        account: input.account,
        chain: { id: input.chainId } as Chain,
        gas: input.gas,
        maxFeePerGas: input.feeParams.maxFeePerGas,
        maxPriorityFeePerGas: input.feeParams.maxPriorityFeePerGas,
    }
}

/**
 * SignerDO - Self-initializing signer with SQLite state
 */
export class SignerDO extends DurableObject<Env> {
    private sql: SqlStorage
    private publicClient: PublicClient | null = null
    private walletClient: WalletClient | null = null
    private account: PrivateKeyAccount | null = null
    // Fallback for local dev where ctx.id.name is undefined
    private signerNameOverride: string | null = null

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.sql = ctx.storage.sql
        this.migrateSchema()
    }

    /**
     * Get the signer name, using override if ctx.id.name is unavailable (local dev)
     */
    private getSignerName(): string | null {
        return this.ctx.id.name ?? this.signerNameOverride
    }

    /**
     * HTTP handler for SignerDO endpoints
     *
     * All requests should include ?signerName=signer-{chainId}-{index} query param
     * to support local development where ctx.id.name is undefined.
     */
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)

        // Extract signer name from query param (fallback for local dev where ctx.id.name is undefined)
        const signerNameParam = url.searchParams.get('signerName')
        if (signerNameParam) {
            this.signerNameOverride = signerNameParam
        }

        try {
            switch (url.pathname) {
                case '/capacity': {
                    const capacity = await this.getCapacity()
                    return Response.json(capacity)
                }

                case '/send': {
                    if (request.method !== 'POST') {
                        return new Response('Method not allowed', { status: 405 })
                    }
                    const tx = (await request.json()) as RelayTransaction
                    const result = await this.sendTransaction(tx)
                    return Response.json(result)
                }

                case '/finalized': {
                    if (request.method !== 'POST') {
                        return new Response('Method not allowed', { status: 405 })
                    }
                    const { txId, status, txHash } = (await request.json()) as {
                        txId: string
                        status: 'confirmed' | 'failed'
                        txHash?: string
                    }
                    await this.handleFinalized(txId, status, txHash)
                    return Response.json({ ok: true })
                }

                case '/maintenance': {
                    if (request.method !== 'POST') {
                        return new Response('Method not allowed', { status: 405 })
                    }
                    const result = await this.handleMaintenance()
                    return Response.json(result)
                }

                case '/status': {
                    const status = await this.getStatus()
                    return Response.json(status)
                }

                case '/get_tx_status': {
                    if (request.method !== 'GET') {
                        return new Response('Method not allowed', { status: 405 })
                    }
                    const txId = url.searchParams.get('txId')
                    if (!txId) {
                        return Response.json({ error: 'Missing txId parameter' }, { status: 400 })
                    }
                    const result = await this.getTxStatus(txId)
                    if (!result) {
                        return Response.json({ error: 'Transaction not found' }, { status: 404 })
                    }
                    return Response.json(result)
                }

                default:
                    return new Response('Not found', { status: 404 })
            }
        } catch (error) {
            const message = getErrorMessage(error)
            const code = error instanceof SignerDOError ? error.code : undefined
            const broadcastAttempted =
                error instanceof SignerDOError ? error.broadcastAttempted : false
            return Response.json({ error: message, code, broadcastAttempted }, {
                status: 500,
            })
        }
    }

    /**
     * SQLite schema migration
     */
    private migrateSchema(): void {
        // Create schema_version table if not exists
        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0);
    `)

        const versionRows = this.sql
            .exec('SELECT version FROM schema_version WHERE id = 1')
            .toArray()
        const currentVersion = (versionRows[0]?.version as number) ?? 0

        // Migration 1: Initial schema
        if (currentVersion < 1) {
            this.sql.exec(`
        CREATE TABLE IF NOT EXISTS signer_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          address TEXT NOT NULL,
          chain_id INTEGER NOT NULL,
          derivation_index INTEGER NOT NULL,
          nonce INTEGER NOT NULL DEFAULT 0,
          paused INTEGER NOT NULL DEFAULT 0,
          initialized INTEGER NOT NULL DEFAULT 0,
          balance_wei TEXT DEFAULT '0',
          last_balance_check INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS pending_transactions (
          id TEXT PRIMARY KEY,
          tx_hash TEXT NOT NULL,
          nonce INTEGER NOT NULL,
          sent_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_transactions(status);
        UPDATE schema_version SET version = 1 WHERE id = 1;
      `)
        }

        if (currentVersion < 2) {
            this.sql.exec(`
        ALTER TABLE pending_transactions ADD COLUMN queued INTEGER NOT NULL DEFAULT 1;
        UPDATE schema_version SET version = 2 WHERE id = 1;
      `)
        }

        if (currentVersion < 3) {
            this.sql.exec(`
        ALTER TABLE pending_transactions ADD COLUMN tx_to TEXT;
        ALTER TABLE pending_transactions ADD COLUMN tx_data TEXT;
        ALTER TABLE pending_transactions ADD COLUMN tx_value TEXT;
        ALTER TABLE pending_transactions ADD COLUMN tx_authorization_list TEXT;
        ALTER TABLE pending_transactions ADD COLUMN max_fee_per_gas TEXT;
        ALTER TABLE pending_transactions ADD COLUMN max_priority_fee_per_gas TEXT;
        ALTER TABLE pending_transactions ADD COLUMN replacement_attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE pending_transactions ADD COLUMN last_replacement_at INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_pending_replacement ON pending_transactions(status, sent_at);
        UPDATE schema_version SET version = 3 WHERE id = 1;
      `)
        }
    }

    /**
     * Self-initialize on first request
     * Extracts chain ID and derivation index from DO name
     */
    private async ensureInitialized(): Promise<void> {
        // Use toArray() instead of one() because the row may not exist yet
        const rows = this.sql.exec('SELECT initialized FROM signer_state WHERE id = 1').toArray()
        if (rows.length > 0 && rows[0].initialized) return

        // Extract derivation index from DO name (e.g., "signer-31337-0" -> 0)
        // Use getSignerName() to support local dev where ctx.id.name is undefined
        const name = this.getSignerName()
        if (!name) {
            throw new SignerDOError(
                'SignerDO must be created with idFromName() and include signerName query param for local dev',
                'NOT_INITIALIZED',
            )
        }

        const parts = name.split('-')
        if (parts.length !== 3 || parts[0] !== 'signer') {
            throw new SignerDOError(
                `Invalid DO name format: ${name}. Expected: signer-{chainId}-{index}`,
                'NOT_INITIALIZED',
            )
        }

        const chainId = parseInt(parts[1], 10)
        const derivationIndex = parseInt(parts[2], 10)

        if (isNaN(chainId) || isNaN(derivationIndex)) {
            throw new SignerDOError(
                `Invalid DO name: ${name}. Chain ID and index must be numbers`,
                'NOT_INITIALIZED',
            )
        }

        // Derive address from mnemonic
        const { address } = this.deriveKey(derivationIndex)

        // Fetch on-chain nonce
        const nonce = await this.fetchOnChainNonce(address, chainId)

        // Store initial state
        this.sql.exec(
            `
      INSERT OR REPLACE INTO signer_state
      (id, address, chain_id, derivation_index, nonce, paused, initialized, balance_wei, last_balance_check)
      VALUES (1, ?, ?, ?, ?, 0, 1, '0', 0)
    `,
            address,
            chainId,
            derivationIndex,
            nonce,
        )
    }

    /**
     * Derive key from mnemonic at given index
     * Key is derived on-demand and never persisted
     */
    private deriveKey(index: number): { address: Hex; privateKey: Hex } {
        const seed = mnemonicToSeedSync(this.env.RELAYER_MNEMONIC)
        const hdKey = HDKey.fromMasterSeed(seed)
        const path = `m/44'/60'/0'/0/${index}`
        const derived = hdKey.derive(path)

        if (!derived.privateKey) {
            throw new SignerDOError(`Failed to derive key at path ${path}`, 'NOT_INITIALIZED')
        }

        // Use viem's bytesToHex instead of Node.js Buffer (not available in Workers)
        const privateKey = bytesToHex(derived.privateKey)
        const account = privateKeyToAccount(privateKey)
        return { address: account.address, privateKey }
    }

    /**
     * Initialize viem clients lazily
     */
    private ensureClients(chainId: number): {
        publicClient: PublicClient
        walletClient: WalletClient
        account: PrivateKeyAccount
    } {
        if (this.publicClient && this.walletClient && this.account) {
            return {
                publicClient: this.publicClient,
                walletClient: this.walletClient,
                account: this.account,
            }
        }

        const rpcUrl = getChainRpcUrl(chainId, this.env)
        const chain = createChain(chainId, rpcUrl)

        // Get derivation index from state
        const stateRows = this.sql
            .exec('SELECT derivation_index FROM signer_state WHERE id = 1')
            .toArray()

        if (stateRows.length === 0) {
            throw new SignerDOError('Signer not initialized', 'NOT_INITIALIZED')
        }

        const derivationIndex = stateRows[0].derivation_index as number
        const { privateKey } = this.deriveKey(derivationIndex)

        this.account = privateKeyToAccount(privateKey)
        this.publicClient = createPublicClient({
            chain,
            transport: http(rpcUrl),
        })
        this.walletClient = createWalletClient({
            chain,
            transport: http(rpcUrl),
            account: this.account,
        })

        return {
            publicClient: this.publicClient,
            walletClient: this.walletClient,
            account: this.account,
        }
    }

    /**
     * Check if an error message indicates a nonce-related failure
     */
    private isNonceError(message: string): boolean {
        const noncePhrases = [
            'nonce too low',
            'nonce has already been used',
            'replacement transaction underpriced',
            'already known',
            'NONCE_EXPIRED',
        ]
        const lowerMessage = message.toLowerCase()
        return noncePhrases.some((phrase) => lowerMessage.includes(phrase.toLowerCase()))
    }

    /**
     * Ensure local nonce is never behind chain pending nonce.
     * This protects against external tx submissions or stale in-memory state.
     */
    private async syncNonceFloorFromChain(): Promise<number> {
        const stateRows = this.sql
            .exec('SELECT address, nonce, chain_id FROM signer_state WHERE id = 1')
            .toArray()
        if (stateRows.length === 0) {
            throw new SignerDOError('Signer not initialized', 'NOT_INITIALIZED')
        }

        const address = stateRows[0].address as string
        const chainId = stateRows[0].chain_id as number
        const chainPendingNonce = await this.fetchOnChainNonce(address, chainId)

        const floorResult = this.ctx.storage.transactionSync(
            (): { error: string } | { localNonce: number; nextNonce: number } => {
                const freshRows = this.sql
                    .exec('SELECT nonce FROM signer_state WHERE id = 1')
                    .toArray()
                if (freshRows.length === 0) {
                    return { error: 'Signer not initialized' }
                }

                const localNonce = freshRows[0].nonce as number
                const nextNonce = Math.max(localNonce, chainPendingNonce)

                if (nextNonce !== localNonce) {
                    this.sql.exec('UPDATE signer_state SET nonce = ? WHERE id = 1', nextNonce)
                }

                return { localNonce, nextNonce }
            },
        )

        if ('error' in floorResult) {
            throw new SignerDOError(floorResult.error, 'NOT_INITIALIZED')
        }

        if (floorResult.nextNonce !== floorResult.localNonce) {
            console.log(
                `[SignerDO] Raised nonce floor from ${floorResult.localNonce} to ${floorResult.nextNonce} for ${address}`,
            )
        }

        return floorResult.nextNonce
    }

    /**
     * Sync local nonce from chain and reconcile with any remaining pending tx nonces atomically.
     * When txIdToDelete is provided, that pending row is removed in the same transaction.
     */
    private async syncNonceFromChainAtomic(txIdToDelete?: string): Promise<number> {
        const stateRows = this.sql
            .exec('SELECT address, chain_id FROM signer_state WHERE id = 1')
            .toArray()
        if (stateRows.length === 0) {
            throw new SignerDOError('Signer not initialized', 'NOT_INITIALIZED')
        }

        const address = stateRows[0].address as string
        const chainId = stateRows[0].chain_id as number
        const onChainNonce = await this.fetchOnChainNonce(address, chainId)

        const syncedNonce = this.ctx.storage.transactionSync(() => {
            const txId = txIdToDelete
            if (txId !== undefined) {
                this.sql.exec('DELETE FROM pending_transactions WHERE id = ?', txId)
            }

            const pendingMaxRows = this.sql
                .exec(
                    "SELECT MAX(nonce) as max_nonce FROM pending_transactions WHERE status IN ('pending', 'replacing')",
                )
                .toArray()
            const pendingMax = pendingMaxRows[0]?.max_nonce as number | null | undefined
            const nextNonce = Math.max(onChainNonce, (pendingMax ?? -1) + 1)

            this.sql.exec('UPDATE signer_state SET nonce = ? WHERE id = 1', nextNonce)
            return nextNonce
        }) as number

        console.log(
            `[SignerDO] Synced nonce from chain: ${syncedNonce} for ${address} (chain pending: ${onChainNonce})`,
        )
        return syncedNonce
    }

    /**
     * Fetch on-chain nonce for an address
     */
    private async fetchOnChainNonce(address: string, _chainId: number): Promise<number> {
        const rpcUrl = getChainRpcUrl(_chainId, this.env)
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'eth_getTransactionCount',
                params: [address, 'pending'],
                id: 1,
            }),
        })

        const data = (await response.json()) as { result: string; error?: unknown }
        if (data.error) {
            throw new SignerDOError(
                `Failed to fetch nonce: ${JSON.stringify(data.error)}`,
                'NOT_INITIALIZED',
            )
        }

        return parseInt(data.result, 16)
    }

    /**
     * Parse balance value that can be in ETH (decimal) or wei (integer) format
     * Returns the value in wei as bigint
     */
    private parseBalance(value: string | undefined, defaultWei: bigint): bigint {
        if (!value) return defaultWei

        // If it contains a decimal point, treat as ETH and convert to wei
        if (value.includes('.')) {
            return parseEther(value)
        }

        // Otherwise treat as wei
        return BigInt(value)
    }

    /**
     * Fetch balance for an address
     */
    private async fetchBalance(address: string, chainId: number): Promise<bigint> {
        const rpcUrl = getChainRpcUrl(chainId, this.env)
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'eth_getBalance',
                params: [address, 'latest'],
                id: 1,
            }),
        })

        const data = (await response.json()) as { result: string; error?: unknown }
        if (data.error) {
            console.error('Failed to fetch balance:', data.error)
            return 0n
        }

        return BigInt(data.result)
    }

    /**
     * Get transaction receipt with full details
     */
    private async getTransactionReceipt(
        txHash: string,
        chainId: number,
    ): Promise<{
        status: string
        blockNumber?: string
        gasUsed?: string
        blockHash?: string
        logs?: unknown[]
    } | null> {
        const rpcUrl = getChainRpcUrl(chainId, this.env)
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'eth_getTransactionReceipt',
                params: [txHash],
                id: 1,
            }),
        })

        const data = (await response.json()) as {
            result: {
                status: string
                blockNumber?: string
                gasUsed?: string
                blockHash?: string
                logs?: unknown[]
            } | null
        }
        return data.result
    }

    /**
     * Get transaction status for BundleStatusDO
     * Returns transaction status with receipt data if confirmed
     */
    async getTxStatus(txId: string): Promise<{
        txId: string
        txHash: Hex
        chainId: number
        status: 'pending' | 'confirmed' | 'failed'
        blockNumber?: string
        gasUsed?: string
        blockHash?: string
        logs?: unknown[]
        submittedAt: number
        confirmedAt?: number
    } | null> {
        // Query pending_transactions table
        const rows = this.sql
            .exec('SELECT tx_hash, sent_at, status FROM pending_transactions WHERE id = ?', txId)
            .toArray()

        if (rows.length === 0) {
            return null
        }

        const row = rows[0]
        const txHash = row.tx_hash as string
        const sentAt = row.sent_at as number
        let status = row.status as string

        // Get chain ID from signer state
        const stateRows = this.sql.exec('SELECT chain_id FROM signer_state WHERE id = 1').toArray()
        const chainId = (stateRows[0]?.chain_id as number) ?? 0

        // Always check receipt to see if transaction has been confirmed (even if status is still pending)
        // This handles cases where the queue consumer hasn't updated status yet
        // With Anvil, transactions confirm immediately, so this check is critical
        try {
            const receipt = await this.getTransactionReceipt(txHash, chainId)
            if (receipt) {
                // Transaction is confirmed - update status in database if it's still pending
                if (status === 'pending' || status === 'replacing') {
                    const finalStatus = receipt.status === '0x1' ? 'confirmed' : 'failed'
                    this.sql.exec(
                        'UPDATE pending_transactions SET status = ? WHERE id = ?',
                        finalStatus,
                        txId,
                    )
                    status = finalStatus
                }

                // Return full receipt details
                return {
                    txId,
                    txHash: txHash as Hex,
                    chainId,
                    status: status === 'confirmed' ? 'confirmed' : 'failed',
                    blockNumber: receipt.blockNumber,
                    gasUsed: receipt.gasUsed,
                    blockHash: receipt.blockHash,
                    logs: receipt.logs || [],
                    submittedAt: sentAt,
                    confirmedAt: Date.now(), // Use current time as confirmation time
                }
            }
        } catch {
            // RPC error - for Anvil/local dev, this shouldn't happen often
            // But if it does, return current status rather than failing
            // In production, the queue consumer will eventually update status
        }

        const fallbackStatus = mapStoredTxStatusToPublicStatus(status)

        // No receipt found - return persisted terminal status when available.
        return {
            txId,
            txHash: txHash as Hex,
            chainId,
            status: fallbackStatus,
            submittedAt: sentAt,
        }
    }

    /**
     * Attempt to refill gas from SimpleFunder via pullGas
     *
     * Follows Ithaca's pattern:
     * 1. Pre-flight check: can we afford the pullGas tx?
     * 2. Execute pullGas if we can
     */
    private async attemptGasRefill(
        currentBalance: bigint,
        address: string,
        chainId: number,
    ): Promise<{ success: boolean; txHash?: Hex; amount?: bigint; reason?: string }> {
        const contracts = getContractAddresses(
            this.env as unknown as Record<string, string | undefined>,
            chainId,
        )
        if (!contracts.simpleFunder) {
            return { success: false, reason: 'SimpleFunder not configured' }
        }

        const { publicClient, walletClient, account } = this.ensureClients(chainId)

        // Calculate refill amount: target - current
        // TARGET_SIGNER_BALANCE is in ETH (e.g. "0.01"), parse to wei
        const targetBalance = parseEther(this.env.TARGET_SIGNER_BALANCE ?? '0.01')
        const refillAmount = targetBalance - currentBalance
        if (refillAmount <= 0n) {
            return { success: false, reason: 'Balance already at target' }
        }

        // Pre-flight: estimate gas cost for pullGas tx
        const pullGasData = encodeFunctionData({
            abi: simpleFunderAbi,
            functionName: 'pullGas',
            args: [refillAmount],
        })

        let gasEstimate: bigint
        let gasPrice: bigint
        try {
            ;[gasEstimate, gasPrice] = await Promise.all([
                publicClient.estimateGas({
                    account: address as Address,
                    to: contracts.simpleFunder,
                    data: pullGasData,
                }),
                publicClient.getGasPrice(),
            ])
        } catch (error) {
            const msg = getErrorMessage(error)
            return { success: false, reason: `Estimate failed: ${msg}` }
        }

        const txCost = gasEstimate * gasPrice
        if (currentBalance < txCost) {
            return { success: false, reason: 'Cannot afford pullGas tx' }
        }

        // Execute pullGas
        try {
            const txHash = await walletClient.writeContract({
                address: contracts.simpleFunder,
                abi: simpleFunderAbi,
                functionName: 'pullGas',
                args: [refillAmount],
                account,
                chain: { id: chainId } as Chain,
            })
            return { success: true, txHash, amount: refillAmount }
        } catch (error) {
            const msg = getErrorMessage(error)
            return { success: false, reason: `pullGas failed: ${msg}` }
        }
    }

    /**
     * Get capacity - also triggers self-init
     */
    async getCapacity(): Promise<CapacityInfo> {
        await this.ensureInitialized()

        const rows = this.sql
            .exec(
                `
      SELECT address, chain_id, paused, last_balance_check, balance_wei
      FROM signer_state WHERE id = 1
    `,
            )
            .toArray()

        if (rows.length === 0) {
            throw new SignerDOError(
                'Signer state not found after initialization',
                'NOT_INITIALIZED',
            )
        }

        const state = rows[0]
        const now = Date.now()
        const lastCheck = (state.last_balance_check as number) ?? 0
        let balanceWei = BigInt((state.balance_wei as string) ?? '0')

        // Refresh balance if stale
        if (now - lastCheck > BALANCE_CHECK_INTERVAL_MS) {
            const chainId = state.chain_id as number
            balanceWei = await this.fetchBalance(state.address as string, chainId)
            this.sql.exec(
                `
        UPDATE signer_state
        SET balance_wei = ?, last_balance_check = ?
        WHERE id = 1
      `,
                balanceWei.toString(),
                now,
            )
        }

        const minBalance = this.parseBalance(this.env.MIN_SIGNER_BALANCE, 10000000000000000n) // 0.01 ETH default
        const isPaused = !!state.paused || balanceWei < minBalance

        const pendingCount =
            (this.sql
                .exec(
                    "SELECT COUNT(*) as c FROM pending_transactions WHERE status IN ('pending', 'replacing')",
                )
                .toArray()[0]?.c as number) ?? 0

        const maxPending = parseInt(
            this.env.MAX_PENDING_PER_SIGNER ?? String(DEFAULT_MAX_PENDING),
            10,
        )
        const capacity = isPaused ? 0 : Math.max(0, maxPending - pendingCount)

        return {
            capacity,
            pending: pendingCount,
            address: state.address as Hex,
            balance: balanceWei.toString(),
            paused: isPaused,
        }
    }

    /**
     * Send a transaction
     * Uses SQLite transaction for atomic nonce allocation
     */
    async sendTransaction(tx: RelayTransaction): Promise<SendResult> {
        const broadcast = { attempted: false }
        try {
            return await this.performSend(tx, broadcast)
        } catch (error) {
            throw tagBroadcastAttempt(error, broadcast.attempted)
        }
    }

    private async performSend(
        tx: RelayTransaction,
        broadcast: { attempted: boolean },
    ): Promise<SendResult> {
        await this.ensureInitialized()

        // Keep local nonce floor in sync with chain pending nonce before reservation.
        await this.syncNonceFloorFromChain()

        const maxPending = parseInt(
            this.env.MAX_PENDING_PER_SIGNER ?? String(DEFAULT_MAX_PENDING),
            10,
        )

        // Atomic: check capacity, increment nonce, insert pending
        let result:
            | { nonce: number; address: string; chainId: number }
            | { error: string; code?: SignerErrorCode }
        try {
            result = this.ctx.storage.transactionSync(() => {
                // Check if paused
                const stateRows = this.sql
                    .exec('SELECT paused FROM signer_state WHERE id = 1')
                    .toArray()

                if (stateRows.length === 0) {
                    return {
                        error: 'Signer not initialized',
                        code: 'NOT_INITIALIZED' as SignerErrorCode,
                    }
                }

                if (stateRows[0].paused) {
                    return { error: 'Signer is paused', code: 'PAUSED' as SignerErrorCode }
                }

                // Check capacity
                const pending =
                    (this.sql
                        .exec(
                            "SELECT COUNT(*) as c FROM pending_transactions WHERE status IN ('pending', 'replacing')",
                        )
                        .toArray()[0]?.c as number) ?? 0

                if (pending >= maxPending) {
                    return {
                        error: 'Signer at capacity',
                        code: 'CAPACITY_EXCEEDED' as SignerErrorCode,
                    }
                }

                // Get and increment nonce atomically
                const updatedRows = this.sql
                    .exec(
                        'UPDATE signer_state SET nonce = nonce + 1 WHERE id = 1 RETURNING nonce - 1 as acquired_nonce, address, chain_id',
                    )
                    .toArray()

                if (updatedRows.length === 0) {
                    return {
                        error: 'Signer state not found',
                        code: 'NOT_INITIALIZED' as SignerErrorCode,
                    }
                }

                const acquiredNonce = updatedRows[0].acquired_nonce as number
                const address = updatedRows[0].address as string
                const chainId = updatedRows[0].chain_id as number

                // Insert pending transaction (tx_hash will be updated after broadcast)
                this.sql.exec(
                    `
          INSERT INTO pending_transactions (id, tx_hash, nonce, sent_at, status, queued)
          VALUES (?, '', ?, ?, 'pending', 0)
        `,
                    tx.id,
                    acquiredNonce,
                    Date.now(),
                )

                return { nonce: acquiredNonce, address, chainId }
            }) as
                | { nonce: number; address: string; chainId: number }
                | { error: string; code?: SignerErrorCode }
        } catch (error) {
            const message = getErrorMessage(error)
            if (isPendingTransactionIdUniqueConstraintError(message)) {
                return await this.resolveDuplicateTransactionId(tx.id)
            }
            throw error
        }

        if ('error' in result) {
            const errorResult = result as { error: string; code?: SignerErrorCode }
            throw new SignerDOError(errorResult.error, errorResult.code ?? 'BROADCAST_FAILED')
        }

        // Type assertion after error check - result is now the success case
        const successResult = result as { nonce: number; address: string; chainId: number }
        const { txParams, initialFeeParams } = await withCleanupOnError(
            async () => {
                const preparedTxParams = await this.buildTxParams(
                    tx,
                    successResult.chainId,
                    successResult.address as Address,
                )
                const recommendedFeeParams = await this.getRecommendedFeeParams(
                    successResult.chainId,
                )
                return {
                    txParams: preparedTxParams,
                    initialFeeParams: recommendedFeeParams,
                }
            },
            async () => {
                await this.syncNonceFromChainAtomic(tx.id)
            },
        )

        // Sign and broadcast outside transaction (network I/O)
        let txHash: Hex
        let usedFeeParams = initialFeeParams
        let usedNonce = successResult.nonce
        try {
            txHash = await this.signAndBroadcastPrepared(
                txParams,
                successResult.nonce,
                successResult.chainId,
                initialFeeParams,
                broadcast,
            )
        } catch (error) {
            const errorMessage = getErrorMessage(error)

            // Check if this is a nonce-related error
            if (this.isNonceError(errorMessage)) {
                console.log(
                    `[SignerDO] Nonce error detected: "${errorMessage}". Syncing from chain and retrying...`,
                )

                // Clean up failed pending row and sync nonce atomically with pending table state.
                const syncedNonce = await this.syncNonceFromChainAtomic(tx.id)

                // Re-acquire nonce and retry (only once)
                const retryNonce = this.ctx.storage.transactionSync(() => {
                    const updatedRows = this.sql
                        .exec(
                            'UPDATE signer_state SET nonce = nonce + 1 WHERE id = 1 RETURNING nonce - 1 as acquired_nonce',
                        )
                        .toArray()
                    const acquiredNonce = updatedRows[0].acquired_nonce as number

                    // Re-insert pending transaction with new nonce
                    this.sql.exec(
                        `INSERT INTO pending_transactions (id, tx_hash, nonce, sent_at, status, queued)
                         VALUES (?, '', ?, ?, 'pending', 0)`,
                        tx.id,
                        acquiredNonce,
                        Date.now(),
                    )

                    return acquiredNonce
                }) as number

                console.log(
                    `[SignerDO] Retrying with synced nonce: ${retryNonce} (synced base: ${syncedNonce})`,
                )

                // Retry broadcast with corrected nonce
                try {
                    const retryFeeParams = await this.getRecommendedFeeParams(successResult.chainId)
                    txHash = await this.signAndBroadcastPrepared(
                        txParams,
                        retryNonce,
                        successResult.chainId,
                        retryFeeParams,
                        broadcast,
                    )
                    usedFeeParams = retryFeeParams
                    usedNonce = retryNonce
                } catch (retryError) {
                    // Retry also failed - cleanup and sync atomically before bubbling error.
                    await this.syncNonceFromChainAtomic(tx.id)
                    throw retryError
                }
            } else {
                // Not a nonce error - cleanup and sync atomically before bubbling error.
                await this.syncNonceFromChainAtomic(tx.id)
                throw error
            }
        }

        // Update pending record with tx hash and replacement-critical metadata.
        this.sql.exec(
            `
          UPDATE pending_transactions
          SET tx_hash = ?, tx_to = ?, tx_data = ?, tx_value = ?, tx_authorization_list = ?,
              max_fee_per_gas = ?, max_priority_fee_per_gas = ?
          WHERE id = ?
        `,
            txHash,
            txParams.to,
            txParams.data,
            txParams.value.toString(),
            this.serializeAuthorizationList(txParams.authorizationList),
            usedFeeParams.maxFeePerGas.toString(),
            usedFeeParams.maxPriorityFeePerGas.toString(),
            tx.id,
        )

        // Enqueue for monitoring
        const signerName = this.getSignerName()
        if (!signerName) {
            throw new SignerDOError(
                'SignerDO must be created with idFromName() and include signerName query param for local dev',
                'NOT_INITIALIZED',
            )
        }
        await this.enqueueMonitorJob(tx.id, txHash, signerName, successResult.chainId)

        return {
            txHash,
            nonce: usedNonce,
            signer: successResult.address as Hex,
            signerName,
        }
    }

    private async resolveDuplicateTransactionId(txId: string): Promise<SendResult> {
        const signerName = this.getSignerName()
        if (!signerName) {
            throw new SignerDOError(
                'SignerDO must be created with idFromName() and include signerName query param for local dev',
                'NOT_INITIALIZED',
            )
        }

        const initialRow = this.sql
            .exec(
                `
          SELECT p.tx_hash, p.nonce, s.address
          FROM pending_transactions p
          JOIN signer_state s ON s.id = 1
          WHERE p.id = ?
        `,
                txId,
            )
            .toArray()[0]

        if (!initialRow) {
            throw new SignerDOError(
                'Duplicate transaction could not be recovered',
                'BROADCAST_FAILED',
            )
        }

        let txHash = initialRow.tx_hash as string
        if (!txHash) {
            txHash = await this.waitForTxHash(txId)
        }

        if (!txHash) {
            throw new SignerDOError(
                'Duplicate transaction is already in progress, retry shortly',
                'BROADCAST_FAILED',
            )
        }

        // Re-read after polling because nonce can change if the first path retried nonce.
        const finalRow = this.sql
            .exec(
                `
          SELECT p.tx_hash, p.nonce, s.address
          FROM pending_transactions p
          JOIN signer_state s ON s.id = 1
          WHERE p.id = ?
        `,
                txId,
            )
            .toArray()[0]
        const recoveredRow = finalRow ?? initialRow
        const recoveredTxHash = (recoveredRow.tx_hash as string) || txHash

        return {
            txHash: recoveredTxHash as Hex,
            nonce: recoveredRow.nonce as number,
            signer: recoveredRow.address as Hex,
            signerName,
        }
    }

    private async waitForTxHash(txId: string): Promise<string> {
        const deadline = Date.now() + DUPLICATE_TX_WAIT_MS
        while (Date.now() < deadline) {
            const row = this.sql
                .exec('SELECT tx_hash FROM pending_transactions WHERE id = ?', txId)
                .toArray()[0]
            const txHash = (row?.tx_hash as string | undefined) ?? ''
            if (txHash) {
                return txHash
            }
            await new Promise((resolve) => setTimeout(resolve, DUPLICATE_TX_WAIT_POLL_MS))
        }
        return ''
    }

    private async enqueueMonitorJob(
        txId: string,
        txHash: Hex,
        signerName: string,
        chainId: number,
    ): Promise<boolean> {
        try {
            await this.env.MONITOR_QUEUE.send({
                type: 'monitor',
                txId,
                txHash,
                signerName,
                chainId,
                attempt: 0,
            } satisfies MonitorJob)
            this.sql.exec('UPDATE pending_transactions SET queued = 1 WHERE id = ?', txId)
            return true
        } catch {
            this.sql.exec('UPDATE pending_transactions SET queued = 0 WHERE id = ?', txId)
            return false
        }
    }

    private parseOptionalBigInt(value: string | undefined): bigint | undefined {
        if (!value) return undefined
        const trimmed = value.trim()
        if (!trimmed) return undefined
        return BigInt(trimmed)
    }

    private serializeAuthorizationList(
        authorizationList: SignedAuthorization[] | undefined,
    ): string | null {
        if (!authorizationList || authorizationList.length === 0) return null
        return JSON.stringify(authorizationList, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
        )
    }

    private deserializeAuthorizationList(
        value: string | undefined,
    ): SignedAuthorization[] | undefined {
        if (!value) return undefined
        const parsed = JSON.parse(value) as Array<Record<string, unknown>>
        return parsed.map((item) => {
            const copy = { ...item }
            if (typeof copy.chainId === 'string') copy.chainId = BigInt(copy.chainId)
            if (typeof copy.nonce === 'string') copy.nonce = BigInt(copy.nonce)
            return copy as unknown as SignedAuthorization
        })
    }

    private getRecommendedFeeParams(chainId: number): Promise<FeeParams> {
        const { publicClient } = this.ensureClients(chainId)
        return publicClient.estimateFeesPerGas({
            type: 'eip1559',
            chain: publicClient.chain,
        }) as Promise<FeeParams>
    }

    private parseReplacementConfig(): {
        bumpBps: number
        triggerThresholdWei: bigint
        maxAttempts: number
        baseBackoffMs: number
        maxFeeCapWei?: bigint
    } {
        return {
            bumpBps: parseInt(
                this.env.REPLACEMENT_BUMP_BPS ?? String(DEFAULT_REPLACEMENT_BUMP_BPS),
                10,
            ),
            triggerThresholdWei:
                this.parseOptionalBigInt(this.env.REPLACEMENT_TRIGGER_THRESHOLD_WEI) ??
                DEFAULT_REPLACEMENT_TRIGGER_WEI,
            maxAttempts: parseInt(
                this.env.REPLACEMENT_MAX_ATTEMPTS ?? String(DEFAULT_REPLACEMENT_MAX_ATTEMPTS),
                10,
            ),
            baseBackoffMs: parseInt(
                this.env.REPLACEMENT_BACKOFF_BASE_MS ?? String(DEFAULT_REPLACEMENT_BACKOFF_MS),
                10,
            ),
            maxFeeCapWei: this.parseOptionalBigInt(this.env.REPLACEMENT_MAX_FEE_PER_GAS_WEI),
        }
    }

    private async buildTxParams(
        tx: RelayTransaction,
        chainId: number,
        signerAddress: Address,
    ): Promise<PreparedBroadcastTransaction> {
        const contracts = getContractAddresses(
            this.env as unknown as Record<string, string | undefined>,
            chainId,
        )

        switch (tx.type) {
            case 'create-account': {
                if (tx.preCall && tx.preCall.executionData !== '0x') {
                    const signedCall = {
                        eoa: tx.preCall.eoa,
                        executionData: tx.preCall.executionData as Hex,
                        nonce: BigInt(tx.preCall.nonce),
                        signature: tx.preCall.signature as Hex,
                    }

                    return {
                        to: contracts.orchestrator,
                        data: encodeFunctionData({
                            abi: orchestratorAbi,
                            functionName: 'executePreCalls',
                            args: [tx.accountAddress, [signedCall]],
                        }),
                        value: 0n,
                        authorizationList: [tx.authorization],
                    }
                }

                return {
                    to: tx.accountAddress,
                    data: '0x' as Hex,
                    value: 0n,
                    authorizationList: [tx.authorization],
                }
            }

            case 'execute-intent': {
                const bufferSeconds = parseInt(
                    this.env.INTENT_EXPIRY_BUFFER_SECONDS ??
                        String(DEFAULT_INTENT_EXPIRY_BUFFER_SECONDS),
                    10,
                )
                if (isIntentExpired(tx.intent.expiry, bufferSeconds)) {
                    throw new SignerDOError(
                        `Intent expired. Expiry: ${tx.intent.expiry}, Current: ${Math.floor(Date.now() / 1000)}`,
                        'INTENT_EXPIRED',
                    )
                }

                const intentWithRecipient = {
                    ...tx.intent,
                    paymentRecipient: getPaymentRecipient(this.env.FEE_RECIPIENT, signerAddress),
                }
                const encodedIntent = this.encodeIntentToBytes(intentWithRecipient)
                return {
                    to: contracts.orchestrator,
                    data: encodeFunctionData({
                        abi: orchestratorAbi,
                        functionName: 'execute',
                        args: [encodedIntent],
                    }),
                    value: 0n,
                }
            }

            case 'batch-execute-intent': {
                const batchBufferSeconds = parseInt(
                    this.env.INTENT_EXPIRY_BUFFER_SECONDS ??
                        String(DEFAULT_INTENT_EXPIRY_BUFFER_SECONDS),
                    10,
                )
                for (const intent of tx.intents) {
                    if (isIntentExpired(intent.expiry, batchBufferSeconds)) {
                        throw new SignerDOError(
                            `Intent expired. Expiry: ${intent.expiry}, Current: ${Math.floor(Date.now() / 1000)}`,
                            'INTENT_EXPIRED',
                        )
                    }
                }

                const intentsWithRecipient = tx.intents.map((intent) => ({
                    ...intent,
                    paymentRecipient: getPaymentRecipient(this.env.FEE_RECIPIENT, signerAddress),
                }))
                const encodedIntents = intentsWithRecipient.map((intent) =>
                    this.encodeIntentToBytes(intent),
                )
                return {
                    to: contracts.orchestrator,
                    data: encodeFunctionData({
                        abi: orchestratorAbi,
                        functionName: 'execute',
                        args: [encodedIntents],
                    }),
                    value: 0n,
                }
            }
        }
    }

    private async signAndBroadcastPrepared(
        txParams: PreparedBroadcastTransaction,
        nonce: number,
        chainId: number,
        feeParams: FeeParams,
        broadcast: { attempted: boolean } = { attempted: false },
    ): Promise<Hex> {
        const capped = await this.applyCreateAccountCaps(txParams, nonce, chainId, feeParams)
        broadcast.attempted = true
        const broadcastParams = capped.txParams
        const broadcastFees = capped.feeParams
        const { publicClient, walletClient, account } = this.ensureClients(chainId)
        try {
            return await this.sendWithPrimaryPath(
                broadcastParams,
                nonce,
                chainId,
                broadcastFees,
                walletClient,
                account,
            )
        } catch (error) {
            const primaryMessage = getErrorMessage(error)
            if (!isFillTransactionUnsupportedError(primaryMessage)) {
                throw new SignerDOError(
                    `Failed to broadcast transaction: ${primaryMessage}`,
                    'BROADCAST_FAILED',
                )
            }

            console.warn('[SignerDO] broadcast fallback activated', {
                reason: 'eth_filltransaction_unsupported',
                chainId,
            })

            try {
                const txHash = await this.sendWithRawFallback(
                    broadcastParams,
                    nonce,
                    chainId,
                    broadcastFees,
                    publicClient,
                    walletClient,
                    account,
                )
                console.info('[SignerDO] broadcast fallback success', { chainId, txHash })
                return txHash
            } catch (fallbackError) {
                const fallbackMessage = getErrorMessage(fallbackError)
                const message = `${primaryMessage}; fallback failed: ${fallbackMessage}`
                console.error('[SignerDO] broadcast fallback failed', {
                    chainId,
                    primaryError: primaryMessage,
                    fallbackError: fallbackMessage,
                })
                throw new SignerDOError(
                    `Failed to broadcast transaction: ${message}`,
                    'BROADCAST_FAILED',
                )
            }
        }
    }

    /**
     * Account upgrades are the only type-4 broadcasts. Estimate first, then
     * refuse to sign if gas or maxFeePerGas is above the upgrade cap.
     */
    private async applyCreateAccountCaps(
        txParams: PreparedBroadcastTransaction,
        nonce: number,
        chainId: number,
        feeParams: FeeParams,
    ): Promise<{ txParams: PreparedBroadcastTransaction; feeParams: FeeParams }> {
        if (!txParams.authorizationList || txParams.authorizationList.length === 0) {
            return { txParams, feeParams }
        }

        try {
            assertAccountUpgradeFee(feeParams.maxFeePerGas, feeParams.maxPriorityFeePerGas)
        } catch (error) {
            throw new SignerDOError(getErrorMessage(error), 'BROADCAST_FAILED')
        }

        const { publicClient, account } = this.ensureClients(chainId)
        let gas: bigint
        try {
            gas = await publicClient.estimateGas({
                account: account.address,
                to: txParams.to,
                data: txParams.data,
                value: txParams.value,
                nonce,
                maxFeePerGas: feeParams.maxFeePerGas,
                maxPriorityFeePerGas: feeParams.maxPriorityFeePerGas,
                authorizationList: txParams.authorizationList,
            })
        } catch (error) {
            throw new SignerDOError(
                `Failed to estimate account upgrade: ${getErrorMessage(error)}`,
                'BROADCAST_FAILED',
            )
        }

        try {
            const capped = assertAccountUpgradeGas({
                gas,
                maxFeePerGas: feeParams.maxFeePerGas,
                maxPriorityFeePerGas: feeParams.maxPriorityFeePerGas,
            })
            return {
                txParams: { ...txParams, gas: capped.gas },
                feeParams: {
                    maxFeePerGas: capped.maxFeePerGas,
                    maxPriorityFeePerGas: capped.maxPriorityFeePerGas,
                },
            }
        } catch (error) {
            throw new SignerDOError(getErrorMessage(error), 'BROADCAST_FAILED')
        }
    }

    private async sendWithPrimaryPath(
        txParams: PreparedBroadcastTransaction,
        nonce: number,
        chainId: number,
        feeParams: FeeParams,
        walletClient: WalletClient,
        account: PrivateKeyAccount,
    ): Promise<Hex> {
        return walletClient.sendTransaction({
            ...txParams,
            nonce,
            account,
            chain: { id: chainId } as Chain,
            maxFeePerGas: feeParams.maxFeePerGas,
            maxPriorityFeePerGas: feeParams.maxPriorityFeePerGas,
        })
    }

    private async sendWithRawFallback(
        txParams: PreparedBroadcastTransaction,
        nonce: number,
        chainId: number,
        feeParams: FeeParams,
        publicClient: PublicClient,
        walletClient: WalletClient,
        account: PrivateKeyAccount,
    ): Promise<Hex> {
        const gas =
            txParams.gas ??
            (await publicClient.estimateGas({
                account: account.address,
                to: txParams.to,
                data: txParams.data,
                value: txParams.value,
                nonce,
                maxFeePerGas: feeParams.maxFeePerGas,
                maxPriorityFeePerGas: feeParams.maxPriorityFeePerGas,
                authorizationList: txParams.authorizationList,
            }))

        const request = buildRawFallbackBroadcastRequest({
            txParams,
            nonce,
            chainId,
            account,
            gas,
            feeParams,
        })
        const serializedTransaction = await walletClient.signTransaction(request)
        if (!serializedTransaction) {
            throw new SignerDOError(
                'Fallback signing returned empty serialized transaction',
                'BROADCAST_FAILED',
            )
        }

        return publicClient.sendRawTransaction({ serializedTransaction })
    }

    /**
     * Encode an intent to bytes for the Orchestrator.execute() call
     */
    private encodeIntentToBytes(intent: IntentStruct): Hex {
        // Convert calls array to Call[] struct format
        const calls = intent.calls.map((call) => ({
            to: call.to as Address,
            value: call.value ? BigInt(call.value) : 0n,
            data: (call.data ?? '0x') as Hex,
        }))

        // Encode calls as executionData (abi.encode(calls))
        const executionData = encodeAbiParameters(
            [
                {
                    type: 'tuple[]',
                    components: [
                        { name: 'to', type: 'address' },
                        { name: 'value', type: 'uint256' },
                        { name: 'data', type: 'bytes' },
                    ],
                },
            ],
            [calls],
        )

        // Build the Intent struct matching ICommon.Intent
        const intentForContract = {
            // EIP-712 Fields
            eoa: intent.eoa as Address,
            executionData,
            nonce: BigInt(intent.nonce),
            payer: (intent.payer ?? zeroAddress) as Address,
            paymentToken: (intent.paymentToken ?? zeroAddress) as Address,
            paymentMaxAmount: BigInt(intent.paymentMaxAmount ?? '0'),
            combinedGas: BigInt(intent.combinedGas),
            encodedPreCalls: (intent.encodedPreCalls ?? []) as Hex[],
            encodedFundTransfers: (intent.encodedFundTransfers ?? []) as Hex[],
            settler: (intent.settler ?? zeroAddress) as Address,
            expiry: BigInt(intent.expiry ?? '0'),
            // Additional Fields (not in EIP-712)
            isMultichain: intent.isMultichain ?? false,
            funder: (intent.funder ?? zeroAddress) as Address,
            funderSignature: (intent.funderSignature ?? '0x') as Hex,
            settlerContext: (intent.settlerContext ?? '0x') as Hex,
            paymentAmount: BigInt(intent.paymentAmount ?? '0'),
            paymentRecipient: (intent.paymentRecipient ?? zeroAddress) as Address,
            signature: intent.signature as Hex,
            paymentSignature: (intent.paymentSignature ?? '0x') as Hex,
            supportedAccountImplementation: (intent.supportedAccountImplementation ??
                zeroAddress) as Address,
        }

        // ABI-encode the full Intent struct as bytes
        return encodeAbiParameters(
            [
                {
                    type: 'tuple',
                    components: [
                        { name: 'eoa', type: 'address' },
                        { name: 'executionData', type: 'bytes' },
                        { name: 'nonce', type: 'uint256' },
                        { name: 'payer', type: 'address' },
                        { name: 'paymentToken', type: 'address' },
                        { name: 'paymentMaxAmount', type: 'uint256' },
                        { name: 'combinedGas', type: 'uint256' },
                        { name: 'encodedPreCalls', type: 'bytes[]' },
                        { name: 'encodedFundTransfers', type: 'bytes[]' },
                        { name: 'settler', type: 'address' },
                        { name: 'expiry', type: 'uint256' },
                        { name: 'isMultichain', type: 'bool' },
                        { name: 'funder', type: 'address' },
                        { name: 'funderSignature', type: 'bytes' },
                        { name: 'settlerContext', type: 'bytes' },
                        { name: 'paymentAmount', type: 'uint256' },
                        { name: 'paymentRecipient', type: 'address' },
                        { name: 'signature', type: 'bytes' },
                        { name: 'paymentSignature', type: 'bytes' },
                        { name: 'supportedAccountImplementation', type: 'address' },
                    ],
                },
            ],
            [intentForContract],
        )
    }

    /**
     * Handle transaction finalization (called by queue consumer)
     */
    async handleFinalized(
        txId: string,
        status: 'confirmed' | 'failed',
        txHash?: string,
    ): Promise<void> {
        if (txHash) {
            const rows = this.sql
                .exec('SELECT tx_hash FROM pending_transactions WHERE id = ?', txId)
                .toArray()
            if (rows.length === 0) return
            const activeTxHash = (rows[0].tx_hash as string) ?? ''
            if (!shouldApplyFinalization({ activeTxHash, eventTxHash: txHash, status })) {
                return
            }
        }
        this.sql.exec('UPDATE pending_transactions SET status = ? WHERE id = ?', status, txId)
    }

    private async tryReplaceStaleTransaction(
        txId: string,
        chainId: number,
        signerName: string,
    ): Promise<'replaced' | 'skipped' | 'abandoned'> {
        const config = this.parseReplacementConfig()
        const nowMs = Date.now()

        const claimedRows = this.sql
            .exec(
                `
          UPDATE pending_transactions
          SET status = 'replacing'
          WHERE id = ? AND status = 'pending'
          RETURNING
            nonce,
            tx_to,
            tx_data,
            tx_value,
            tx_authorization_list,
            max_fee_per_gas,
            max_priority_fee_per_gas,
            replacement_attempts,
            last_replacement_at
        `,
                txId,
            )
            .toArray()

        if (claimedRows.length === 0) return 'skipped'

        return withRecoveryOnError(
            async () => {
                const claimed = claimedRows[0]
                const attempts = (claimed.replacement_attempts as number | undefined) ?? 0
                const lastReplacementAtMs = (claimed.last_replacement_at as number | undefined) ?? 0

                if (attempts >= config.maxAttempts) {
                    this.sql.exec(
                        'UPDATE pending_transactions SET status = ? WHERE id = ?',
                        'abandoned',
                        txId,
                    )
                    return 'abandoned' as const
                }

                if (
                    !shouldAttemptReplacementNow({
                        nowMs,
                        attempts,
                        maxAttempts: config.maxAttempts,
                        lastReplacementAtMs,
                        baseBackoffMs: config.baseBackoffMs,
                    })
                ) {
                    this.sql.exec(
                        'UPDATE pending_transactions SET status = ? WHERE id = ?',
                        'pending',
                        txId,
                    )
                    return 'skipped' as const
                }

                const currentMaxFee = this.parseOptionalBigInt(
                    claimed.max_fee_per_gas as string | undefined,
                )
                const currentMaxPriority = this.parseOptionalBigInt(
                    claimed.max_priority_fee_per_gas as string | undefined,
                )
                const txTo = (claimed.tx_to as string | undefined) ?? ''
                const txData = (claimed.tx_data as string | undefined) ?? ''
                const txValue = this.parseOptionalBigInt(claimed.tx_value as string | undefined)

                if (
                    !currentMaxFee ||
                    !currentMaxPriority ||
                    !txTo ||
                    !txData ||
                    txValue === undefined
                ) {
                    this.sql.exec(
                        'UPDATE pending_transactions SET status = ? WHERE id = ?',
                        'stuck',
                        txId,
                    )
                    return 'skipped' as const
                }

                const requiredFees = await this.getRecommendedFeeParams(chainId)
                const triggerReplacement = shouldTriggerReplacementByFee({
                    requiredMaxFeePerGas: requiredFees.maxFeePerGas,
                    currentMaxFeePerGas: currentMaxFee,
                    staleThresholdPerGas: config.triggerThresholdWei,
                })

                if (!triggerReplacement) {
                    const resolution = resolveNonTriggeredReplacement(attempts, config.maxAttempts)
                    this.sql.exec(
                        `
                      UPDATE pending_transactions
                      SET status = ?,
                          replacement_attempts = ?,
                          last_replacement_at = ?
                      WHERE id = ?
                    `,
                        resolution.status,
                        resolution.nextAttempts,
                        nowMs,
                        txId,
                    )
                    return 'skipped' as const
                }

                const nextFeeParams = computeReplacementFees({
                    currentMaxFeePerGas: currentMaxFee,
                    currentMaxPriorityFeePerGas: currentMaxPriority,
                    requiredMaxFeePerGas: requiredFees.maxFeePerGas,
                    requiredMaxPriorityFeePerGas: requiredFees.maxPriorityFeePerGas,
                    bumpBps: config.bumpBps,
                    maxFeePerGasCap: config.maxFeeCapWei,
                })

                const nextAttempts = attempts + 1
                if (!nextFeeParams) {
                    this.sql.exec(
                        `
                      UPDATE pending_transactions
                      SET status = 'abandoned',
                          replacement_attempts = ?,
                          last_replacement_at = ?
                      WHERE id = ?
                    `,
                        nextAttempts,
                        nowMs,
                        txId,
                    )
                    return 'abandoned' as const
                }

                const txParams: PreparedBroadcastTransaction = {
                    to: txTo as Address,
                    data: txData as Hex,
                    value: txValue,
                    authorizationList: this.deserializeAuthorizationList(
                        claimed.tx_authorization_list as string | undefined,
                    ),
                }

                try {
                    const nonce = claimed.nonce as number
                    const replacementHash = await this.signAndBroadcastPrepared(
                        txParams,
                        nonce,
                        chainId,
                        nextFeeParams,
                    )

                    this.sql.exec(
                        `
                      UPDATE pending_transactions
                      SET tx_hash = ?,
                          status = 'pending',
                          queued = 0,
                          max_fee_per_gas = ?,
                          max_priority_fee_per_gas = ?,
                          replacement_attempts = ?,
                          last_replacement_at = ?,
                          sent_at = ?
                      WHERE id = ?
                    `,
                        replacementHash,
                        nextFeeParams.maxFeePerGas.toString(),
                        nextFeeParams.maxPriorityFeePerGas.toString(),
                        nextAttempts,
                        nowMs,
                        nowMs,
                        txId,
                    )
                    await this.enqueueMonitorJob(txId, replacementHash, signerName, chainId)
                    return 'replaced' as const
                } catch {
                    const terminal = nextAttempts >= config.maxAttempts
                    this.sql.exec(
                        `
                      UPDATE pending_transactions
                      SET status = ?,
                          replacement_attempts = ?,
                          last_replacement_at = ?
                      WHERE id = ?
                    `,
                        terminal ? 'abandoned' : 'pending',
                        nextAttempts,
                        nowMs,
                        txId,
                    )
                    return terminal ? ('abandoned' as const) : ('skipped' as const)
                }
            },
            async () => {
                this.sql.exec(
                    "UPDATE pending_transactions SET status = 'pending' WHERE id = ? AND status = 'replacing'",
                    txId,
                )
            },
            'skipped',
        )
    }

    /**
     * Maintenance: clean up stale transactions, check balance
     */
    async handleMaintenance(): Promise<SignerMaintenanceResult> {
        await this.ensureInitialized()

        const stateRows = this.sql
            .exec('SELECT address, derivation_index, chain_id FROM signer_state WHERE id = 1')
            .toArray()

        if (stateRows.length === 0) {
            throw new SignerDOError('Signer not initialized', 'NOT_INITIALIZED')
        }

        const address = stateRows[0].address as string
        const index = stateRows[0].derivation_index as number
        const chainId = stateRows[0].chain_id as number

        // Clean up stale pending transactions
        const staleThreshold = Date.now() - STALE_TX_THRESHOLD_MS
        const stale = this.sql
            .exec(
                `
      SELECT id, tx_hash, nonce FROM pending_transactions
      WHERE status = 'pending' AND sent_at < ?
    `,
                staleThreshold,
            )
            .toArray()

        let confirmed = 0
        let failed = 0
        let stuck = 0

        for (const tx of stale) {
            const receipt = await this.getTransactionReceipt(tx.tx_hash as string, chainId)
            if (receipt) {
                const newStatus = receipt.status === '0x1' ? 'confirmed' : 'failed'
                this.sql.exec(
                    'UPDATE pending_transactions SET status = ? WHERE id = ?',
                    newStatus,
                    tx.id,
                )
                if (newStatus === 'confirmed') confirmed++
                else failed++
            } else {
                const signerName = this.getSignerName()
                if (!signerName) {
                    this.sql.exec(
                        "UPDATE pending_transactions SET status = 'stuck' WHERE id = ?",
                        tx.id,
                    )
                    stuck++
                    continue
                }

                const replacementResult = await this.tryReplaceStaleTransaction(
                    tx.id as string,
                    chainId,
                    signerName,
                )
                if (replacementResult === 'abandoned') {
                    failed++
                } else if (replacementResult === 'skipped') {
                    stuck++
                }
            }
        }

        let requeued = 0
        const signerName = this.getSignerName()
        if (signerName) {
            const orphaned = this.sql
                .exec(
                    `
          SELECT id, tx_hash FROM pending_transactions
          WHERE status = 'pending' AND queued = 0 AND tx_hash != ''
        `,
                )
                .toArray()

            for (const tx of orphaned) {
                const queued = await this.enqueueMonitorJob(
                    tx.id as string,
                    tx.tx_hash as Hex,
                    signerName,
                    chainId,
                )
                if (queued) {
                    requeued++
                }
            }
        }

        // Refresh balance
        const balance = await this.fetchBalance(address, chainId)

        // Check if refill needed
        const minBalance = this.parseBalance(this.env.MIN_SIGNER_BALANCE, 10000000000000000n)
        let gasRefillAttempted = false
        let gasRefillSuccess = false
        let gasRefillAmount: string | undefined
        let gasRefillTxHash: string | undefined
        let shouldPause = balance < minBalance

        if (shouldPause) {
            // Pause first (Ithaca pattern)
            this.sql.exec('UPDATE signer_state SET paused = 1 WHERE id = 1')

            // Attempt refill
            gasRefillAttempted = true
            const refillResult = await this.attemptGasRefill(balance, address, chainId)

            if (refillResult.success) {
                gasRefillSuccess = true
                gasRefillAmount = refillResult.amount?.toString()
                gasRefillTxHash = refillResult.txHash
                // Refill succeeded - unpause
                shouldPause = false
            }
            // If refill failed, stay paused
        }

        // Update state
        this.sql.exec(
            'UPDATE signer_state SET balance_wei = ?, last_balance_check = ?, paused = ? WHERE id = 1',
            balance.toString(),
            Date.now(),
            shouldPause ? 1 : 0,
        )

        return {
            index,
            address: address as Hex,
            staleTransactions: stale.length,
            confirmedTransactions: confirmed,
            failedTransactions: failed,
            stuckTransactions: stuck,
            requeuedTransactions: requeued,
            balance: balance.toString(),
            paused: shouldPause,
            gasRefillAttempted,
            gasRefillSuccess,
            gasRefillAmount,
            gasRefillTxHash,
        }
    }

    /**
     * Get full status for debugging
     */
    async getStatus(): Promise<{
        state: Record<string, unknown> | null
        pendingCount: number
        recentTransactions: unknown[]
    }> {
        await this.ensureInitialized()

        const stateRows = this.sql.exec('SELECT * FROM signer_state WHERE id = 1').toArray()
        const pendingCount =
            (this.sql
                .exec(
                    "SELECT COUNT(*) as c FROM pending_transactions WHERE status IN ('pending', 'replacing')",
                )
                .toArray()[0]?.c as number) ?? 0
        const recentTransactions = this.sql
            .exec('SELECT * FROM pending_transactions ORDER BY sent_at DESC LIMIT 10')
            .toArray()

        return {
            state: stateRows.length > 0 ? (stateRows[0] as Record<string, unknown>) : null,
            pendingCount,
            recentTransactions,
        }
    }
}

/**
 * Custom error class for SignerDO
 */
class SignerDOError extends Error {
    code: SignerErrorCode
    broadcastAttempted: boolean

    constructor(message: string, code: SignerErrorCode, broadcastAttempted = true) {
        super(message)
        this.name = 'SignerDOError'
        this.code = code
        this.broadcastAttempted = broadcastAttempted
    }
}

function tagBroadcastAttempt(error: unknown, attempted: boolean): SignerDOError {
    if (error instanceof SignerDOError) {
        error.broadcastAttempted = attempted
        return error
    }
    return new SignerDOError(getErrorMessage(error), 'BROADCAST_FAILED', attempted)
}
