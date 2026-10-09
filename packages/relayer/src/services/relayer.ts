/**
 * Relayer Service
 *
 * Provides simulation, intent preparation, and bundle status functionality.
 * Transaction signing and broadcasting is now handled by SignerDO/SignerPoolDO.
 */

import {
    concat,
    encodeFunctionData,
    encodeAbiParameters,
    hashTypedData,
    keccak256,
    parseAbiParameters,
    zeroAddress,
    BaseError,
    RawContractError,
    isHex,
    type Address,
    type Hex,
    type PublicClient,
} from 'viem'
import { accountAbi, simulatorAbi } from '@nubl/contracts/abis'
import type { IntentNonceDO } from '../durable-objects/intent-nonce.do'
import type { RelayerConfig, GasConfig } from '../types/env'
import { createRelayerPublicClient, isEip7702Delegated } from '../lib/viem-utils'
import {
    eip7702DelegationCode,
    PAID_UPGRADE_AUTHORIZATION_GAS,
} from '../rpc/methods/shared/paid-upgrade'
import { getErrorMessage } from '../lib/logger'
import type { Logger } from '../lib/logger'
import { INTENT_TYPES } from '../rpc/schema/intentTypes'
import type { EIP712Domain } from '../rpc/schema/prepareCalls'

/**
 * Call struct for intent execution (JSON-RPC format)
 */
interface CallInput {
    to: string
    value?: string
    data?: string
}

/**
 * Input for intent simulation
 */
interface SimulateIntentInput {
    eoa: string
    calls: CallInput[]
    nonce?: string
    combinedGas?: string
    expiry?: string
    signature?: string
    encodedPreCalls?: string[]
    funder?: string
    encodedFundTransfers?: string[]
    funderSignature?: string
    settler?: string
    settlerContext?: string
    isMultichain?: boolean
    payer?: string
    paymentToken?: string
    paymentMaxAmount?: string
    paymentAmount?: string
    paymentRecipient?: string
    paymentSignature?: string
    supportedAccountImplementation?: string
    sessionKey?: Hex
    /**
     * Delegation target for a user-paid first upgrade. When the EOA is not yet
     * delegated, simulation state-overrides its code to `0xef0100 || accountProxy`
     * instead of returning DELEGATION_PENDING.
     */
    delegation?: string
}

/**
 * Input for intent preparation
 */
interface PrepareIntentInput {
    eoa: string
    calls: CallInput[]
    nonce?: string
    seqKey?: string
    expiry?: string
    encodedPreCalls?: string[]
    funder?: string
    encodedFundTransfers?: string[]
    settler?: string
    payer?: string
    paymentToken?: string
    paymentMaxAmount?: string
    prepareKey?: string
    sessionKey?: Hex
    /** Account-proxy address when this prepare is a user-paid first upgrade. */
    paidUpgradeDelegation?: string
}

/**
 * Interface for intent nonce management
 * Manages 2D nonces (seqKey:192 | seq:64) per account
 */
export interface IntentNonceProvider {
    acquireOrGetDraft(
        eoa: Address,
        seqKey: bigint,
        onChainSeq: bigint,
        prepareKey?: string,
    ): Promise<
        | {
              nonce: bigint
              draftId: string
              createdAtMs: number
              expiresAtMs: number
              fromCache: boolean
          }
        | { conflict: true; error: string; conflictDraftId: string }
    >
    markSubmitted(
        eoa: Address,
        seqKey: bigint,
        draftId: string,
    ): Promise<'cleared' | 'not_found' | 'mismatch'>
}

/**
 * Result of intent simulation
 */
export interface SimulateIntentResult {
    success: boolean
    gasUsed?: string
    error?: string
    errorCode?: string
    revertReason?: string
}

/**
 * Result of intent preparation
 */
