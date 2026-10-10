/**
 * Remote smoke test: HTTP auth mechanisms for protected relayer methods.
 *
 * Outcomes covered:
 * 1) Privy wallet + valid bearer token can sendPreparedCalls
 * 2) Privy wallet + invalid bearer token is rejected for sendPreparedCalls
 * 3) ERC-8128 signer + valid signature can sendPreparedCalls
 * 4) ERC-8128 signer + invalid signature is rejected for sendPreparedCalls
 */

import { describe, it, expect } from 'vitest'
import { PrivyClient } from '@privy-io/server-auth'
import { type EthHttpSigner } from '@slicekit/erc8128'
import { createPublicClient, http, toHex, type Address, encodeFunctionData, concat } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { relayerActions } from '../../src'
import type { RpcPrepareCallsContext, RpcUpgradeAccountContext } from '../../src/rpc-schema'
import { createJsonRpcTransport, type JsonRpcTransport } from '../../src/transport'
import { requiredAddr, requiredEnv } from '../helpers/env'
import { parseAddr, parseHex } from '../helpers/hex'

type PrivyWalletInfo = {
    address: Address
    id: string
}

type PrivyBootstrap = {
    privy: PrivyClient
    accessToken: string
    wallet: PrivyWalletInfo
}

type ChainMeta = {
    id: number
    name: string
    nativeCurrency: { decimals: 18; name: string; symbol: string }
}

type RpcTypedDataPayload = {
    domain: {
        name?: string
        version?: string
        chainId?: number | string
        verifyingContract?: string
    }
    types: Record<string, Array<{ name: string; type: string }>>
    message: {
        multichain?: boolean
        eoa?: string
        calls?: Array<{ to?: string; value?: string | bigint; data?: string }>
        nonce?: string | bigint
        payer?: string
        paymentToken?: string
        paymentMaxAmount?: string | bigint
        combinedGas?: string | bigint
        encodedPreCalls?: string[]
        encodedFundTransfers?: string[]
        settler?: string
        expiry?: string | bigint
    }
    primaryType: string
}

const hasPrivyEnv = Boolean(
    process.env.RELAYER_URL &&
    process.env.RPC_URL &&
    process.env.TEST_CHAIN_ID &&
    process.env.REMOTE_ACCOUNT_PROXY &&
    process.env.PRIVY_APP_ID &&
    process.env.PRIVY_APP_SECRET &&
    process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY &&
    (process.env.PRIVY_TEST_ACCESS_TOKEN || process.env.PRIVY_TEST_EMAIL),
)

const hasErc8128Env = Boolean(
    process.env.RELAYER_URL &&
    process.env.RPC_URL &&
    process.env.TEST_CHAIN_ID &&
    process.env.REMOTE_ACCOUNT_PROXY,
)

