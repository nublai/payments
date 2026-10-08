import { describe, expect, it } from 'vitest'
import { createWalletClient, encodeAbiParameters, http, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
    computeKeyHash,
    createRelayerClient,
    encodeSecp256k1Key,
    executePreparedCalls,
    findAuthorizedKey,
    getChainKeys,
} from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CONTRACTS, testChain } from '../setup'
import { setBalance } from '../helpers/anvil'

describe('Helper workflow API', () => {
    const contracts = TEST_CONTRACTS

    it(
        'executes prepare -> sign -> send -> wait via executePreparedCalls helper',
        { timeout: 30000 },
        async () => {
            const signerKey = generatePrivateKey()
            const account = privateKeyToAccount(signerKey)
            const initialBalance = parseEther('10')
            await setBalance(account.address, initialBalance)

            const authClient = createRelayerClient({
                chainId: testChain.id,
                rpcUrl: ANVIL_RPC_URL,
                relayerUrl: RELAYER_URL,
                authSigner: {
                    address: account.address,
                    chainId: testChain.id,
                    signMessage: (message: Uint8Array) =>
                        account.signMessage({ message: { raw: message } }),
                },
            })

            const upgrade = await authClient.upgradeAccount({
                accountAddress: account.address,
                signerKey,
                delegation: contracts.accountProxy,
            })

            expect(upgrade.success).toBe(true)

            const walletClient = createWalletClient({
                account,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            const transferAmount = parseEther('1')

            const execution = await executePreparedCalls({
                client: authClient,
                from: account.address,
                calls: [
                    {
                        target: '0x000000000000000000000000000000000000dEaD',
                        value: transferAmount,
                        data: '0x',
                    },
                ],
                signer: {
                    type: 'typedData',
                    signTypedData: (typedData) => walletClient.signTypedData(typedData),
                },
            })

            expect(execution.id).toBeDefined()
            expect(execution.finalStatus?.status).toBe('confirmed')

            const finalBalance = await authClient.getBalance({ address: account.address })
            expect(finalBalance).toBe(initialBalance - transferAmount)
        },
    )

    it(
        'selects chain keys and authorized key with helper utilities',
        { timeout: 30000 },
        async () => {
            const ownerKey = generatePrivateKey()
            const owner = privateKeyToAccount(ownerKey)
            const signerKey = generatePrivateKey()
            const signer = privateKeyToAccount(signerKey)
            await setBalance(owner.address, parseEther('1'))

            const authClient = createRelayerClient({
                chainId: testChain.id,
                rpcUrl: ANVIL_RPC_URL,
                relayerUrl: RELAYER_URL,
                authSigner: {
                    address: owner.address,
                    chainId: testChain.id,
                    signMessage: (message: Uint8Array) =>
                        owner.signMessage({ message: { raw: message } }),
                },
            })

            const signerPublicKey = encodeAbiParameters([{ type: 'address' }], [signer.address])
            const signerKeyHash = computeKeyHash('secp256k1', signerPublicKey)

            const upgrade = await authClient.upgradeAccount({
                accountAddress: owner.address,
                signerKey: ownerKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'admin',
                        publicKey: encodeSecp256k1Key(signer.address),
                        permissions: [],
                    },
                ],
            })

            expect(upgrade.success).toBe(true)

            await new Promise((resolve) => setTimeout(resolve, 2_000))

            const keys = await authClient.getKeys({ address: owner.address })
            const chainKeys = getChainKeys(keys, testChain.id)
            expect(chainKeys.length).toBeGreaterThan(0)

            const authorized = findAuthorizedKey(keys, testChain.id, signerKeyHash)
            expect(authorized).toBeDefined()
        },
    )
})
