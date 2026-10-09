/**
 * Test 9: Owner & Agent Permissions
 *
 * Tests verify different ways to authorize keys on Account and how
 * signature verification works depending on whether the signer is an EOA or
 * a delegated account (smart contract).
 *
 * Background: When verifying signatures, Account checks if the signer
 * has bytecode:
 *   - EOA signer (no bytecode): Standard ECDSA recovery
 *   - Delegated signer (has bytecode): ERC-1271 isValidSignature() call
 *
 * For ERC-1271, the digest must be transformed to include the signer's address
 * for replay protection. The SDK's `computeErc1271Digest()` handles this.
 */

import { describe, it, expect } from 'vitest'
import {
    createWalletClient,
    erc20Abi,
    http,
    encodeAbiParameters,
    encodeFunctionData,
    parseEther,
    parseUnits,
    zeroAddress,
    concat,
    serializeSignature,
    type Address,
    type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts'
import { accountAbi, multiSigSignerAbi } from '@nubl/contracts/abis'

import {
    waitForBundle,
    computeKeyHash,
    computeErc1271Digest,
    encodeSecp256k1Key,
    wrapSignature,
    ANY_TARGET,
    EMPTY_CALLDATA_SELECTOR,
    ERC20_SELECTORS,
    type Permission,
} from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CONTRACTS, testChain } from '../setup'
import { setBalance, deal, getERC20Balance } from '../helpers/anvil'
import { createRelayerTestClient } from '../helpers/client'
import { optionalAddr, repeatedHex } from '../helpers/hex'
import { BASE_TOKENS } from '../helpers/tokens'

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface TestAccount {
    privateKey: Hex
    account: ReturnType<typeof privateKeyToAccount>
    address: Address
}

function createTestAccount(): TestAccount {
    const privateKey = generatePrivateKey()
    const account = privateKeyToAccount(privateKey)

    return { privateKey, account, address: account.address }
}

async function fundAccount(address: Address): Promise<void> {
    await setBalance(address, parseEther('1'))
}

function createSpendPermissions(spendLimit: bigint): Permission[] {
    return [
        { type: 'spend', token: zeroAddress, limit: spendLimit.toString(), period: 'day' },
        { type: 'call', to: ANY_TARGET, selector: EMPTY_CALLDATA_SELECTOR },
    ]
}

