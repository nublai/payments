/**
 * Local Anvil proof of a USDC-paid first EIP-7702 upgrade.
 *
 * Starts anvil on 18547 (not 8545), deploys the local contracts, and calls
 * handlePrepareCalls / handleSendPreparedCalls. The signer pool is a stub that
 * applies the same per-address buckets and broadcasts Orchestrator.execute
 * with the quoted authorization list.
 *
 * Run from packages/relayer: bun ./test/integration/paid-upgrade-anvil.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    createPublicClient,
    createWalletClient,
    decodeEventLog,
    encodeAbiParameters,
    encodeFunctionData,
    erc20Abi,
    http,
    zeroAddress,
    type Account,
    type Address,
    type Hex,
    type PublicClient,
    type TransactionReceipt,
    type Transport,
    type WalletClient,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { hashAuthorization } from 'viem/utils'
import { accountAbi, orchestratorAbi } from '@nubl/contracts/abis'

import { handlePrepareCalls } from '../../src/rpc/methods/prepareCalls'
import { handleSendPreparedCalls } from '../../src/rpc/methods/sendPreparedCalls'
import type { RpcContext } from '../../src/rpc/types'
import type { Env } from '../../src/types/env'
import type { ExecuteIntentTransaction } from '../../src/types/pool'
import { RelayerService } from '../../src/services/relayer'
import { logger } from '../../src/lib/logger'
import { encodeIntentCalldata } from '../../src/services/encode-intent'
import { getPaymentRecipient } from '../../src/services/fees'
import { getChainConfig } from '../../src/config'
import {
    buildKeyInitializationData,
    computeKeyHash,
    getSignedCallDomain,
    SIGNED_CALL_TYPES,
    UPGRADE_PRECALL_NONCE,
} from '../../src/rpc/methods/shared/account-helpers'
import {
    eip7702DelegationCode,
    PAID_UPGRADE_AUTHORIZATION_GAS,
    PAID_UPGRADE_GAS_HOLD,
    paidUpgradeRateBuckets,
    paidUpgradeSignedGas,
} from '../../src/rpc/methods/shared/paid-upgrade'
import {
    consumeRateLimit,
    peekRateLimit,
    releaseRateLimit,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'
import {
    ACCOUNT_UPGRADE_MAX_FEE_PER_GAS,
    ACCOUNT_UPGRADE_MAX_PRIORITY_FEE_PER_GAS,
} from '../../src/rpc/methods/shared/upgrade-gas'

const PORT = 18547

const CHAIN_ID = 31337

const RPC_URL = `http://127.0.0.1:${PORT}`

const DEPLOYER_KEY =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex

const RELAYER_KEY =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

const here = path.dirname(fileURLToPath(import.meta.url))

const repoRoot = path.resolve(here, '../../../..')

const contractsRoot = path.join(repoRoot, 'packages/contracts')

const deploymentDir = path.join(contractsRoot, 'deployments/envs/local', String(CHAIN_ID))

const chain = {
    id: CHAIN_ID,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
} as const

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function readAddress(name: string): Address {
    const file = path.join(deploymentDir, `${name}.json`)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { address?: string }
    assert(parsed.address, `missing address in ${file}`)

    return parsed.address as Address
}

async function waitForChain(publicClient: PublicClient): Promise<void> {
    let last = 'anvil not ready'

    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            const id = await publicClient.getChainId()
            assert(id === CHAIN_ID, `unexpected chain ${id}`)

            return
        } catch (error) {
            last = error instanceof Error ? error.message : String(error)
            await sleep(200)
        }
    }

    throw new Error(last)
}

function run(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: 'inherit' })
        child.on('error', reject)
        child.on('exit', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
        })
    })
}

function cleanupDeployArtifacts(): void {
    if (existsSync(deploymentDir)) rmSync(deploymentDir, { recursive: true, force: true })
    const broadcastRoot = path.join(contractsRoot, 'broadcast')

    if (!existsSync(broadcastRoot)) return

    for (const script of readdirSync(broadcastRoot)) {
        const chainDir = path.join(broadcastRoot, script, String(CHAIN_ID))

        if (existsSync(chainDir)) rmSync(chainDir, { recursive: true, force: true })
    }
}

async function main(): Promise<void> {
    const anvil: ChildProcess = spawn(
        'anvil',
        ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--base-fee', '1000000000'],
        { stdio: 'ignore' },
    )

    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) })
    const deployer = privateKeyToAccount(DEPLOYER_KEY)
    const relayer = privateKeyToAccount(RELAYER_KEY)
    const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC_URL) })
    const relayerWallet = createWalletClient({ account: relayer, chain, transport: http(RPC_URL) })
    const rateStore = new Map<string, number>()

    const gasState: { spent: bigint; held: bigint; failures: number } = {
        spent: 0n,
        held: 0n,
        failures: 0,
    }

    const broadcastPlan: {
        sweepOwner?: Address
        beforeBroadcast?: () => Promise<void>
        expectSuccess?: boolean
    } = {}

    const receipts: TransactionReceipt[] = []

    try {
        await waitForChain(publicClient)
        await run(
            path.join(contractsRoot, 'scripts/sh/deploy.sh'),
            ['--chain', String(CHAIN_ID), '--rpc', RPC_URL, '--context', 'local', '--skip-relayer'],
            contractsRoot,
        )
        assert(existsSync(deploymentDir), `deploy did not write ${deploymentDir}`)
        const written = readdirSync(deploymentDir)
        assert(written.length > 0, `empty deployment dir ${deploymentDir}: ${written.join(',')}`)

        const accountProxy = readAddress('accountProxy')
        const orchestrator = readAddress('orchestrator')

        const env = {
            RPC_URL,
            RPC_31337: RPC_URL,
            CHAIN_IDS: String(CHAIN_ID),
            CONTEXT: 'local',
            PAID_UPGRADE_ENABLED: 'true',
            RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
            RELAYER_COUNT: '1',
            QUOTE_SIGNING_SECRET: 'paid-upgrade-anvil',
            COINGECKO_API_URL: 'http://127.0.0.1:1',
            ORCHESTRATOR_31337: orchestrator,
            SIMPLE_FUNDER_31337: readAddress('simpleFunder'),
            SIMULATOR_31337: readAddress('simulator'),
            ACCOUNT_31337: readAddress('account'),
            ACCOUNT_PROXY_31337: accountProxy,
            SIMPLE_SETTLER_31337: readAddress('simpleSettler'),
            ESCROW_31337: readAddress('escrow'),
            MULTI_SIG_SIGNER_31337: readAddress('multiSigSigner'),
            INTENT_NONCE_MANAGER: {
                idFromName: () => 'nonce',
                get: () => ({
                    fetch: async () => {
                        throw new Error('nonce manager should not be called')
                    },
                }),
            },
            SIGNER_POOL: {
                idFromName: () => 'pool',
                get: () => ({
                    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                        const url =
                            typeof input === 'string'
                                ? input
                                : input instanceof Request
                                  ? input.url
                                  : String(input)

                        const body = JSON.parse(String(init?.body ?? '{}')) as {
                            action?: string
                            chainId?: number
                            account?: string
                            ip?: string
                            reservedAt?: number
                            type?: string
                            gas?: string
                            hold?: string
                            failure?: boolean
                        }

                        if (url.includes('upgrade-rate-limit')) {
                            if (
                                body.action === 'reserve-gas' ||
                                body.action === 'release-gas' ||
                                body.action === 'settle-gas'
                            ) {
                                return json(applyAnvilGas(gasState, body))
                            }

                            const now = Math.floor(Date.now() / 1000)

                            const buckets = paidUpgradeRateBuckets({
                                chainId: body.chainId ?? CHAIN_ID,
                                account: body.account ?? 'unknown',
                                ip: typeof body.ip === 'string' ? body.ip : 'unknown',
                                includeGlobal: body.action === 'reserve' || body.action === 'release',
                            })

                            if (body.action === 'peek') {
                                return json({
                                    allowed: peekRateLimit(rateStore, buckets, now).allowed,
                                })
                            }

                            if (body.action === 'release') {
                                releaseRateLimit(rateStore, buckets, body.reservedAt ?? now)

                                return json({ allowed: true })
                            }

                            const decision = consumeRateLimit(rateStore, buckets, now)

                            return json({ allowed: decision.allowed, reservedAt: now })
                        }

                        if (body.type !== 'execute-intent') {
                            return json({ error: `unexpected tx ${body.type}` }, false)
                        }

                        try {
                            const hash = await broadcastPaidUpgrade(
                                publicClient,
                                body as ExecuteIntentTransaction,
                                orchestrator,
                                relayerWallet,
                                broadcastPlan,
                                receipts,
                            )

                            return json({
                                txHash: hash,
                                signer: relayer.address,
                                signerName: 'signer-31337-0',
                            })
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error)

                            return json({ error: message, broadcastAttempted: false }, false)
                        }
                    },
                }),
            },
        } as unknown as Env

        const ctx: RpcContext = { env }
        const config = getChainConfig(env, CHAIN_ID)
        const ownerKey = generatePrivateKey()
        const owner = privateKeyToAccount(ownerKey)
        const session = privateKeyToAccount(generatePrivateKey())

        const sessionKey = {
            expiry: '0',
            type: 'secp256k1' as const,
            role: 'admin' as const,
            publicKey: encodeAbiParameters([{ type: 'address' }], [session.address]),
            permissions: [],
        }

        const keyHash = computeKeyHash(sessionKey)

        const fresh = privateKeyToAccount(generatePrivateKey())

        const authSignature = await fresh.sign({
            hash: hashAuthorization({
                contractAddress: accountProxy,
                chainId: CHAIN_ID,
                nonce: 0,
            }),
        })

        const withoutAuth = await publicClient.estimateGas({
            account: relayer,
            to: zeroAddress,
            data: '0x1234',
        })

        const withAuth = await publicClient.estimateGas({
            account: relayer,
            to: zeroAddress,
            data: '0x1234',
            authorizationList: [
                {
                    address: accountProxy,
                    chainId: CHAIN_ID,
                    nonce: 0,
                    ...splitSignature(authSignature),
                },
            ],
        })

        const authGas = withAuth - withoutAuth
        assert(
            authGas >= 24_900n && authGas <= 25_100n,
            `authorization gas delta ${authGas} is outside 24900..25100`,
        )
        assert(
            PAID_UPGRADE_AUTHORIZATION_GAS === 25_000n,
            `expected authorization gas constant 25000, got ${PAID_UPGRADE_AUTHORIZATION_GAS}`,
        )

        await wallet.writeContract({
            address: USDC,
            abi: [
                {
                    type: 'function',
                    name: 'mint',
                    stateMutability: 'nonpayable',
                    inputs: [
                        { name: 'to', type: 'address' },
                        { name: 'amount', type: 'uint256' },
                    ],
                    outputs: [],
                },
            ],
            functionName: 'mint',
            args: [owner.address, 20_000_000n],
        })

        const service = new RelayerService(config, logger)

        const balanceOfData = encodeFunctionData({
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [owner.address],
        })

        const simCalls = [{ to: USDC, value: '0x0', data: balanceOfData }]

        const pending = await service.simulateIntent({
            eoa: owner.address,
            calls: simCalls,
        })

        assert(pending.success === false, 'undelegated simulation should fail')
        assert(
            pending.errorCode === 'DELEGATION_PENDING',
            `expected DELEGATION_PENDING, got ${pending.errorCode} ${pending.error}`,
        )

        const overridden = await service.simulateIntent({
            eoa: owner.address,
            calls: simCalls,
            delegation: accountProxy,
        })

        assert(
            overridden.success === true && BigInt(overridden.gasUsed ?? '0') > 0n,
            `state override simulation failed: ${overridden.error} revert=${String(overridden.revertReason)}`,
        )

        const { calls, executionData } = buildKeyInitializationData([sessionKey], owner.address)

        const execSignature = await owner.signTypedData({
            domain: getSignedCallDomain(CHAIN_ID, orchestrator),
            types: SIGNED_CALL_TYPES,
            primaryType: 'SignedCall',
            message: {
                multichain: false,
                eoa: owner.address,
                calls,
                nonce: UPGRADE_PRECALL_NONCE,
            },
        })

        const authorizationSignature = await owner.sign({
            hash: hashAuthorization({
                contractAddress: accountProxy,
                chainId: CHAIN_ID,
                nonce: 0,
            }),
        })

        const balanceOf = encodeFunctionData({
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [owner.address],
        })

        const prepared = await handlePrepareCalls(
            {
                from: owner.address,
                chain_id: '0x7a69',
                calls: [{ to: USDC, data: balanceOf, value: '0x0' }],
                capabilities: {
                    meta: {
                        nonce: '0',
                        fee_payer: owner.address,
                        fee_token: USDC,
                        fee_max_amount: '10000000',
                    },
                    accountUpgrade: {
                        authorization: {
                            contractAddress: accountProxy,
                            chainId: CHAIN_ID,
                            nonce: 0,
                            signature: authorizationSignature,
                        },
                        preCall: {
                            eoa: owner.address,
                            executionData,
                            nonce: UPGRADE_PRECALL_NONCE.toString(),
                            signature: execSignature,
                        },
                    },
                },
            },
            ctx,
        )

        assert(
            gasState.held === 0n && gasState.spent === 0n,
            'prepare reserved a gas hold or spent the daily budget',
        )
        const quote = prepared.context.quote.quotes[0]
        assert(quote, 'missing quote')
        const simulationGas = BigInt(quote.telemetry?.simulationGas ?? '0')
        const combined = simulationGas + 50_000n + 70_000n
        const expectedTxGas = ((combined + 110_000n) * 64n) / 63n + 37_000n + 25_000n
        assert(
            BigInt(quote.telemetry?.txGas ?? '0') === expectedTxGas,
            `txGas ${quote.telemetry?.txGas} != ${expectedTxGas}`,
        )
        const paymentAmount = BigInt(quote.paymentAmount)
        assert(paymentAmount > 0n, 'quoted fee must be greater than zero')
        assert(paymentAmount <= 10_000_000n, `quoted fee ${paymentAmount} exceeds the cap`)
        const percent = (paymentAmount * 500n + 9_999n) / 10_000n
        const margin = percent > 1_000n ? percent : 1_000n
        const signedMax = BigInt(quote.intent.paymentMaxAmount ?? '0')
        assert(
            signedMax === paymentAmount + margin,
            `signed paymentMaxAmount ${signedMax} is not quote+5% ${paymentAmount + margin}`,
        )
        assert(signedMax <= 5_000_000n, `signed cap ${signedMax} exceeds 5 USDC`)

        const intentSignature = await owner.sign({ hash: prepared.digest })

        const recipientBefore = await publicClient.readContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [relayer.address],
        })

        const relayerNonceBefore = await publicClient.getTransactionCount({
            address: relayer.address,
        })

        const sent = await handleSendPreparedCalls(
            {
                context: prepared.context,
                signature: intentSignature,
            },
            ctx,
        )

        assert(typeof sent.id === 'string' && sent.id.length > 0, 'missing bundle id')

        const code = await publicClient.getCode({ address: owner.address })
        assert(
            code?.toLowerCase() === eip7702DelegationCode(accountProxy).toLowerCase(),
            `delegation code ${code}`,
        )

        const stored = await publicClient.readContract({
            address: owner.address,
            abi: accountAbi,
            functionName: 'getKey',
            args: [keyHash],
        })

        const storedKey = stored as { publicKey: Hex }
        assert(
            storedKey.publicKey.toLowerCase() === sessionKey.publicKey.toLowerCase(),
            'session key was not authorized',
        )

        const recipientAfter = await publicClient.readContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [relayer.address],
        })

        assert(
            recipientAfter - recipientBefore === paymentAmount,
            `relayer USDC delta ${recipientAfter - recipientBefore} != ${paymentAmount}`,
        )

        const relayerNonceAfter = await publicClient.getTransactionCount({
            address: relayer.address,
        })

        assert(
            relayerNonceAfter === relayerNonceBefore + 1,
            'paid upgrade was not a single relayer transaction',
        )
        const ownerNonce = await publicClient.getTransactionCount({ address: owner.address })
        assert(ownerNonce === 1, `owner nonce ${ownerNonce}, expected the one authorization`)

        const failuresAfterHonest = gasState.failures

        if (failuresAfterHonest !== 0) {
            throw new Error('honest upgrade was counted as a payment failure')
        }

        const griefOwner = privateKeyToAccount(generatePrivateKey())
        const griefSession = privateKeyToAccount(generatePrivateKey())

        const funded = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'anvil_setBalance',
                params: [griefOwner.address, '0xDE0B6B3A7640000'],
            }),
        })

        const fundedBody = (await funded.json()) as { error?: { message?: string } }
        assert(!fundedBody.error, `anvil_setBalance failed: ${fundedBody.error?.message ?? 'unknown'}`)
        const griefBalance = await publicClient.getBalance({ address: griefOwner.address })
        assert(
            griefBalance >= 1_000_000_000_000_000_000n,
            `grief owner balance ${griefBalance} before approve`,
        )
        console.log(`grief owner funded balance ${griefBalance}`)

        const mintHash = await wallet.writeContract({
            address: USDC,
            abi: [
                {
                    type: 'function',
                    name: 'mint',
                    stateMutability: 'nonpayable',
                    inputs: [
                        { name: 'to', type: 'address' },
                        { name: 'amount', type: 'uint256' },
                    ],
                    outputs: [],
                },
            ],
            functionName: 'mint',
            args: [griefOwner.address, 20_000_000n],
        })

        const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash })
        assert(mintReceipt.status === 'success', 'grief USDC mint failed')

        const approveHash = await createWalletClient({
            account: griefOwner,
            chain,
            transport: http(RPC_URL),
        }).writeContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'approve',
            args: [relayer.address, 20_000_000n],
        })

        const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
        assert(approveReceipt.status === 'success', 'grief USDC approve failed')
        await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'anvil_mine',
                params: ['0x1'],
            }),
        })

        const griefNonce = await publicClient.getTransactionCount({
            address: griefOwner.address,
            blockTag: 'pending',
        })

        const griefLatest = await publicClient.getTransactionCount({
            address: griefOwner.address,
            blockTag: 'latest',
        })

        assert(
            griefNonce === griefLatest,
            `grief nonce pending ${griefNonce} != latest ${griefLatest}`,
        )
        console.log(`grief owner nonce ${griefNonce}`)

        const griefKey = {
            expiry: '0',
            type: 'secp256k1' as const,
            role: 'admin' as const,
            publicKey: encodeAbiParameters([{ type: 'address' }], [griefSession.address]),
            permissions: [],
        }

        const griefInit = buildKeyInitializationData([griefKey], griefOwner.address)

        const griefExecSignature = await griefOwner.signTypedData({
            domain: getSignedCallDomain(CHAIN_ID, orchestrator),
            types: SIGNED_CALL_TYPES,
            primaryType: 'SignedCall',
            message: {
                multichain: false,
                eoa: griefOwner.address,
                calls: griefInit.calls,
                nonce: UPGRADE_PRECALL_NONCE,
            },
        })

        const griefAuth = await griefOwner.sign({
            hash: hashAuthorization({
                contractAddress: accountProxy,
                chainId: CHAIN_ID,
                nonce: griefNonce,
            }),
        })

        const griefPrepared = await handlePrepareCalls(
            {
                from: griefOwner.address,
                chain_id: '0x7a69',
                calls: [
                    {
                        to: USDC,
                        data: encodeFunctionData({
                            abi: erc20Abi,
                            functionName: 'balanceOf',
                            args: [griefOwner.address],
                        }),
                        value: '0x0',
                    },
                ],
                capabilities: {
                    meta: {
                        nonce: '0',
                        fee_payer: griefOwner.address,
                        fee_token: USDC,
                        fee_max_amount: '10000000',
                    },
                    accountUpgrade: {
                        authorization: {
                            contractAddress: accountProxy,
                            chainId: CHAIN_ID,
                            nonce: griefNonce,
                            signature: griefAuth,
                        },
                        preCall: {
                            eoa: griefOwner.address,
                            executionData: griefInit.executionData,
                            nonce: UPGRADE_PRECALL_NONCE.toString(),
                            signature: griefExecSignature,
                        },
                    },
                },
            },
            ctx,
        )

        const griefSignature = await griefOwner.sign({ hash: griefPrepared.digest })

        const relayerUsdcBefore = await publicClient.readContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [relayer.address],
        })

        broadcastPlan.sweepOwner = griefOwner.address

        const griefSent = await handleSendPreparedCalls(
            { context: griefPrepared.context, signature: griefSignature },
            ctx,
        )

        broadcastPlan.sweepOwner = undefined
        assert(typeof griefSent.id === 'string', 'grief send did not return a bundle id')
        const griefReceipt = receipts[receipts.length - 1]
        assert(griefReceipt, 'missing PaymentError receipt')
        assert(griefReceipt.status === 'success', 'PaymentError receipt did not succeed')
        const griefErr = intentError(griefReceipt)
        assert(griefErr === '0xabab8fc9', `expected PaymentError selector, got ${griefErr}`)
        assert(gasState.failures === 1, `PaymentError failures ${gasState.failures}`)
        assert(
            gasState.spent >= griefReceipt.gasUsed,
            `gas budget ${gasState.spent} did not count ${griefReceipt.gasUsed}`,
        )

        const relayerUsdcAfter = await publicClient.readContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [relayer.address],
        })

        assert(
            relayerUsdcAfter - relayerUsdcBefore === 20_000_000n,
            'intent pull moved USDC after the sweep',
        )
        const blocked = applyAnvilGas(gasState, { action: 'reserve-gas', gas: '2000000' })
        assert(blocked.allowed === false, 'daily gas budget accepted another hold')
        console.log(
            `grief leg complete selector=${griefErr} gasUsed=${griefReceipt.gasUsed} failures=${gasState.failures} spent=${gasState.spent}`,
        )

        console.log(
            JSON.stringify({
                authGas: authGas.toString(),
                authorizationGasConstant: PAID_UPGRADE_AUTHORIZATION_GAS.toString(),
                simulationGas: simulationGas.toString(),
                txGas: expectedTxGas.toString(),
                paymentAmount: paymentAmount.toString(),
                delegation: code,
                bundleId: sent.id,
            }),
        )

        const burner = await deployBytecode(wallet, publicClient, BURNER_BYTECODE)
        const gasBomb = await deployBytecode(wallet, publicClient, GAS_BOMB_BYTECODE)
        const heavyOwner = privateKeyToAccount(generatePrivateKey())
        await fundAndApprove(wallet, publicClient, heavyOwner.address)

        const heavyNonceBefore = await publicClient.getTransactionCount({
            address: relayer.address,
        })

        const heavyUsdcBefore = await publicClient.readContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [relayer.address],
        })

        let heavyRefused = false

        try {
            await sendPaidUpgrade(ctx, {
                owner: heavyOwner,
                accountProxy,
                orchestrator,
                calls: [
                    {
                        to: burner,
                        data: encodeFunctionData({
                            abi: [
                                {
                                    type: 'function',
                                    name: 'burn',
                                    stateMutability: 'pure',
                                    inputs: [{ name: 'rounds', type: 'uint256' }],
                                    outputs: [{ name: 'n', type: 'uint256' }],
                                },
                            ],
                            functionName: 'burn',
                            args: [800n],
                        }),
                        value: '0x0',
                    },
                ],
            })
        } catch (error) {
            heavyRefused = true
            const message = error instanceof Error ? error.message : String(error)
            assert(
                message.includes('reserved hold'),
                `heavy upgrade refused for a different reason: ${message}`,
            )
        }

        assert(heavyRefused, 'burn(800) quote was signed above the 500k hold')

        const heavyNonceAfter = await publicClient.getTransactionCount({
            address: relayer.address,
        })

        assert(heavyNonceAfter === heavyNonceBefore, 'refused burn broadcast a relayer transaction')

        const heavyUsdcAfter = await publicClient.readContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [relayer.address],
        })

        assert(heavyUsdcAfter === heavyUsdcBefore, 'refused burn moved USDC')

        const bombOwner = privateKeyToAccount(generatePrivateKey())
        const bombHelper = privateKeyToAccount(generatePrivateKey())
        await fundAndApprove(wallet, publicClient, bombOwner.address)

        const helperFunded = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'anvil_setBalance',
                params: [bombHelper.address, '0xDE0B6B3A7640000'],
            }),
        })

        const helperFundedBody = (await helperFunded.json()) as { error?: { message?: string } }
        assert(!helperFundedBody.error, 'helper anvil_setBalance failed')

        const bombUsdcBefore = await publicClient.readContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [relayer.address],
        })

        broadcastPlan.beforeBroadcast = async () => {
            const bombAuth = await bombOwner.sign({
                hash: hashAuthorization({
                    contractAddress: gasBomb,
                    chainId: CHAIN_ID,
                    nonce: 0,
                }),
            })

            const helper = createWalletClient({
                account: bombHelper,
                chain,
                transport: http(RPC_URL),
            })

            const bombHash = await helper.sendTransaction({
                to: bombHelper.address,
                value: 0n,
                gas: 100_000n,
                maxFeePerGas: ACCOUNT_UPGRADE_MAX_PRIORITY_FEE_PER_GAS + 1_000_000_000n,
                maxPriorityFeePerGas: ACCOUNT_UPGRADE_MAX_PRIORITY_FEE_PER_GAS + 1_000_000_000n,
                authorizationList: [
                    {
                        address: gasBomb,
                        chainId: CHAIN_ID,
                        nonce: 0,
                        ...splitSignature(bombAuth),
                    },
                ],
                type: 'eip7702',
            })

            const bombReceipt = await publicClient.waitForTransactionReceipt({ hash: bombHash })
            assert(bombReceipt.status === 'success', 'gas bomb authorization was not mined')
        }

        broadcastPlan.expectSuccess = false

        const bombSent = await sendPaidUpgrade(ctx, {
            owner: bombOwner,
            accountProxy,
            orchestrator,
            calls: [
                {
                    to: USDC,
                    data: encodeFunctionData({
                        abi: erc20Abi,
                        functionName: 'balanceOf',
                        args: [bombOwner.address],
                    }),
                    value: '0x0',
                },
            ],
        })

        broadcastPlan.beforeBroadcast = undefined
        broadcastPlan.expectSuccess = undefined
        assert(typeof bombSent.id === 'string', 'bomb race did not return a bundle id')
        const bombUpgrade = receipts[receipts.length - 1]
        assert(bombUpgrade, 'missing bomb-race receipt')
        assert(
            bombUpgrade.gasUsed <= PAID_UPGRADE_GAS_HOLD,
            `bomb race gasUsed ${bombUpgrade.gasUsed} exceeded the hold`,
        )

        const bombUsdcAfter = await publicClient.readContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [relayer.address],
        })

        assert(bombUsdcAfter === bombUsdcBefore, 'bomb race pulled USDC')
        const bombCode = await publicClient.getCode({ address: bombOwner.address })
        assert(
            bombCode?.toLowerCase() === eip7702DelegationCode(gasBomb).toLowerCase(),
            `bomb race delegated to ${bombCode}`,
        )
        console.log(
            `bomb race gasUsed=${bombUpgrade.gasUsed} hold=${PAID_UPGRADE_GAS_HOLD} usdcDelta=0`,
        )
    } finally {
        anvil.kill('SIGTERM')
        cleanupDeployArtifacts()
    }
}

function json(body: unknown, ok = true): Response {
    return {
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
    } as Response
}

function splitSignature(signature: Hex): { r: Hex; s: Hex; yParity: number } {
    const raw = signature.slice(2)
    const v = Number.parseInt(raw.slice(128, 130), 16)

    return {
        r: `0x${raw.slice(0, 64)}` as Hex,
        s: `0x${raw.slice(64, 128)}` as Hex,
        yParity: v >= 27 ? v - 27 : v,
    }
}

function applyAnvilGas(
    gasState: { spent: bigint; held: bigint; failures: number },
    body: { action?: string; gas?: string; hold?: string; failure?: boolean },
): { allowed: boolean; gas: number; failures: number } {
    const budget = 2_000_000n
    const amount = BigInt(body.gas ?? '0')

    if (body.action === 'reserve-gas') {
        if (amount > PAID_UPGRADE_GAS_HOLD || gasState.spent + gasState.held + amount > budget) {
            return { allowed: false, gas: Number(gasState.spent), failures: gasState.failures }
        }

        gasState.held += amount

        return { allowed: true, gas: Number(gasState.spent), failures: gasState.failures }
    }

    if (body.action === 'release-gas') {
        gasState.held = gasState.held > amount ? gasState.held - amount : 0n

        return { allowed: true, gas: Number(gasState.spent), failures: gasState.failures }
    }

    if (body.action === 'settle-gas') {
        const hold = BigInt(body.hold ?? '0')
        gasState.held = gasState.held > hold ? gasState.held - hold : 0n
        let accounted = amount > hold ? hold : amount

        if (accounted > PAID_UPGRADE_GAS_HOLD) accounted = PAID_UPGRADE_GAS_HOLD
        const room = budget - gasState.spent - gasState.held

        if (accounted > room) accounted = room > 0n ? room : 0n
        gasState.spent += accounted

        if (body.failure === true) gasState.failures += 1

        return { allowed: true, gas: Number(gasState.spent), failures: gasState.failures }
    }

    return { allowed: false, gas: Number(gasState.spent), failures: gasState.failures }
}

function intentError(receipt: TransactionReceipt): Hex | undefined {
    for (const log of receipt.logs) {
        try {
            const decoded = decodeEventLog({
                abi: orchestratorAbi,
                data: log.data,
                topics: log.topics,
            })

            if (decoded.eventName !== 'IntentExecuted') continue

            return (decoded.args as { err?: Hex }).err
        } catch {
            continue
        }
    }

    return undefined
}

const BURNER_BYTECODE =
    '0x6080604052348015600e575f5ffd5b5060dc80601a5f395ff3fe6080604052348015600e575f5ffd5b50600436106026575f3560e01c806342966c6814602a575b5f5ffd5b603960353660046090565b604b565b60405190815260200160405180910390f35b5f5f5b82811015608a57604080516020810183905290810183905260600160408051601f1981840301815291905280516020909101209150600101604e565b50919050565b5f60208284031215609f575f5ffd5b503591905056fea2646970667358221220d689a7628662cc20b0c58cb6cdd976cdd2833b83857cfb1efcee9c35cf7adeff64736f6c634300081c0033' as Hex

const GAS_BOMB_BYTECODE =
    '0x6080604052348015600e575f5ffd5b50604580601a5f395ff3fe60806040525b6113885a1160055700fea26469706673582212209c62d81a64e8ae9e7363a468b7838b1978378a04080cd49131c4b68d3a139f1d64736f6c634300081c0033' as Hex

async function deployBytecode(
    wallet: WalletClient<Transport, typeof chain, Account>,
    publicClient: PublicClient,
    bytecode: Hex,
): Promise<Address> {
    const hash = await wallet.sendTransaction({ data: bytecode, chain })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    assert(receipt.contractAddress, 'toy contract deploy failed')

    return receipt.contractAddress
}

async function fundAndApprove(
    wallet: WalletClient<Transport, typeof chain, Account>,
    publicClient: PublicClient,
    owner: Address,
): Promise<void> {
    const funded = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'anvil_setBalance',
            params: [owner, '0xDE0B6B3A7640000'],
        }),
    })

    const fundedBody = (await funded.json()) as { error?: { message?: string } }
    assert(!fundedBody.error, `anvil_setBalance failed: ${fundedBody.error?.message ?? 'unknown'}`)

    const mintHash = await wallet.writeContract({
        address: USDC,
        abi: [
            {
                type: 'function',
                name: 'mint',
                stateMutability: 'nonpayable',
                inputs: [
                    { name: 'to', type: 'address' },
                    { name: 'amount', type: 'uint256' },
                ],
                outputs: [],
            },
        ],
        functionName: 'mint',
        args: [owner, 20_000_000n],
        chain,
    })

    const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash })
    assert(mintReceipt.status === 'success', 'USDC mint failed')
}

async function sendPaidUpgrade(
    ctx: RpcContext,
    input: {
        owner: ReturnType<typeof privateKeyToAccount>
        accountProxy: Address
        orchestrator: Address
        calls: { to: Address; data: Hex; value: string }[]
    },
): Promise<{ id: string }> {
    const { orchestrator } = input
    const session = privateKeyToAccount(generatePrivateKey())

    const sessionKey = {
        expiry: '0',
        type: 'secp256k1' as const,
        role: 'admin' as const,
        publicKey: encodeAbiParameters([{ type: 'address' }], [session.address]),
        permissions: [],
    }

    const { calls, executionData } = buildKeyInitializationData([sessionKey], input.owner.address)

    const execSignature = await input.owner.signTypedData({
        domain: getSignedCallDomain(CHAIN_ID, orchestrator),
        types: SIGNED_CALL_TYPES,
        primaryType: 'SignedCall',
        message: {
            multichain: false,
            eoa: input.owner.address,
            calls,
            nonce: UPGRADE_PRECALL_NONCE,
        },
    })

    const authorizationSignature = await input.owner.sign({
        hash: hashAuthorization({
            contractAddress: input.accountProxy,
            chainId: CHAIN_ID,
            nonce: 0,
        }),
    })

    const prepared = await handlePrepareCalls(
        {
            from: input.owner.address,
            chain_id: '0x7a69',
            calls: input.calls,
            capabilities: {
                meta: {
                    nonce: '0',
                    fee_payer: input.owner.address,
                    fee_token: USDC,
                    fee_max_amount: '10000000',
                },
                accountUpgrade: {
                    authorization: {
                        contractAddress: input.accountProxy,
                        chainId: CHAIN_ID,
                        nonce: 0,
                        signature: authorizationSignature,
                    },
                    preCall: {
                        eoa: input.owner.address,
                        executionData,
                        nonce: UPGRADE_PRECALL_NONCE.toString(),
                        signature: execSignature,
                    },
                },
            },
        },
        ctx,
    )

    const signature = await input.owner.sign({ hash: prepared.digest })

    const sent = await handleSendPreparedCalls(
        { context: prepared.context, signature },
        ctx,
    )

    return { id: sent.id }
}

async function broadcastPaidUpgrade(
    publicClient: PublicClient,
    tx: ExecuteIntentTransaction,
    orchestrator: Address,
    broadcaster: ReturnType<typeof createWalletClient>,
    plan: {
        sweepOwner?: Address
        beforeBroadcast?: () => Promise<void>
        expectSuccess?: boolean
    },
    receipts: TransactionReceipt[],
): Promise<Hex> {
    const relayer = privateKeyToAccount(RELAYER_KEY)
    assert(tx.authorization, 'execute-intent is missing the authorization')

    const intent = {
        ...tx.intent,
        paymentRecipient: getPaymentRecipient(undefined, relayer.address),
    }

    const data = encodeFunctionData({
        abi: orchestratorAbi,
        functionName: 'execute',
        args: [encodeIntentCalldata(intent)],
    })

    const estimate = await publicClient.estimateGas({
        account: relayer,
        to: orchestrator,
        data,
        value: 0n,
        authorizationList: [tx.authorization],
    })

    const gas = paidUpgradeSignedGas(estimate)

    if (plan.beforeBroadcast) await plan.beforeBroadcast()

    if (plan.sweepOwner) {
        const balance = await publicClient.readContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [plan.sweepOwner],
        })

        const sweepHash = await broadcaster.writeContract({
            address: USDC,
            abi: erc20Abi,
            functionName: 'transferFrom',
            args: [plan.sweepOwner, relayer.address, balance],
            chain,
            account: relayer,
        })

        const sweepReceipt = await publicClient.waitForTransactionReceipt({ hash: sweepHash })
        assert(sweepReceipt.status === 'success', 'sweep transferFrom failed')
    }

    const hash = await broadcaster.sendTransaction({
        chain,
        account: relayer,
        to: orchestrator,
        data,
        value: 0n,
        gas,
        maxFeePerGas: ACCOUNT_UPGRADE_MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: ACCOUNT_UPGRADE_MAX_PRIORITY_FEE_PER_GAS,
        authorizationList: [tx.authorization],
        type: 'eip7702',
    })

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (plan.expectSuccess !== false) {
        assert(receipt.status === 'success', `upgrade tx ${hash} reverted`)
    }

    console.log(
        `paid upgrade measure estimate=${estimate} signedGas=${gas} gasUsed=${receipt.gasUsed} sweep=${plan.sweepOwner ? 'yes' : 'no'}`,
    )
    receipts.push(receipt)

    return hash
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
