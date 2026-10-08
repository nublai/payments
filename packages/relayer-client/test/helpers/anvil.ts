/**
 * Anvil cheatcode helpers for integration tests
 *
 * In local/fork mode, these helpers use Anvil cheatcodes.
 * In remote mode, a subset falls back to onchain transfers when REMOTE_PRIVATE_KEY is set.
 */

import {
    createTestClient,
    createWalletClient,
    http,
    erc20Abi,
    type Address,
    type Hex,
    encodeFunctionData,
    publicActions,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
    ANVIL_RPC_URL,
    TOKENS,
    testChain,
    HAS_ANVIL_CHEATCODES,
    IS_LOCAL_MODE,
    REMOTE_PRIVATE_KEY,
    getTestPublicClient,
} from '../setup'

// MockUSDC mint ABI for local mode
const mintAbi = [
    {
        name: 'mint',
        type: 'function',
        inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [],
    },
] as const

/**
 * Get a test client with cheatcode support and public actions (readContract, etc.)
 * Only works in local mode.
 */
export function getTestClient() {
    return createTestClient({
        chain: testChain,
        mode: 'anvil',
        transport: http(ANVIL_RPC_URL),
    }).extend(publicActions)
}

function getRemoteWalletClient() {
    if (!REMOTE_PRIVATE_KEY) {
        throw new Error('REMOTE_PRIVATE_KEY is required for remote funding helpers')
    }

    return createWalletClient({
        chain: testChain,
        transport: http(ANVIL_RPC_URL),
        account: privateKeyToAccount(REMOTE_PRIVATE_KEY as Hex),
    })
}

/**
 * Set ETH balance for an address using Anvil cheatcode.
 * In remote mode, tops up ETH using REMOTE_PRIVATE_KEY.
 */
export async function setBalance(address: Address, amount: bigint) {
    if (HAS_ANVIL_CHEATCODES) {
        const client = getTestClient()
        await client.setBalance({ address, value: amount })

        return
    }

    if (!REMOTE_PRIVATE_KEY) return

    const publicClient = getTestPublicClient()
    const currentBalance = await publicClient.getBalance({ address })

    if (currentBalance >= amount) return

    const walletClient = getRemoteWalletClient()

    const hash = await walletClient.sendTransaction({
        to: address,
        value: amount - currentBalance,
    })

    await publicClient.waitForTransactionReceipt({ hash })
}

/**
 * Deal tokens to an address.
 * - Local mode: calls MockUSDC.mint()
 * - Fork mode: impersonates a whale and transfers
 * - Remote mode: transfers from REMOTE_PRIVATE_KEY
 */
export async function deal(address: Address, token: Address, amount: bigint) {
    if (token !== TOKENS.USDC) {
        throw new Error(`Token ${token} not supported for deal(). Add specific handling.`)
    }

    if (HAS_ANVIL_CHEATCODES) {
        const client = getTestClient()

        if (IS_LOCAL_MODE) {
            // Local mode: call MockUSDC.mint() - anyone can mint
            const deployerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

            const walletClient = createWalletClient({
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
                account: privateKeyToAccount(deployerKey),
            })

            const hash = await walletClient.writeContract({
                address: token,
                abi: mintAbi,
                functionName: 'mint',
                args: [address, amount],
            })

            await client.waitForTransactionReceipt({ hash })
        } else {
            // Fork mode: impersonate a known whale and transfer
            const usdcWhale: Address = '0xF977814e90dA44bFA03b6295A0616a897441aceC' // Binance hot wallet

            await client.impersonateAccount({ address: usdcWhale })

            const hash = await client.sendUnsignedTransaction({
                from: usdcWhale,
                to: token,
                data: encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'transfer',
                    args: [address, amount],
                }),
            })

            await client.waitForTransactionReceipt({ hash })
            await client.stopImpersonatingAccount({ address: usdcWhale })
        }

        return
    }

    const publicClient = getTestPublicClient()
    const walletClient = getRemoteWalletClient()

    const hash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [address, amount],
    })

    await publicClient.waitForTransactionReceipt({ hash })
}

/**
 * Get ERC20 balance
 */
export async function getERC20Balance(token: Address, account: Address): Promise<bigint> {
    const client = getTestPublicClient()

    return client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account],
    })
}

/**
 * Wait for account delegation to be confirmed on-chain.
 * Polls until EIP-7702 delegation code is present.
 */
export async function waitForDelegation(
    address: Address,
    options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
    const { timeoutMs = 10000, intervalMs = 200 } = options ?? {}
    const client = getTestPublicClient()
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
        const code = await client.getCode({ address })

        if (code && code !== '0x' && code.startsWith('0xef0100')) {
            return // Delegation confirmed
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    throw new Error(`Timeout waiting for delegation of ${address}`)
}