async function signErc1271Intent(
    digest: Hex,
    signerAddress: Address,
    signerPrivateKey: Hex,
    keyHash: Hex,
): Promise<Hex> {
    const erc1271Digest = computeErc1271Digest(digest, signerAddress)
    const signatureObj = await sign({ hash: erc1271Digest, privateKey: signerPrivateKey })
    const signature = serializeSignature(signatureObj)

    return wrapSignature(signature, keyHash)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Owner & Agent Permissions', () => {
    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })

    const contracts = TEST_CONTRACTS
    const recipient = '0x000000000000000000000000000000000000dEaD'

    // ─────────────────────────────────────────────────────────────────────
    // TEST 1: EOA Owner Controls Bot Account
    // ─────────────────────────────────────────────────────────────────────
    //
    // Scenario: A bot account is created with an external owner as superadmin.
    //           The owner is a plain EOA (not delegated).
    //
    // Setup:
    //   - Bot: Delegated account
    //   - Owner: Plain EOA (not delegated)
    //
    // Flow:
    //   1. Create bot account, authorize owner's address as admin (secp256k1 key)
    //   2. Owner signs intent with regular typedData signing + keyHash wrapping
    //   3. Signature verified via standard ECDSA (owner has no bytecode)
    //
    // Key point: Owner is EOA → no ERC-1271 needed → use regular signing + wrapSignature
    // ─────────────────────────────────────────────────────────────────────
    it(
        'should delegate a bot account and add owner as superadmin',
        { timeout: 30000 },
        async () => {
            // #given - bot and owner accounts
            const bot = createTestAccount()
            const owner = createTestAccount()
            await fundAccount(bot.address)

            const encodedOwnerPublicKey = encodeSecp256k1Key(owner.address)
            const ownerKeyHash = computeKeyHash('secp256k1', encodedOwnerPublicKey)

            // #when - delegate bot with owner as admin
            const result = await client.upgradeAccount({
                accountAddress: bot.address,
                signerKey: bot.privateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'admin',
                        publicKey: encodedOwnerPublicKey,
                        permissions: [],
                    },
                ],
            })

            expect(result.success).toBe(true)

            // #then - verify owner key is registered as superadmin
            const keyCount = await client.readContract({
                address: bot.address,
                abi: accountAbi,
                functionName: 'keyCount',
            })

            expect(keyCount).toBe(1n)

            const [keys, keyHashes] = await client.readContract({
                address: bot.address,
                abi: accountAbi,
                functionName: 'getKeys',
            })

            const ownerIndex = keyHashes.findIndex((hash) => hash === ownerKeyHash)
            expect(ownerIndex).toBeGreaterThan(-1)
            expect(keys[ownerIndex].isSuperAdmin).toBe(true)

            // #when - owner signs intent for bot account
            const transferAmount = parseEther('0.01')
            const balanceBefore = await client.getBalance({ address: bot.address })

            // Prepare the intent
            const prepared = await client.prepareCalls({
                from: bot.address,
                calls: [{ target: recipient, value: transferAmount, data: '0x' }],
            })

            // Owner signs with their wallet
            const ownerWallet = createWalletClient({
                account: owner.account,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            const rawSignature = await ownerWallet.signTypedData({
                domain: prepared.typedData.domain,
                types: prepared.typedData.types,
                primaryType: prepared.typedData.primaryType,
                message: prepared.typedData.message,
            })

            // Wrap signature with keyHash (owner is EOA, so no ERC-1271 transform needed)
            const wrappedSignature = wrapSignature(rawSignature, ownerKeyHash)

            const submit = await client.sendPreparedCalls({
                context: prepared.context,
                signature: wrappedSignature,
            })

            expect(submit.id).toBeDefined()

            const status = await waitForBundle(client, { id: submit.id })
            expect(status.statusCode).toBe(200)

            // #then - verify transfer succeeded
            const balanceAfter = await client.getBalance({ address: bot.address })
            expect(balanceAfter).toBe(balanceBefore - transferAmount)
        },
    )

    // ─────────────────────────────────────────────────────────────────────
    // TEST 2: Delegated Bot with Limited Permissions on User Account
    // ─────────────────────────────────────────────────────────────────────
    //
    // Scenario: User grants a third-party bot limited spending permissions.
    //           The bot is a delegated account (smart contract).
    //
    // Setup:
    //   - User: Delegated account (owns funds)
    //   - Bot: Delegated account (authorized with spend limits)
    //
    // Flow:
    //   1. Delegate bot account (now has bytecode)
    //   2. Delegate user account, authorize bot with spend permissions
    //   3. Bot signs with ERC-1271 digest transform + wrapSignature
    //   4. Signature verified via ERC-1271 (bot has bytecode)
    //
    // Key point: Bot is delegated → must use computeErc1271Digest + wrapSignature
    // ─────────────────────────────────────────────────────────────────────
    it(
        'should allow a user to grant a third-party bot limited ETH spend permissions',
        { timeout: 60000 },
        async () => {
            // #given - delegated bot
            const bot = createTestAccount()
            await fundAccount(bot.address)

            const botDelegation = await client.upgradeAccount({
                accountAddress: bot.address,
                signerKey: bot.privateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [],
            })

            expect(botDelegation.success).toBe(true)

            // #given - user grants bot limited spend permissions
            const user = createTestAccount()
            await fundAccount(user.address)
            const encodedBotPublicKey = encodeSecp256k1Key(bot.address)
            const botKeyHash = computeKeyHash('secp256k1', encodedBotPublicKey)
            const spendLimit = parseEther('0.05')

            const userDelegation = await client.upgradeAccount({
                accountAddress: user.address,
                signerKey: user.privateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'normal',
                        publicKey: encodedBotPublicKey,
                        permissions: createSpendPermissions(spendLimit),
                    },
                ],
            })

            expect(userDelegation.success).toBe(true)

            // #when - bot signs intent for user account using ERC-1271 transform
            const transferAmount = parseEther('0.02')
            const balanceBefore = await client.getBalance({ address: user.address })

            // Prepare the intent for user's account
            const prepared = await client.prepareCalls({
                from: user.address,
                calls: [{ target: recipient, value: transferAmount, data: '0x' }],
            })

            // Bot is delegated, so must use ERC-1271 digest transform
            const wrappedSignature = await signErc1271Intent(
                prepared.digest,
                bot.address,
                bot.privateKey,
                botKeyHash,
            )

            const submit = await client.sendPreparedCalls({
                context: prepared.context,
                signature: wrappedSignature,
            })

            expect(submit.id).toBeDefined()

            const status = await waitForBundle(client, { id: submit.id })
            expect(status.statusCode).toBe(200)

            // #then - verify transfer succeeded
            const balanceAfter = await client.getBalance({ address: user.address })
            expect(balanceAfter).toBe(balanceBefore - transferAmount)
        },
    )

    // ─────────────────────────────────────────────────────────────────────
    // TEST 3: Delegated Agent Acts on Behalf of Delegated User
    // ─────────────────────────────────────────────────────────────────────
    //
    // Scenario: Both user and agent are delegated accounts. Agent has limited
    //           permissions to act on user's behalf.
    //
    // Setup:
    //   - User: Delegated account (owns funds)
    //   - Agent: Delegated account (authorized with spend limits)
    //
    // Flow:
    //   1. Delegate both user and agent accounts
    //   2. User authorizes agent with spend permissions
    //   3. Agent signs with ERC-1271 digest transform + wrapSignature
    //   4. Signature verified via ERC-1271
    //
    // Key point: Same as Test 2, but emphasizes agent-based automation patterns
    // ─────────────────────────────────────────────────────────────────────
    it(
        'should allow a delegated agent to act on behalf of another delegated account',
        { timeout: 60000 },
        async () => {
            // #given - both user and agent are delegated
            const user = createTestAccount()
            const agent = createTestAccount()
            await Promise.all([fundAccount(user.address), fundAccount(agent.address)])

            const userDelegation = await client.upgradeAccount({
                accountAddress: user.address,
                signerKey: user.privateKey,
                delegation: contracts.accountProxy,
            })

            expect(userDelegation.success).toBe(true)

            const agentDelegation = await client.upgradeAccount({
                accountAddress: agent.address,
                signerKey: agent.privateKey,
                delegation: contracts.accountProxy,
            })

            expect(agentDelegation.success).toBe(true)

            // #given - user authorizes agent with spend permissions
            const encodedAgentPublicKey = encodeSecp256k1Key(agent.address)
            const agentKeyHash = computeKeyHash('secp256k1', encodedAgentPublicKey)
            const spendLimit = parseEther('0.05')

            const authorizeAgent = await client.upgradeAccount({
                accountAddress: user.address,
                signerKey: user.privateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'normal',
                        publicKey: encodedAgentPublicKey,
                        permissions: createSpendPermissions(spendLimit),
                    },
                ],
            })

            expect(authorizeAgent.success).toBe(true)

            // #when - agent signs intent for user using ERC-1271 transform
            const transferAmount = parseEther('0.02')
            const balanceBefore = await client.getBalance({ address: user.address })

            // Prepare the intent for user's account
            const prepared = await client.prepareCalls({
                from: user.address,
                calls: [{ target: recipient, value: transferAmount, data: '0x' }],
            })

            // Agent is delegated, so must use ERC-1271 digest transform
            const wrappedSignature = await signErc1271Intent(
                prepared.digest,
                agent.address,
                agent.privateKey,
                agentKeyHash,
            )

            const submit = await client.sendPreparedCalls({
                context: prepared.context,
                signature: wrappedSignature,
            })

            expect(submit.id).toBeDefined()

            const status = await waitForBundle(client, { id: submit.id })
            expect(status.statusCode).toBe(200)

            // #then - verify transfer succeeded
            const balanceAfter = await client.getBalance({ address: user.address })
            expect(balanceAfter).toBe(balanceBefore - transferAmount)
        },
    )

    // ─────────────────────────────────────────────────────────────────────
    // TEST 4: Authorize Delegated Session Key via Intent
    // ─────────────────────────────────────────────────────────────────────
    //
    // Scenario: User and session key are both delegated. User adds the session
    //           key AFTER delegation by creating a normal intent that calls
    //           authorize().
    //
    // Setup:
    //   - User: Delegated account (owns funds)
    //   - Session key: Delegated account (has bytecode)
    //
    // Flow:
    //   1. Delegate user and session key
    //   2. User prepares an intent that calls Account.authorize(sessionKey)
    //   3. User signs and submits intent (regular EIP-712 signing)
    //   4. Verify key shows up on-chain
    //
    // Key point: "authorize-only" path via prepareCalls/sendPreparedCalls,
    //            not upgradeAccount.
    // ─────────────────────────────────────────────────────────────────────
    it(
        'should allow a user to authorize a delegated session key via intent',
        { timeout: 60000 },
        async () => {
            // #given - user and session key are both delegated
            const user = createTestAccount()
            const sessionKey = createTestAccount()
            await Promise.all([fundAccount(user.address), fundAccount(sessionKey.address)])

            const userDelegation = await client.upgradeAccount({
                accountAddress: user.address,
                signerKey: user.privateKey,
                delegation: contracts.accountProxy,
            })

            expect(userDelegation.success).toBe(true)

            const sessionDelegation = await client.upgradeAccount({
                accountAddress: sessionKey.address,
                signerKey: sessionKey.privateKey,
                delegation: contracts.accountProxy,
            })

            expect(sessionDelegation.success).toBe(true)

            // #when - user signs intent to authorize the session key
            const encodedSessionPublicKey = encodeSecp256k1Key(sessionKey.address)
            const sessionKeyHash = computeKeyHash('secp256k1', encodedSessionPublicKey)

            const authorizeData = encodeFunctionData({
                abi: accountAbi,
                functionName: 'authorize',
                args: [
                    {
                        expiry: 0,
                        keyType: 0, // secp256k1
                        isSuperAdmin: false,
                        publicKey: encodedSessionPublicKey,
                    },
                ],
            })

            const prepared = await client.prepareCalls({
                from: user.address,
                calls: [{ target: user.address, value: 0n, data: authorizeData }],
            })

            const userWallet = createWalletClient({
                account: user.account,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            const signature = await userWallet.signTypedData({
                domain: prepared.typedData.domain,
                types: prepared.typedData.types,
                primaryType: prepared.typedData.primaryType,
                message: prepared.typedData.message,
            })

            const submit = await client.sendPreparedCalls({
                context: prepared.context,
                signature,
            })

            expect(submit.id).toBeDefined()

            const status = await waitForBundle(client, { id: submit.id })
            expect(status.statusCode).toBe(200)

            // #then - verify session key is registered
            const keyCount = await client.readContract({
                address: user.address,
                abi: accountAbi,
                functionName: 'keyCount',
            })

            expect(keyCount).toBe(1n)

            const [keys, keyHashes] = await client.readContract({
                address: user.address,
                abi: accountAbi,
                functionName: 'getKeys',
            })

            const sessionIndex = keyHashes.findIndex((hash) => hash === sessionKeyHash)
            expect(sessionIndex).toBeGreaterThan(-1)
            expect(keys[sessionIndex].isSuperAdmin).toBe(false)
        },
    )

    // ─────────────────────────────────────────────────────────────────────
    // TEST 5: Delegated Owner via MultiSigSigner
    //
    // Scenario: A "bot account" (botEoa) needs the owner added as a superadmin.
    //           The owner is delegated, so Account calls ERC-1271 on the
    //           owner's account — which itself is an Account. That creates
    //           infinite recursion because isValidSignature wraps the digest
    //           again and again.
    //
    // Solution: Use MultiSigSigner as a wrapper around the owner's Account.
    //           MultiSigSigner.isValidSignature() verifies the inner signature
    //           directly without re-wrapping the digest.
    //
    // Nested signature structure (outer → inner):
    //   ┌─ botEoa.Account.isValidSignature(botDigest, outerSig)
    //   │    outerSig = abi.encode(ownerKeyHash, innerSig)
    //   │
    //   └─→ multiSigSigner.isValidSignature(botDigest, innerSig)
    //          innerSig = abi.encode(ownerKeyHash, ecdsaSig)
    //          verifies: ecrecover(ownerDigest, ecdsaSig) == owner
    //          where ownerDigest = computeErc1271Digest(owner, botDigest)
    //
    // Flow:
    //   1. Delegate owner, deploy MultiSigSigner pointed at owner
    //   2. Fund botEoa and delegate it
    //   3. Add multiSigSigner as superadmin key on botEoa
    //   4. Prepare intent on botEoa
    //   5. Build nested signature (ECDSA → MultiSigSigner → botEoa)
    //   6. Submit and verify
    //
    // Key point: MultiSigSigner breaks the recursion by forwarding digest
    //            verification without the double-wrapping that Account does.
    // ─────────────────────────────────────────────────────────────────────
    it(
        'should delegate owner then add owner as superadmin for a bot account',
        { timeout: 30000 },
        async () => {
            // #given - owner is delegated
            const owner = createTestAccount()
            await fundAccount(owner.address)

            const ownerDelegation = await client.upgradeAccount({
                accountAddress: owner.address,
                signerKey: owner.privateKey,
                delegation: contracts.accountProxy,
            })

            expect(ownerDelegation.success).toBe(true)

            // #given - bot delegated with MultiSigSigner + owner keys
            const bot = createTestAccount()
            await fundAccount(bot.address)

            const chainId = testChain.id
            const chainScopedMultiSigKey = `MULTI_SIG_SIGNER_${chainId}`

            const multiSigSigner =
                optionalAddr(process.env[chainScopedMultiSigKey]) ??
                optionalAddr(process.env.MULTI_SIG_SIGNER)

            expect(multiSigSigner).toBeDefined()

            if (!multiSigSigner) {
                throw new Error('MULTI_SIG_SIGNER is required')
            }

            const encodedOwnerPublicKey = encodeSecp256k1Key(owner.address)
            const multiSigPublicKey = concat([multiSigSigner, repeatedHex('00', 12)])
            const externalKeyHash = computeKeyHash('external', multiSigPublicKey)
            const ownerKeyHash = computeKeyHash('secp256k1', encodedOwnerPublicKey)

            const botDelegation = await client.upgradeAccount({
                accountAddress: bot.address,
                signerKey: bot.privateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'external',
                        role: 'admin',
                        publicKey: multiSigPublicKey,
                        permissions: [],
                    },
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'normal',
                        publicKey: encodedOwnerPublicKey,
                        permissions: [],
                    },
                ],
            })

            expect(botDelegation.success).toBe(true)

            // #when - initialize MultiSigSigner config
            const initConfigData = encodeFunctionData({
                abi: multiSigSignerAbi,
                functionName: 'initConfig',
                args: [externalKeyHash, 1n, [ownerKeyHash]],
            })

            // Prepare and sign the init config call
            const initPrepared = await client.prepareCalls({
                from: bot.address,
                calls: [{ target: multiSigSigner!, value: 0n, data: initConfigData }],
            })

            const botWallet = createWalletClient({
                account: bot.account,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            const initSignature = await botWallet.signTypedData({
                domain: initPrepared.typedData.domain,
                types: initPrepared.typedData.types,
                primaryType: initPrepared.typedData.primaryType,
                message: initPrepared.typedData.message,
            })

            const initConfigSubmit = await client.sendPreparedCalls({
                context: initPrepared.context,
                signature: initSignature,
            })

            expect(initConfigSubmit.id).toBeDefined()

            const initConfigStatus = await waitForBundle(client, { id: initConfigSubmit.id })
            expect(initConfigStatus.statusCode).toBe(200)

            // #when - owner signs transfer via external key (nested signature)
            const transferAmount = parseEther('0.01')
            const balanceBefore = await client.getBalance({ address: bot.address })

            const prepared = await client.prepareCalls({
                from: bot.address,
                calls: [{ target: recipient, value: transferAmount, data: '0x' }],
            })

            // Owner is delegated, so must use ERC-1271 digest transform for inner signature
            const ownerWrappedSignature = await signErc1271Intent(
                prepared.digest,
                owner.address,
                owner.privateKey,
                ownerKeyHash,
            )

            // Wrap in external signature format
            const signaturesEncoded = encodeAbiParameters(
                [{ type: 'bytes[]' }],
                [[ownerWrappedSignature]],
            )

            const externalSignature = concat([signaturesEncoded, externalKeyHash, '0x00'])

            const submit = await client.sendPreparedCalls({
                context: prepared.context,
                signature: externalSignature,
            })

            expect(submit.id).toBeDefined()

            const status = await waitForBundle(client, { id: submit.id })
            expect(status.statusCode).toBe(200)

            // #then - verify transfer succeeded
            const balanceAfter = await client.getBalance({ address: bot.address })
            expect(balanceAfter).toBe(balanceBefore - transferAmount)
        },
    )

    // ─────────────────────────────────────────────────────────────────────
    // TEST 6: Post-Delegation Session Key with ERC20 Spend Permissions
    // ─────────────────────────────────────────────────────────────────────
    //
    // Scenario: User and session key are BOTH delegated accounts. After
    // delegation, the user authorizes the session key with scoped USDC
    // permissions via a batched intent (not during upgradeAccount).
    // The session key then signs a USDC transfer on the user's behalf.
    //
    // This differs from Tests 2/3 (which use upgradeAccount's authorizeKeys)
    // by exercising the post-delegation authorization path:
    //   authorize() + setSpendLimit() + setCanExecute()
    //
    // Setup:
    //   - User: Delegated account (owns USDC)
    //   - Session key: Delegated account (authorized after delegation)
    //
    // Flow:
    //   1. Delegate both accounts (no keys attached)
    //   2. User sends batched intent with 3 self-calls:
    //      - authorize(sessionKey) → registers the key on-chain
    //      - setSpendLimit(keyHash, USDC, Day, 100 USDC) → daily cap
    //      - setCanExecute(keyHash, USDC, transfer selector, true) → whitelist
    //   3. Verify key is registered via getKeys()
    //   4. Session key prepares USDC transfer from user's account
    //   5. Session key signs with ERC-1271 digest transform (has bytecode)
    //   6. Relayer executes; GuardedExecutor enforces spend + call limits
    //
    // Why ERC-1271: Session key is delegated → has bytecode → Account
    // calls sessionKey.isValidSignature() instead of ECDSA recovery.
    // computeErc1271Digest() transforms the digest to include the signer's
    // address for cross-account replay protection.
    // ─────────────────────────────────────────────────────────────────────
    it(
        'should allow a session key with USDC spend permissions to transfer on behalf of user',
        { timeout: 60000 },
        async () => {
            const USDC = BASE_TOKENS.USDC
            const USDC_UNITS = 6
            const usdcAmount = parseUnits('100', USDC_UNITS)
            const transferAmount = parseUnits('10', USDC_UNITS)
            const SPEND_PERIOD_DAY = 2 // GuardedExecutor.SpendPeriod.Day

            // Step 1: Create and delegate both accounts (no keys during upgrade)
            const user = createTestAccount()
            const sessionKey = createTestAccount()
            await Promise.all([fundAccount(user.address), fundAccount(sessionKey.address)])

            const userDelegation = await client.upgradeAccount({
                accountAddress: user.address,
                signerKey: user.privateKey,
                delegation: contracts.accountProxy,
            })

            expect(userDelegation.success).toBe(true)

            const sessionDelegation = await client.upgradeAccount({
                accountAddress: sessionKey.address,
                signerKey: sessionKey.privateKey,
                delegation: contracts.accountProxy,
            })

            expect(sessionDelegation.success).toBe(true)

            // Step 2: User authorizes session key via batched self-calls
            // All 3 calls target user.address because authorize/setSpendLimit/setCanExecute
            // are onlyThis functions — the account must call itself through execute()
            const encodedSessionPublicKey = encodeSecp256k1Key(sessionKey.address)
            const sessionKeyHash = computeKeyHash('secp256k1', encodedSessionPublicKey)

            const authorizeCalls = [
                // 2a: Register session key as a normal (non-admin) secp256k1 key
                {
                    target: user.address,
                    value: 0n,
                    data: encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'authorize',
                        args: [
                            {
                                expiry: 0,
                                keyType: 0, // secp256k1
                                isSuperAdmin: false,
                                publicKey: encodedSessionPublicKey,
                            },
                        ],
                    }),
                },
                // 2b: Set daily USDC spend limit for this key
                {
                    target: user.address,
                    value: 0n,
                    data: encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'setSpendLimit',
                        args: [sessionKeyHash, USDC, SPEND_PERIOD_DAY, usdcAmount],
                    }),
                },
                // 2c: Whitelist USDC.transfer() calls for this key
                {
                    target: user.address,
                    value: 0n,
                    data: encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'setCanExecute',
                        args: [sessionKeyHash, USDC, ERC20_SELECTORS.TRANSFER, true],
                    }),
                },
            ]

            // User signs the batched authorize intent (superadmin of own account)
            const authPrepared = await client.prepareCalls({
                from: user.address,
                calls: authorizeCalls,
            })

            const userWallet = createWalletClient({
                account: user.account,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            const authSignature = await userWallet.signTypedData({
                domain: authPrepared.typedData.domain,
                types: authPrepared.typedData.types,
                primaryType: authPrepared.typedData.primaryType,
                message: authPrepared.typedData.message,
            })

            const authSubmit = await client.sendPreparedCalls({
                context: authPrepared.context,
                signature: authSignature,
            })

            expect(authSubmit.id).toBeDefined()

            const authStatus = await waitForBundle(client, { id: authSubmit.id })
            expect(authStatus.statusCode).toBe(200)

            // Step 3: Verify session key is registered on-chain
            const [, keyHashes] = await client.readContract({
                address: user.address,
                abi: accountAbi,
                functionName: 'getKeys',
            })

            expect(keyHashes).toContain(sessionKeyHash)

            // Step 4: Fund user with USDC and record balances
            await deal(user.address, USDC, usdcAmount)
            const usdcBefore = await getERC20Balance(USDC, user.address)
            const recipientUsdcBefore = await getERC20Balance(USDC, recipient)

            // Step 5: Session key signs USDC transfer on behalf of user
            // Pass the session key info so the relayer simulates with the correct
            // keyHash, measuring GuardedExecutor's spend-limit overhead in combinedGas.
            const prepared = await client.prepareCalls({
                from: user.address,
                sessionKey: encodedSessionPublicKey,
                calls: [
                    {
                        target: USDC,
                        value: 0n,
                        data: encodeFunctionData({
                            abi: erc20Abi,
                            functionName: 'transfer',
                            args: [recipient, transferAmount],
                        }),
                    },
                ],
            })

            // Session key is delegated (has bytecode) → Account verifies via
            // ERC-1271 isValidSignature() instead of ECDSA. Must transform the digest
            // to include signer address, then wrap with keyHash for key lookup.
            const wrappedSignature = await signErc1271Intent(
                prepared.digest,
                sessionKey.address,
                sessionKey.privateKey,
                sessionKeyHash,
            )

            const submit = await client.sendPreparedCalls({
                context: prepared.context,
                signature: wrappedSignature,
            })

            expect(submit.id).toBeDefined()

            const status = await waitForBundle(client, { id: submit.id })
            expect(status.statusCode).toBe(200)

            // Step 6: Verify USDC moved from user to recipient
            const usdcAfter = await getERC20Balance(USDC, user.address)
            const recipientUsdcAfter = await getERC20Balance(USDC, recipient)
            expect(usdcAfter).toBe(usdcBefore - transferAmount)
            expect(recipientUsdcAfter).toBe(recipientUsdcBefore + transferAmount)
        },
    )
})
