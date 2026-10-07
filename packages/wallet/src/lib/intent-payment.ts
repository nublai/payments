import { zeroAddress, type Address } from 'viem'
import { getUsdcAddressByChainId, type EnvName } from './network-config'

/** 5 USDC. Chosen by the wallet, never copied from a relayer quote. */
export const PAID_FEE_CAP = 5_000_000n

export function isLocalFeeChain(env: EnvName, chainId: number): boolean {
    return env === 'dev' || chainId === 31337 || chainId === 41337
}

/**
 * Local and dev stay at a zero cap. Every other chain signs a wallet-chosen USDC cap
 * paid by the account itself.
 */
export function resolveIntentPayment(
    env: EnvName,
    chainId: number,
    from: Address,
): { payer: Address; paymentToken: Address; paymentMaxAmount: bigint } {
    if (isLocalFeeChain(env, chainId)) {
        return {
            payer: zeroAddress,
            paymentToken: zeroAddress,
            paymentMaxAmount: 0n,
        }
    }
    const paymentToken = getUsdcAddressByChainId(chainId)
    if (!paymentToken) {
        throw new Error(
            `No USDC deployment for chain ${chainId}. Refusing to sign a zero fee cap.`,
        )
    }
    return {
        payer: from,
        paymentToken,
        paymentMaxAmount: PAID_FEE_CAP,
    }
}