export interface PrepareIntentResult {
    success: boolean
    typedData?: {
        domain: EIP712Domain
        types: typeof INTENT_TYPES
        primaryType: 'Intent'
        message: {
            multichain: boolean
            eoa: Address
            calls: { to: Address; value: bigint; data: Hex }[]
            nonce: bigint
            payer: Address
            paymentToken: Address
            paymentMaxAmount: bigint
            combinedGas: bigint
            encodedPreCalls: Hex[]
            encodedFundTransfers: Hex[]
            settler: Address
            expiry: bigint
        }
    }
    nonce?: string
    /** Gas for orchestrator's internal execution (signed in EIP-712 message) */
    combinedGas?: string
    /** Total transaction gas limit (used by signer when broadcasting) */
    txGas?: string
    /** Raw simulation gas before applying buffers */
    simulationGas?: string
    expiry?: string
    digest?: Hex
    error?: string
    /** Draft ID that caused a conflict (only set when error is a draft conflict) */
    conflictDraftId?: string
    /** True if simulation failed but fallback was used (only when allowSimulationFallback=true) */
    simulationFailed?: boolean
    /** Original simulation error message (only set when simulationFailed=true) */
    simulationError?: string
    draftId?: string
    draftExpiresAtMs?: number
    draftFromCache?: boolean
    seqKey?: string
}

/**
 * Creates an IntentNonceProvider from a Durable Object namespace
 *
 * Each account gets its own DO instance (keyed by eoa address) to ensure
 * sequential nonce allocation without race conditions.
 */
