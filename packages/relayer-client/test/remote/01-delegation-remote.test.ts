/**
 * Remote smoke test: single account delegation.
 *
 * Required env:
 * - RELAYER_URL
 * - RPC_URL
 * - TEST_CHAIN_ID (8453 for Base mainnet, 84532 for Base Sepolia, 137 for Polygon)
 * - REMOTE_PRIVATE_KEY (prefunded key used for top-up)
 * - REMOTE_ACCOUNT_PROXY (delegation target/account proxy address)
 */

import { describe, it, expect } from 'vitest'
import { createPublicClient, http, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { relayerActions, waitForBundle, type EthHttpSigner } from '../../src'
import { requiredAddr, requiredEnv } from '../helpers/env'

const hasRequiredEnv = Boolean(
    process.env.RELAYER_URL &&
    process.env.RPC_URL &&
    process.env.REMOTE_ACCOUNT_PROXY &&
    process.env.TEST_CHAIN_ID,
)

function remoteChainMeta(chainId: number) {
    switch (chainId) {
        case 8453:
            return {
                name: 'Base',
                nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
            }
        case 84532:
            return {
                name: 'Base Sepolia',
                nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
            }
        case 137:
            return {
                name: 'Polygon',
                nativeCurrency: { decimals: 18, name: 'POL', symbol: 'POL' },
            }
        case 42161:
            return {
                name: 'Arbitrum',
                nativeCurrency: { decimals: 18, name: 'ETH', symbol: 'ETH' },
            }
        case 31337:
            return {
                name: 'Anvil',
                nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
            }
        default:
            return undefined
    }
}

describe.skipIf(!hasRequiredEnv)('Remote Smoke: Delegation', () => {
    it('delegates one fresh account on remote Base chain', { timeout: 60_000 }, async () => {
        const RPC_URL = requiredEnv('RPC_URL')
        const RELAYER_URL = requiredEnv('RELAYER_URL')
        const TEST_CHAIN_ID = Number(process.env.TEST_CHAIN_ID)
        const REMOTE_ACCOUNT_PROXY = requiredAddr('REMOTE_ACCOUNT_PROXY')

        expect([8453, 84532, 137, 42161, 31337]).toContain(TEST_CHAIN_ID)

        const chainMeta = remoteChainMeta(TEST_CHAIN_ID)
        expect(chainMeta).toBeDefined()

        if (!chainMeta) {
            throw new Error(`Unsupported TEST_CHAIN_ID: ${TEST_CHAIN_ID}`)
        }

        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)

        const authSigner: EthHttpSigner = {
            chainId: TEST_CHAIN_ID,
            address: account.address,
            signMessage: async (message) =>
                account.signMessage({ message: { raw: toHex(message) } }),
        }

        const client = createPublicClient({
            chain: {
                id: TEST_CHAIN_ID,
                name: chainMeta.name,
                nativeCurrency: chainMeta.nativeCurrency,
                rpcUrls: {
                    default: {
                        http: [RPC_URL],
                    },
                },
            },
            transport: http(RPC_URL),
        }).extend(
            relayerActions({
                relayerUrl: RELAYER_URL,
                authSigner,
            }),
        )

        const codeBefore = await client.getCode({ address: account.address })
        expect(codeBefore === undefined || codeBefore === '0x').toBe(true)

        const result = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: REMOTE_ACCOUNT_PROXY,
        })

        expect(result.success).toBe(true)

        if (result.txHash) {
            expect(result.txHash.startsWith('0x')).toBe(true)
        }

        const codeAfter = await client.getCode({ address: account.address })
        expect(codeAfter).toBeDefined()
        expect(codeAfter !== '0x').toBe(true)
        expect(codeAfter?.startsWith('0xef0100')).toBe(true)

        // Submit one minimal call through relayer to validate post-delegation execution path.
        const prepared = await client.prepareCalls({
            from: account.address,
            calls: [
                {
                    target: account.address,
                    value: 0n,
                    data: '0x',
                },
            ],
        })

        const signature = await account.signTypedData({
            domain: prepared.typedData.domain,
            types: prepared.typedData.types,
            primaryType: prepared.typedData.primaryType,
            message: prepared.typedData.message,
        })

        const sent = await client.sendPreparedCalls({
            context: prepared.context,
            signature,
        })

        expect(sent.id).toBeDefined()

        const status = await waitForBundle(client, { id: sent.id, timeoutMs: 60_000 })
        expect([200, 201]).toContain(status.statusCode)
        expect(status.receipt?.transactionHash).toBeDefined()
    })
})
