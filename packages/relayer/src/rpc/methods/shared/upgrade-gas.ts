/** Backstop for a key-initialization upgrade. A 5M-gas delegation cannot be signed. */
export const ACCOUNT_UPGRADE_GAS_LIMIT = 1_500_000n

/** 100 gwei. Above this the relayer refuses to sign the upgrade. */
export const ACCOUNT_UPGRADE_MAX_FEE_PER_GAS = 100_000_000_000n

/**
 * 2 gwei. Honest Base and Anvil tips are about 1 wei, and the existing
 * allowed case uses 1 gwei. A tip is rejected on its own, even when it
 * still sits under maxFeePerGas.
 */
export const ACCOUNT_UPGRADE_MAX_PRIORITY_FEE_PER_GAS = 2_000_000_000n

export function assertAccountUpgradeFee(maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): void {
    if (maxFeePerGas <= 0n || maxFeePerGas > ACCOUNT_UPGRADE_MAX_FEE_PER_GAS) {
        throw new Error('Account upgrade max fee exceeds cap')
    }

    if (
        maxPriorityFeePerGas < 0n ||
        maxPriorityFeePerGas > ACCOUNT_UPGRADE_MAX_PRIORITY_FEE_PER_GAS
    ) {
        throw new Error('Account upgrade priority fee exceeds cap')
    }

    if (maxPriorityFeePerGas > maxFeePerGas) {
        throw new Error('Account upgrade priority fee exceeds cap')
    }
}

export function assertAccountUpgradeGas(input: {
    gas: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
}): { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
    assertAccountUpgradeFee(input.maxFeePerGas, input.maxPriorityFeePerGas)

    if (input.gas <= 0n || input.gas > ACCOUNT_UPGRADE_GAS_LIMIT) {
        throw new Error('Account upgrade gas limit exceeds cap')
    }

    return {
        gas: input.gas,
        maxFeePerGas: input.maxFeePerGas,
        maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    }
}