export function createIntentNonceProvider(
    durableObject: DurableObjectNamespace<IntentNonceDO>,
    chainId: number,
): IntentNonceProvider {
    const durableObjectNameFor = (eoa: Address): string => `${chainId}:${eoa.toLowerCase()}`

    const getStubForEoa = (eoa: Address): DurableObjectStub<IntentNonceDO> => {
        const id = durableObject.idFromName(durableObjectNameFor(eoa))

        return durableObject.get(id)
    }

    const postToNonceDo = async (
        eoa: Address,
        path: string,
        body: Record<string, string | undefined | null>,
    ): Promise<Response> => {
        const stub = getStubForEoa(eoa)

        return stub.fetch(
            new Request(`http://do/${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
        )
    }

    return {
        async acquireOrGetDraft(
            eoa: Address,
            seqKey: bigint,
            onChainSeq: bigint,
            prepareKey?: string,
        ): Promise<
            | {
                  nonce: bigint
                  draftId: string
                  createdAtMs: number
                  expiresAtMs: number
                  fromCache: boolean
              }
            | { conflict: true; error: string; conflictDraftId: string }
        > {
            const response = await postToNonceDo(eoa, 'acquire_or_get_draft', {
                seqKey: seqKey.toString(),
                onChainSeq: onChainSeq.toString(),
                draftKey: prepareKey,
            })

            if (response.status === 409) {
                const body = (await response.json()) as {
                    error: string
                    conflictDraftId: string
                }

                return {
                    conflict: true,
                    error: body.error,
                    conflictDraftId: body.conflictDraftId,
                }
            }

            if (!response.ok) {
                const error = (await response.json()) as { error: string }
                throw new Error(`Failed to acquire intent draft: ${error.error}`)
            }

            const data = (await response.json()) as {
                nonce: string
                draftId: string
                createdAtMs: number
                expiresAtMs: number
                fromCache: boolean
            }

            return {
                nonce: BigInt(data.nonce),
                draftId: data.draftId,
                createdAtMs: data.createdAtMs,
                expiresAtMs: data.expiresAtMs,
                fromCache: data.fromCache,
            }
        },

        async markSubmitted(
            eoa: Address,
            seqKey: bigint,
            draftId: string,
        ): Promise<'cleared' | 'not_found' | 'mismatch'> {
            const response = await postToNonceDo(eoa, 'mark_submitted', {
                seqKey: seqKey.toString(),
                draftId,
            })

            if (!response.ok) {
                const error = (await response.json()) as { error: string }
                throw new Error(`Failed to mark intent draft submitted: ${error.error}`)
            }

            const data = (await response.json()) as {
                ok: boolean
                status: 'cleared' | 'not_found' | 'mismatch'
            }

            return data.status
        },
    }
}

/**
 * Relayer Service for simulation and intent preparation
 *
 * Note: Transaction signing and broadcasting has moved to SignerDO/SignerPoolDO.
 * Bundle status is now tracked by BundleStatusDO.
 * This service provides:
 * - Intent simulation (gas estimation)
 * - Intent preparation (nonce allocation, typed data generation)
 */
/** Default gas config values */
const DEFAULT_GAS_CONFIG: GasConfig = {
    intentGasBuffer: 50_000n, // Accounts for session key spending limit checks
    paymentGasBuffer: 70_000n, // Covers payment execution path not represented in baseline simulation
    orchestratorOverhead: 110_000n,
    txGasBuffer: 0n,
    allowSimulationFallback: false,
}

const DEFAULT_INTENT_EXPIRY_SECONDS = 3600n

const MAX_INTENT_EXPIRY_SECONDS_FROM_NOW = 365n * 24n * 60n * 60n // 1 year

const MILLISECONDS_EPOCH_THRESHOLD = 1_000_000_000_000n // 13+ digits => likely ms

/**
 * Resolve an intent expiry timestamp in unix seconds.
 *
 * Guards against accidental millisecond timestamps by rejecting
 * values that are far in the future and look like ms epoch values.
 */
export function resolveIntentExpirySeconds(
    rawExpiry: string | undefined,
    nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): bigint {
    if (!rawExpiry) {
        return nowSeconds + DEFAULT_INTENT_EXPIRY_SECONDS
    }

    const expiry = BigInt(rawExpiry)
    const maxSupportedExpiry = nowSeconds + MAX_INTENT_EXPIRY_SECONDS_FROM_NOW

    if (expiry > maxSupportedExpiry) {
        if (expiry >= MILLISECONDS_EPOCH_THRESHOLD) {
            throw new Error(
                `Invalid expiry: ${rawExpiry} appears to be milliseconds; use unix seconds`,
            )
        }

        throw new Error(`Invalid expiry: ${rawExpiry} is too far in the future`)
    }

    return expiry
}

/**
 * Payment path is active only when both payer and payment token are set.
 */
export function isPaymentEnabled(payer: Address, paymentToken: Address): boolean {
    return payer !== zeroAddress && paymentToken !== zeroAddress
}

/**
 * Calculate combinedGas from simulation and configured buffers.
 */
export function calculateCombinedGas(
    simulationGas: bigint,
    gasConfig: Pick<GasConfig, 'intentGasBuffer' | 'paymentGasBuffer'>,
    paymentEnabled: boolean,
): bigint {
    return (
        simulationGas +
        gasConfig.intentGasBuffer +
        (paymentEnabled ? gasConfig.paymentGasBuffer : 0n)
    )
}

function normalizeCalls(calls: CallInput[]): Array<{ to: Address; value: bigint; data: Hex }> {
    return calls.map((call) => ({
        to: call.to as Address,
        value: call.value ? BigInt(call.value) : 0n,
        data: (call.data ?? '0x') as Hex,
    }))
}

/**
 * Extracts revert data from a viem error, traversing the error chain.
 */
function extractRevertData(error: unknown): Hex | null {
    if (error instanceof BaseError) {
        const rawError = error.walk((e) => e instanceof RawContractError) as RawContractError | null
        const rawData = rawError?.data

        if (isHex(rawData)) {
            return rawData
        }

        if (rawData && typeof rawData === 'object' && 'data' in rawData) {
            const nested = (rawData as { data?: unknown }).data

            if (isHex(nested)) {
                return nested
            }
        }

        let current: unknown = error

        while (current) {
            const curr = current as { data?: unknown; cause?: unknown }

            if (isHex(curr.data)) {
                return curr.data
            }

            current = curr.cause
        }
    } else if (typeof error === 'object' && error !== null) {
        const err = error as { data?: unknown; cause?: { data?: unknown } }

        if (isHex(err.data)) return err.data

        if (err.cause && isHex(err.cause.data)) return err.cause.data
    }

    return null
}

export class RelayerService {
    private publicClient: PublicClient
    private config: RelayerConfig
    private gasConfig: GasConfig
    private logger: Logger
    private intentNonceProvider?: IntentNonceProvider

    constructor(
        config: RelayerConfig,
        logger: Logger,
        intentNonceProvider?: IntentNonceProvider,
        gasConfig?: GasConfig,
    ) {
        this.config = config
        this.gasConfig = gasConfig ?? DEFAULT_GAS_CONFIG
        this.logger = logger
        this.intentNonceProvider = intentNonceProvider
        this.publicClient = createRelayerPublicClient(config.chainId, config.rpcUrl)
    }

    /**
     * Acquires an intent nonce with the following priority:
     * 1. Explicit nonce from request (validated against on-chain)
     * 2. IntentNonceProvider with drift detection
     * 3. Direct on-chain query
     * 4. Default to 0n
     */
    private async acquireNonce(
        eoa: Address,
        seqKey: bigint,
        explicitNonce?: string,
        prepareKey?: string,
    ): Promise<
        | {
              success: true
              nonce: bigint
              draftId?: string
              draftExpiresAtMs?: number
              draftFromCache?: boolean
          }
        | { success: false; error: string; conflictDraftId?: string }
    > {
        if (explicitNonce) {
            return this.validateExplicitNonce(eoa, seqKey, BigInt(explicitNonce))
        }

        if (this.intentNonceProvider) {
            return this.acquireNonceFromProvider(eoa, seqKey, prepareKey)
        }

        return { success: true, nonce: await this.fetchOnChainNonce(eoa, seqKey) }
    }

    private async validateExplicitNonce(
        eoa: Address,
        seqKey: bigint,
        nonce: bigint,
    ): Promise<{ success: true; nonce: bigint } | { success: false; error: string }> {
        try {
            const onChainNonce = (await this.publicClient.readContract({
                address: eoa,
                abi: accountAbi,
                functionName: 'getNonce',
                args: [seqKey],
            })) as bigint

            if (nonce < onChainNonce) {
                return {
                    success: false,
                    error: `Nonce ${nonce} already used. Current on-chain nonce is ${onChainNonce}`,
                }
            }
        } catch {
            this.logger.debug(
                { eoa, nonce: nonce.toString() },
                'could not read on-chain nonce, accepting user-supplied nonce',
            )
        }

        return { success: true, nonce }
    }

    private async acquireNonceFromProvider(
        eoa: Address,
        seqKey: bigint,
        prepareKey?: string,
    ): Promise<
        | {
              success: true
              nonce: bigint
              draftId: string
              draftExpiresAtMs: number
              draftFromCache: boolean
          }
        | { success: false; error: string; conflictDraftId?: string }
    > {
        const onChainSeq = await this.fetchOnChainSeq(eoa, seqKey)
        const safeOnChainSeq = onChainSeq ?? 0n

        const result = await this.intentNonceProvider!.acquireOrGetDraft(
            eoa,
            seqKey,
            safeOnChainSeq,
            prepareKey,
        )

        if ('conflict' in result) {
            return {
                success: false,
                error: result.error,
                conflictDraftId: result.conflictDraftId,
            }
        }

        const { nonce, draftId, expiresAtMs, fromCache } = result

        if (onChainSeq === null) {
            this.logger.debug(
                { eoa, nonce: nonce.toString(), draftId },
                'acquired intent draft without on-chain drift check (RPC unavailable)',
            )
        } else {
            this.logger.debug(
                { eoa, nonce: nonce.toString(), draftId, fromCache },
                'acquired intent draft from provider',
            )
        }

        return {
            success: true,
            nonce,
            draftId,
            draftExpiresAtMs: expiresAtMs,
            draftFromCache: fromCache,
        }
    }

    private async fetchOnChainSeq(eoa: Address, seqKey: bigint): Promise<bigint | null> {
        try {
            const onChainNonce = (await this.publicClient.readContract({
                address: eoa,
                abi: accountAbi,
                functionName: 'getNonce',
                args: [seqKey],
            })) as bigint

            return onChainNonce & ((1n << 64n) - 1n)
        } catch {
            this.logger.debug({ eoa }, 'could not read on-chain nonce for drift check')

            return null
        }
    }

    private async fetchOnChainNonce(eoa: Address, seqKey: bigint): Promise<bigint> {
        try {
            return (await this.publicClient.readContract({
                address: eoa,
                abi: accountAbi,
                functionName: 'getNonce',
                args: [seqKey],
            })) as bigint
        } catch {
            return 0n
        }
    }

    /**
     * Simulate an intent execution without submitting
     *
     * Calls the Simulator contract via eth_call to estimate gas usage.
     * The Simulator always reverts with either SimulationPassed(gasUsed) or SimulationFailed(reason).
     */
    async simulateIntent(request: SimulateIntentInput): Promise<SimulateIntentResult> {
        try {
            this.logger.info({ eoa: request.eoa }, 'simulating intent execution')

            // Check if account has EIP-7702 delegation code before simulating
            const code = await this.publicClient.getCode({ address: request.eoa as Address })

            let delegationCode: Hex | undefined

            if (!isEip7702Delegated(code)) {
                const delegation = request.delegation

                if (!delegation) {
                    this.logger.warn(
                        { eoa: request.eoa, code: code ?? '0x' },
                        'account not delegated yet',
                    )

                    return {
                        success: false,
                        error: 'Account delegation pending',
                        errorCode: 'DELEGATION_PENDING',
                    }
                }

                if (
                    delegation.toLowerCase() !==
                    this.config.contracts.accountProxy.toLowerCase()
                ) {
                    return {
                        success: false,
                        error: 'Delegation target is not the account proxy',
                    }
                }

                delegationCode = eip7702DelegationCode(this.config.contracts.accountProxy)
            }

            // Build the calls for simulation (JSON-RPC format: to, value as hex)
            const calls = normalizeCalls(request.calls)

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

            // Build the Intent struct with defaults for missing fields
            const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
            const expiry = resolveIntentExpirySeconds(request.expiry, nowSeconds)

            // When a signing key is provided, build a synthetic signature so the
            // Orchestrator's _verify returns the real keyHash during simulation.
            // Format: [65 zero bytes (fake ECDSA) | keyHash (32) | prehash flag (1)]
            // The account extracts keyHash from the suffix; validation fails but
            // simulation mode overrides isValid=true. This makes GuardedExecutor
            // run the session-key path (canExecute + _incrementSpent) for accurate gas.
            let signature: Hex = (request.signature ?? '0x') as Hex

            if (request.sessionKey && !request.signature) {
                const keyHash = keccak256(
                    encodeAbiParameters(parseAbiParameters('uint8, bytes32'), [
                        0, // secp256k1
                        keccak256(request.sessionKey),
                    ]),
                )

                signature = concat([`0x${'00'.repeat(65)}` as Hex, keyHash, '0x00' as Hex])
            }

            const intent = {
                eoa: request.eoa as Address,
                executionData,
                nonce: BigInt(request.nonce ?? '0'),
                payer: (request.payer ?? zeroAddress) as Address,
                paymentToken: (request.paymentToken ?? zeroAddress) as Address,
                paymentMaxAmount: BigInt(request.paymentMaxAmount ?? '0'),
                combinedGas: BigInt(request.combinedGas ?? '10000000'), // High default for estimation
                encodedPreCalls: (request.encodedPreCalls ?? []) as Hex[],
                encodedFundTransfers: (request.encodedFundTransfers ?? []) as Hex[],
                settler: (request.settler ?? zeroAddress) as Address,
                expiry,
                isMultichain: request.isMultichain ?? false,
                funder: (request.funder ?? zeroAddress) as Address,
                funderSignature: (request.funderSignature ?? '0x') as Hex,
                settlerContext: (request.settlerContext ?? '0x') as Hex,
                paymentAmount: BigInt(request.paymentAmount ?? '0'),
                paymentRecipient: (request.paymentRecipient ?? zeroAddress) as Address,
                signature,
                paymentSignature: (request.paymentSignature ?? '0x') as Hex,
                supportedAccountImplementation: (request.supportedAccountImplementation ??
                    zeroAddress) as Address,
            }

            // ABI-encode the full Intent struct as bytes
            const encodedIntent = encodeAbiParameters(
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
                [intent],
            )

            // Encode the function call data for Simulator.simulateGasUsed
            // simulateGasUsed(address oc, bool overrideCombinedGas, bytes encodedIntent)
            // - overrideCombinedGas=true uses type(uint256).max for combinedGas, allowing estimation
            const calldata = encodeFunctionData({
                abi: simulatorAbi,
                functionName: 'simulateGasUsed',
                args: [this.config.contracts.orchestrator, true, encodedIntent],
            })

            try {
                // Call Simulator.simulateGasUsed via eth_call
                // On success, returns gasUsed directly
                // On failure, reverts with the underlying error
                const result = delegationCode
                    ? await this.publicClient.call({
                          to: this.config.contracts.simulator,
                          data: calldata,
                          stateOverride: [
                              {
                                  address: request.eoa as Address,
                                  code: delegationCode,
                              },
                          ],
                      })
                    : await this.publicClient.call({
                          to: this.config.contracts.simulator,
                          data: calldata,
                      })

                // If successful, decode the returned gasUsed value
                if (result.data) {
                    // simulateGasUsed returns (uint256 gasUsed)
                    const gasUsed = BigInt(result.data)
                    this.logger.info(
                        { eoa: request.eoa, gasUsed: gasUsed.toString() },
                        'simulation passed',
                    )

                    return {
                        success: true,
                        gasUsed: gasUsed.toString(),
                    }
                }

                this.logger.warn({ eoa: request.eoa }, 'simulator returned no data')

                return {
                    success: false,
                    error: 'Simulator returned no data',
                }
            } catch (callError: unknown) {
                const errorData = extractRevertData(callError)

                this.logger.debug(
                    { eoa: request.eoa, errorData, hasData: !!errorData },
                    'simulation reverted, extracting revert data',
                )

                if (errorData) {
                    return {
                        success: false,
                        error: 'Simulation failed',
                        revertReason: errorData,
                    }
                }

                const errorMessage =
                    callError instanceof Error ? callError.message : String(callError)

                this.logger.warn(
                    {
                        eoa: request.eoa,
                        errorType: (callError as object)?.constructor?.name,
                        errorMessage,
                    },
                    'simulation error - no error data found',
                )

                return {
                    success: false,
                    error: `Simulation reverted: ${errorMessage}`,
                }
            }
        } catch (error) {
            const message = getErrorMessage(error)
            this.logger.error({ error: message, eoa: request.eoa }, 'simulation failed')

            return {
                success: false,
                error: message,
            }
        }
    }

    /**
     * Prepare an intent for signing
     *
     * Fetches nonce if not provided, estimates gas via simulation,
     * and returns EIP-712 typed data for the client to sign.
     */
    async prepareIntent(request: PrepareIntentInput): Promise<PrepareIntentResult> {
        try {
            this.logger.info({ eoa: request.eoa }, 'preparing intent')

            const eoaAddress = request.eoa as Address
            const seqKey = BigInt(request.seqKey ?? '0')

            const nonceResult = await this.acquireNonce(
                eoaAddress,
                seqKey,
                request.nonce,
                request.prepareKey,
            )

            if (!nonceResult.success) {
                return {
                    success: false,
                    error: nonceResult.error,
                    conflictDraftId: nonceResult.conflictDraftId,
                }
            }

            const nonce = nonceResult.nonce

            const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
            const expiry = resolveIntentExpirySeconds(request.expiry, nowSeconds)

            // PreCalls defaults
            const encodedPreCalls = (request.encodedPreCalls ?? []) as Hex[]

            // Funding defaults
            const encodedFundTransfers = (request.encodedFundTransfers ?? []) as Hex[]

            // Settler defaults
            const settler = (request.settler ?? zeroAddress) as Address

            // Payment defaults
            const payer = (request.payer ?? zeroAddress) as Address
            const paymentToken = (request.paymentToken ?? zeroAddress) as Address
            const paymentMaxAmount = BigInt(request.paymentMaxAmount ?? '0')
            const paymentEnabled = isPaymentEnabled(payer, paymentToken)

            // Build calls with EIP-712 field names (JSON-RPC format: to, value as hex)
            const calls = normalizeCalls(request.calls)

            // Simulate to get gas estimate
            const simulateResult = await this.simulateIntent({
                eoa: request.eoa,
                calls: request.calls,
                nonce: nonce.toString(),
                expiry: expiry.toString(),
                encodedPreCalls: request.encodedPreCalls,
                encodedFundTransfers: request.encodedFundTransfers,
                settler: request.settler,
                payer: request.payer,
                paymentToken: request.paymentToken,
                paymentMaxAmount: request.paymentMaxAmount,
                sessionKey: request.sessionKey,
                delegation: request.paidUpgradeDelegation,
            })

            /**
             * Gas Calculation (see audit/prepare-intent-review.md for details)
             *
             * Two distinct values:
             * - combinedGas: Gas budget for orchestrator's internal execution (signed in EIP-712)
             * - txGas: Total transaction gas limit (used by signer when broadcasting)
             *
             * Formula:
             * combinedGas = simulationGas + intentGasBuffer
             * txGas = ((combinedGas + orchestratorOverhead + txGasBuffer) * 64/63) + intrinsicGas
             *
             * Where:
             * - 64/63 accounts for EVM's gas forwarding rule (max 63/64 passed to subcalls)
             * - orchestratorOverhead (~110k) is work outside the gas-limited self-call
             * - intrinsicGas is EVM transaction overhead (21000 + calldata cost)
             */
            const simulationGas = simulateResult.gasUsed ? BigInt(simulateResult.gasUsed) : 0n
            const simulationSucceeded = simulateResult.success && simulationGas > 0n

            let combinedGas: bigint
            let txGas: bigint
            let simulationFailed = false
            let simulationError: string | undefined

            if (simulationSucceeded) {
                // combinedGas = simulation gas + baseline buffer + payment-path buffer (if enabled)
                combinedGas = calculateCombinedGas(simulationGas, this.gasConfig, paymentEnabled)

                // Estimate intrinsic gas (21000 base + ~16 gas per calldata byte)
                // Conservative estimate: ~1000 bytes of calldata for typical intent
                const estimatedCalldataGas = 16_000n
                const intrinsicGas = 21_000n + estimatedCalldataGas

                // txGas = ((combinedGas + overhead + buffer) * 64/63) + intrinsic
                const gasForForwarding =
                    combinedGas + this.gasConfig.orchestratorOverhead + this.gasConfig.txGasBuffer

                txGas = (gasForForwarding * 64n) / 63n + intrinsicGas

                // Authorization gas is charged on the type-4 tx, outside the
                // simulator call. Pre-call gas is already inside simulationGas.
                if (request.paidUpgradeDelegation) {
                    txGas += PAID_UPGRADE_AUTHORIZATION_GAS
                }
            } else {
                // Simulation failed
                simulationError = simulateResult.error ?? 'Simulation returned zero gas'

                if (!this.gasConfig.allowSimulationFallback) {
                    // Fail the request - don't hide simulation errors
                    this.logger.error(
                        {
                            eoa: request.eoa,
                            simulateError: simulateResult.error,
                            gasUsed: simulateResult.gasUsed,
                        },
                        'simulation failed, rejecting request',
                    )

                    return {
                        success: false,
                        error: `Simulation failed: ${simulationError}`,
                    }
                }

                // Fallback allowed - use conservative defaults but warn
                simulationFailed = true
                combinedGas = 500_000n
                txGas = request.paidUpgradeDelegation
                    ? 700_000n + PAID_UPGRADE_AUTHORIZATION_GAS
                    : 700_000n
                this.logger.warn(
                    {
                        eoa: request.eoa,
                        simulateError: simulateResult.error,
                        gasUsed: simulateResult.gasUsed,
                    },
                    'simulation failed, using fallback gas (ALLOW_SIMULATION_FALLBACK=true)',
                )
            }

            // Build EIP-712 domain
            const domain: EIP712Domain = {
                name: 'Orchestrator',
                version: '0.5.5',
                chainId: this.config.chainId,
                verifyingContract: this.config.contracts.orchestrator,
            }

            // Build message matching INTENT_TYPEHASH order
            const message = {
                multichain: false, // Default to single-chain
                eoa: eoaAddress,
                calls,
                nonce,
                payer,
                paymentToken,
                paymentMaxAmount,
                combinedGas,
                encodedPreCalls,
                encodedFundTransfers,
                settler,
                expiry,
            }

            // Compute digest
            const digest = hashTypedData({
                domain,
                types: INTENT_TYPES,
                primaryType: 'Intent',
                message,
            })

            this.logger.info(
                {
                    eoa: request.eoa,
                    nonce: nonce.toString(),
                    combinedGas: combinedGas.toString(),
                    txGas: txGas.toString(),
                    paymentEnabled,
                    paymentGasBufferApplied: paymentEnabled
                        ? this.gasConfig.paymentGasBuffer.toString()
                        : '0',
                    simulationFailed,
                },
                'intent prepared',
            )

            const result: PrepareIntentResult = {
                success: true,
                typedData: {
                    domain,
                    types: INTENT_TYPES,
                    primaryType: 'Intent',
                    message,
                },
                nonce: nonce.toString(),
                simulationGas: simulationGas.toString(),
                combinedGas: combinedGas.toString(),
                txGas: txGas.toString(),
                expiry: expiry.toString(),
                digest,
                draftId: nonceResult.draftId,
                draftExpiresAtMs: nonceResult.draftExpiresAtMs,
                draftFromCache: nonceResult.draftFromCache,
                seqKey: seqKey.toString(),
            }

            // Include simulation status when fallback was used
            if (simulationFailed) {
                result.simulationFailed = true
                result.simulationError = simulationError
            }

            return result
        } catch (error) {
            const message = getErrorMessage(error)
            this.logger.error({ error: message, eoa: request.eoa }, 'intent preparation failed')

            return {
                success: false,
                error: message,
            }
        }
    }
}