const getNonceAbi = [
    {
        type: 'function',
        name: 'getNonce',
        stateMutability: 'view',
        inputs: [{ name: 'seqKey', type: 'uint192' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
] as const

function toHexChainId(chainId: number): `0x${string}` {
    return `0x${chainId.toString(16)}`
}

function getChainMeta(chainId: number): ChainMeta {
    switch (chainId) {
        case 8453:
            return {
                id: 8453,
                name: 'Base',
                nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
            }
        case 84532:
            return {
                id: 84532,
                name: 'Base Sepolia',
                nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
            }
        case 137:
            return {
                id: 137,
                name: 'Polygon',
                nativeCurrency: { decimals: 18, name: 'POL', symbol: 'POL' },
            }
        case 42161:
            return {
                id: 42161,
                name: 'Arbitrum',
                nativeCurrency: { decimals: 18, name: 'ETH', symbol: 'ETH' },
            }
        case 31337:
            return {
                id: 31337,
                name: 'Anvil',
                nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
            }
        default:
            throw new Error(`Unsupported TEST_CHAIN_ID: ${chainId}`)
    }
}

async function bootstrapPrivyUserWithWallet(): Promise<PrivyBootstrap> {
    const explicitToken = process.env.PRIVY_TEST_ACCESS_TOKEN?.trim()

    const appId = requiredEnv('PRIVY_APP_ID')
    const appSecret = requiredEnv('PRIVY_APP_SECRET')

    const walletAuthorizationPrivateKey = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim()

    if (!walletAuthorizationPrivateKey) {
        throw new Error('Missing PRIVY_AUTHORIZATION_PRIVATE_KEY for Privy wallet signing flow')
    }

    const privy = new PrivyClient(appId, appSecret, {
        walletApi: { authorizationPrivateKey: walletAuthorizationPrivateKey },
    })

    const accessToken = explicitToken
        ? explicitToken
        : (
              await privy.getTestAccessToken(
                  process.env.PRIVY_TEST_EMAIL?.trim()
                      ? { email: process.env.PRIVY_TEST_EMAIL?.trim() }
                      : undefined,
              )
          ).accessToken

    let wallet: PrivyWalletInfo

    const explicitWalletId = process.env.PRIVY_TEST_WALLET_ID?.trim()

    if (explicitWalletId) {
        const candidate = await privy.walletApi.getWallet({ id: explicitWalletId })
        wallet = { id: candidate.id, address: parseAddr(candidate.address) }
    } else {
        // Create wallet under Wallet API ownership so the configured auth key can sign.
        const created = await privy.walletApi.createWallet({
            chainType: 'ethereum',
            policyIds: [],
        })

        wallet = { id: created.id, address: parseAddr(created.address) }
    }

    // Fail fast with an actionable error if the resolved wallet is not signable.
    try {
        await privy.walletApi.ethereum.signMessage({
            walletId: wallet.id,
            message: 'privy-signability-check',
        })
    } catch (error) {
        throw new Error(
            `Privy wallet ${wallet.id} is not signable with current credentials. Cause: ${
                error instanceof Error ? error.message : String(error)
            }`,
        )
    }

    return {
        privy,
        accessToken,
        wallet,
    }
}

function authSignatureFromRsv(input: {
    r: `0x${string}`
    s: `0x${string}`
    yParity: number
}): `0x${string}` {
    const parity = input.yParity >= 27 ? input.yParity - 27 : input.yParity

    return concat([input.r, input.s, toHex(parity, { size: 1 })])
}

function createPrivyTransport(token: string): JsonRpcTransport {
    return createJsonRpcTransport(requiredEnv('RELAYER_URL'), {
        httpAuth: { authToken: token },
    })
}

async function delegatePrivyWallet(params: {
    transport: JsonRpcTransport
    privy: PrivyClient
    wallet: PrivyWalletInfo
    chainId: number
    delegation: Address
}) {
    const prepared = await params.transport.request<{
        context: RpcUpgradeAccountContext
        typedData: RpcTypedDataPayload
    }>('wallet_prepareUpgradeAccount', {
        address: params.wallet.address,
        chainId: toHexChainId(params.chainId),
        delegation: params.delegation,
        capabilities: { authorizeKeys: [] },
    })

    const auth = await params.privy.walletApi.ethereum.sign7702Authorization({
        walletId: params.wallet.id,
        contract: params.delegation,
        chainId: params.chainId,
        nonce: prepared.context.authorization.nonce,
    })

    const execSignature =
        prepared.context.preCall.executionData !== '0x'
            ? (
                  await params.privy.walletApi.ethereum.signTypedData({
                      walletId: params.wallet.id,
                      typedData: {
                          domain: prepared.typedData.domain,
                          types: prepared.typedData.types,
                          message: prepared.typedData.message,
                          primaryType: prepared.typedData.primaryType,
                      },
                  })
              ).signature
            : '0x'

    const upgraded = await params.transport.request<{ success: boolean; txHash?: string }>(
        'wallet_upgradeAccount',
        {
            context: prepared.context,
            signatures: {
                auth: authSignatureFromRsv({ r: auth.r, s: auth.s, yParity: auth.yParity }),
                exec: execSignature,
            },
        },
    )

    expect(upgraded.success).toBe(true)

    if (upgraded.txHash) {
        expect(upgraded.txHash.startsWith('0x')).toBe(true)
    }
}

async function prepareAndSignWithPrivy(params: {
    transport: JsonRpcTransport
    privy: PrivyClient
    wallet: PrivyWalletInfo
    chainId: number
}): Promise<{ context: RpcPrepareCallsContext; signature: `0x${string}` }> {
    const noopCallData = encodeFunctionData({
        abi: getNonceAbi,
        functionName: 'getNonce',
        args: [0n],
    })

    const prepared = await params.transport.request<{
        context: RpcPrepareCallsContext
        typedData: RpcTypedDataPayload
    }>('wallet_prepareCalls', {
        from: params.wallet.address,
        chain_id: toHexChainId(params.chainId),
        calls: [{ to: params.wallet.address, value: '0x0', data: noopCallData }],
        capabilities: { meta: {} },
    })

    const signature = await params.privy.walletApi.ethereum.signTypedData({
        walletId: params.wallet.id,
        typedData: {
            domain: prepared.typedData.domain,
            types: prepared.typedData.types,
            message: prepared.typedData.message,
            primaryType: prepared.typedData.primaryType,
        },
    })

    return {
        context: prepared.context,
        signature: parseHex(signature.signature),
    }
}

async function createDelegatedErc8128Context() {
    const rpcUrl = requiredEnv('RPC_URL')
    const relayerUrl = requiredEnv('RELAYER_URL')
    const chainId = Number(process.env.TEST_CHAIN_ID)
    const delegation = requiredAddr('REMOTE_ACCOUNT_PROXY')

    const chainMeta = getChainMeta(chainId)
    const signerKey = generatePrivateKey()
    const account = privateKeyToAccount(signerKey)

    const client = createPublicClient({
        chain: {
            id: chainMeta.id,
            name: chainMeta.name,
            nativeCurrency: chainMeta.nativeCurrency,
            rpcUrls: { default: { http: [rpcUrl] } },
        },
        transport: http(rpcUrl),
    }).extend(
        relayerActions({
            relayerUrl,
            chainId,
            authSigner: {
                address: account.address,
                chainId,
                signMessage: (message: Uint8Array) =>
                    account.signMessage({ message: { raw: message } }),
            },
        }),
    )

    const upgraded = await client.upgradeAccount({
        accountAddress: account.address,
        signerKey,
        delegation,
    })

    expect(upgraded.success).toBe(true)

    const prepared = await client.prepareCalls({
        from: account.address,
        chainId,
        calls: [
            {
                target: account.address,
                value: 0n,
                data: encodeFunctionData({
                    abi: getNonceAbi,
                    functionName: 'getNonce',
                    args: [0n],
                }),
            },
        ],
    })

    const payloadSignature = await account.signTypedData({
        domain: prepared.typedData.domain,
        types: prepared.typedData.types,
        primaryType: prepared.typedData.primaryType,
        message: prepared.typedData.message,
    })

    const signer: EthHttpSigner = {
        chainId,
        address: account.address,
        signMessage: async (message) => account.signMessage({ message: { raw: toHex(message) } }),
    }

    return {
        chainId,
        account,
        signer,
        context: prepared.context,
        payloadSignature,
    }
}

describe('Remote Smoke: HTTP auth', () => {
    describe.skipIf(!hasPrivyEnv)('Privy', () => {
        it('authorized: delegated Privy wallet + valid bearer token calls wallet_sendPreparedCalls', async () => {
            const chainId = Number(process.env.TEST_CHAIN_ID)
            const delegation = requiredAddr('REMOTE_ACCOUNT_PROXY')

            const boot = await bootstrapPrivyUserWithWallet()
            const validTransport = createPrivyTransport(boot.accessToken)

            await delegatePrivyWallet({
                transport: validTransport,
                privy: boot.privy,
                wallet: boot.wallet,
                chainId,
                delegation,
            })

            const prepared = await prepareAndSignWithPrivy({
                transport: validTransport,
                privy: boot.privy,
                wallet: boot.wallet,
                chainId,
            })

            const result = await validTransport.request<{ id: string }>(
                'wallet_sendPreparedCalls',
                {
                    context: prepared.context,
                    signature: prepared.signature,
                },
            )

            expect(result.id.length).toBeGreaterThan(0)
        }, 120_000)

        it('unauthorized: delegated Privy wallet + invalid bearer token is rejected for wallet_sendPreparedCalls', async () => {
            const chainId = Number(process.env.TEST_CHAIN_ID)
            const delegation = requiredAddr('REMOTE_ACCOUNT_PROXY')

            const boot = await bootstrapPrivyUserWithWallet()
            const validTransport = createPrivyTransport(boot.accessToken)

            await delegatePrivyWallet({
                transport: validTransport,
                privy: boot.privy,
                wallet: boot.wallet,
                chainId,
                delegation,
            })

            const prepared = await prepareAndSignWithPrivy({
                transport: validTransport,
                privy: boot.privy,
                wallet: boot.wallet,
                chainId,
            })

            const invalidTransport = createPrivyTransport('invalid-privy-token')

            await expect(
                invalidTransport.request('wallet_sendPreparedCalls', {
                    context: prepared.context,
                    signature: prepared.signature,
                }),
            ).rejects.toMatchObject({ code: -32001, message: 'Unauthorized' })
        }, 120_000)
    })

    describe.skipIf(!hasErc8128Env)('ERC-8128', () => {
        it('authorized: valid ERC-8128 signature calls wallet_sendPreparedCalls', async () => {
            const delegated = await createDelegatedErc8128Context()

            const transport = createJsonRpcTransport(requiredEnv('RELAYER_URL'), {
                httpAuth: { signer: delegated.signer },
            })

            const result = await transport.request<{ id: string }>('wallet_sendPreparedCalls', {
                context: delegated.context,
                signature: delegated.payloadSignature,
            })

            expect(result.id.length).toBeGreaterThan(0)
        }, 120_000)

        it('unauthorized: invalid ERC-8128 signature is rejected for wallet_sendPreparedCalls', async () => {
            const delegated = await createDelegatedErc8128Context()
            const wrongKeyAccount = privateKeyToAccount(generatePrivateKey())

            const invalidSigner: EthHttpSigner = {
                chainId: delegated.chainId,
                address: delegated.account.address,
                signMessage: async (message) =>
                    wrongKeyAccount.signMessage({ message: { raw: toHex(message) } }),
            }

            const transport = createJsonRpcTransport(requiredEnv('RELAYER_URL'), {
                httpAuth: { signer: invalidSigner },
            })

            await expect(
                transport.request('wallet_sendPreparedCalls', {
                    context: delegated.context,
                    signature: delegated.payloadSignature,
                }),
            ).rejects.toMatchObject({ code: -32001, message: 'Unauthorized' })
        }, 120_000)
    })
})
