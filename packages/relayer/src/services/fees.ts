/**
 * Fee Estimation Service
 *
 * Calculates payment amounts based on gas estimates and current network fees.
 * Uses EIP-1559 fee history to determine priority fees.
 *
 * Note: Gas calculation (combinedGas, txGas) is handled in RelayerService.prepareIntent.
 * This service only handles fee price estimation and payment calculation.
 */

import { zeroAddress, type PublicClient, type Address } from 'viem'
import type { FeeConfig } from '../types/env'

/**
 * Fee estimate result
 */
export interface FeeEstimate {
    /** Base fee per gas (wei) */
    baseFeePerGas: bigint
    /** Priority fee per gas (wei) */
    maxPriorityFeePerGas: bigint
    /** Max fee per gas = baseFee + priorityFee (wei) */
    maxFeePerGas: bigint
    /** Total gas units for the transaction (passed through from prepareIntent) */
    totalGas: bigint
    /** Estimated payment amount in wei (totalGas * maxFeePerGas) */
    paymentAmount: bigint
}

/**
 * Get fee estimate using EIP-1559 fee history
 *
 * @param publicClient - Viem public client
 * @param txGas - Pre-calculated transaction gas (from prepareIntent)
 * @param config - Fee configuration
 * @returns Fee estimate with payment amount
 */
export async function getFeeEstimate(
    publicClient: PublicClient,
    txGas: bigint,
    config: FeeConfig,
): Promise<FeeEstimate> {
    // Fetch fee history for last 4 blocks, requesting reward percentiles
    const feeHistory = await publicClient.getFeeHistory({
        blockCount: 4,
        rewardPercentiles: [config.priorityFeePercentile],
    })

    // Get base fee from latest block
    const baseFeePerGas = feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1] ?? 0n

    // Calculate priority fee from percentile rewards
    // Average the reward values across blocks for stability
    let priorityFeeSum = 0n
    let priorityFeeCount = 0

    for (const reward of feeHistory.reward ?? []) {
        if (reward[0] !== undefined) {
            priorityFeeSum += reward[0]
            priorityFeeCount++
        }
    }

    const maxPriorityFeePerGas =
        priorityFeeCount > 0 ? priorityFeeSum / BigInt(priorityFeeCount) : 1000000000n // 1 gwei fallback

    // Max fee = base fee + priority fee (with some buffer on base fee for fluctuation)
    const baseFeeWithBuffer = baseFeePerGas + baseFeePerGas / 10n // 10% buffer on base fee
    const maxFeePerGas = baseFeeWithBuffer + maxPriorityFeePerGas

    // Payment amount = txGas * maxFeePerGas
    const paymentAmount = txGas * maxFeePerGas

    return {
        baseFeePerGas,
        maxPriorityFeePerGas,
        maxFeePerGas,
        totalGas: txGas,
        paymentAmount,
    }
}

/**
 * Convert payment amount from native token to fee token
 *
 * @param nativeAmount - Amount in native token (wei)
 * @param nativeRate - Rate of fee token per native token (scaled by 1e18)
 * @param feeTokenDecimals - Decimals of the fee token
 * @returns Amount in fee token units
 */
export function convertToFeeToken(
    nativeAmount: bigint,
    nativeRate: bigint,
    feeTokenDecimals: number,
): bigint {
    // nativeAmount is in wei (18 decimals)
    // nativeRate is fee_token_per_native * 1e18
    // Result should be in fee token decimals
    //
    // payment = nativeAmount * nativeRate / 1e18 * 10^(feeTokenDecimals - 18)
    //         = nativeAmount * nativeRate / 10^(36 - feeTokenDecimals)
    const scaleFactor = 10n ** BigInt(36 - feeTokenDecimals)

    return (nativeAmount * nativeRate) / scaleFactor
}

/**
 * Validate payment amount against max amount
 *
 * @param paymentAmount - Calculated payment amount
 * @param paymentMaxAmount - User's consented maximum
 * @returns true if payment is within limit
 */
export function validatePaymentAmount(paymentAmount: bigint, paymentMaxAmount: bigint): boolean {
    return paymentAmount <= paymentMaxAmount
}

/**
 * Get payment recipient address
 *
 * @param configuredRecipient - Configured fee recipient (may be undefined)
 * @param signerAddress - Fallback signer address for self-reimbursement
 * @returns Address to receive payment
 */
export function getPaymentRecipient(
    configuredRecipient: string | undefined,
    signerAddress: Address,
): Address {
    if (configuredRecipient && configuredRecipient !== zeroAddress) {
        return configuredRecipient as Address
    }

    return signerAddress
}
