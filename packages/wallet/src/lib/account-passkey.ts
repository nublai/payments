import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    http,
    isHex,
    type Address,
    type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
    computeKeyHash,
    encodeP256Signature,
    keyTypeToEnum,
} from '@nubl/relayer-client'

const accountAbi = [
    {
        type: 'constructor',
        stateMutability: 'payable',
        inputs: [{ name: 'orchestrator', type: 'address' }],
    },
    {
        type: 'function',
        name: 'authorize',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'key',
                type: 'tuple',
                components: [
                    { name: 'expiry', type: 'uint40' },
                    { name: 'keyType', type: 'uint8' },
                    { name: 'isSuperAdmin', type: 'bool' },
                    { name: 'publicKey', type: 'bytes' },
                ],
            },
        ],
        outputs: [{ name: 'keyHash', type: 'bytes32' }],
    },
    {
        type: 'function',
        name: 'unwrapAndValidateSignature',
        stateMutability: 'view',
        inputs: [
            { name: 'digest', type: 'bytes32' },
            { name: 'signature', type: 'bytes' },
        ],
        outputs: [
            { name: 'isValid', type: 'bool' },
            { name: 'keyHash', type: 'bytes32' },
        ],
    },
] as const

export type AccountPasskeyArgs = {
    rpcUrl: string
    privateKey: Hex
    publicKey: Hex
    digest: Hex
    authenticatorData: Hex
    clientDataJson: Hex
    r: bigint
    s: bigint
    prehash: boolean
}

export type AccountPasskeyResult = {
    type: 'account_passkey'
    valid: boolean
    keyHash: Hex
    account: Address
    implementation: Address
}

export class AccountPasskeyError extends Error {
    code: 'INVALID_ARGUMENT' | 'CHAIN_FAILED'

    constructor(code: AccountPasskeyError['code'], message: string) {
        super(message)
        this.name = 'AccountPasskeyError'
        this.code = code
    }
}

function requireHex(value: string, label: string, bytes?: number): Hex {
    const hex = value.toLowerCase()

    if (!isHex(hex) || hex.length < 4 || (hex.length - 2) % 2 !== 0) {
        throw new AccountPasskeyError('INVALID_ARGUMENT', `${label} must be hex`)
    }

    if (bytes !== undefined && (hex.length - 2) / 2 !== bytes) {
        throw new AccountPasskeyError('INVALID_ARGUMENT', `${label} must be ${bytes} bytes`)
    }

    return hex
}

function loadAccountCreationBytecode(): Hex {
    const here = dirname(fileURLToPath(import.meta.url))
    const artifactPath = resolve(here, '../../../contracts/out/Account.sol/Account.json')

    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
        bytecode?: { object?: string }
    }

    const object = artifact.bytecode?.object

    if (!object) {
        throw new AccountPasskeyError(
            'CHAIN_FAILED',
            `Account creation bytecode missing at ${artifactPath}`,
        )
    }

    return (object.startsWith('0x') ? object : `0x${object}`) as Hex
}

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })

    const body = (await response.json()) as { result?: unknown; error?: { message?: string } }

    if (!response.ok || body.error) {
        throw new AccountPasskeyError(
            'CHAIN_FAILED',
            body.error?.message ?? `${method} failed (${response.status})`,
        )
    }

    return body.result
}

/**
 * Deploy Account, delegate the EOA to it, authorize a P-256 key, and call
 * unwrapAndValidateSignature. The RPC must be anvil on the osaka hardfork so
 * RIP-7212 (0x100) is installed.
 */
export async function executeAccountPasskey(
    args: AccountPasskeyArgs,
): Promise<AccountPasskeyResult> {
    const publicKey = requireHex(args.publicKey, 'publicKey', 64)
    const digest = requireHex(args.digest, 'digest', 32)
    const authenticatorData = requireHex(args.authenticatorData, 'authenticatorData')
    const clientDataJson = requireHex(args.clientDataJson, 'clientDataJson')
    const privateKey = requireHex(args.privateKey, 'privateKey', 32)

    if (keyTypeToEnum('p256') !== 2) {
        throw new AccountPasskeyError('CHAIN_FAILED', 'p256 key type enum drifted from 2')
    }

    const account = privateKeyToAccount(privateKey)
    const probe = createPublicClient({ transport: http(args.rpcUrl) })
    const chainId = await probe.getChainId()

    const chain = defineChain({
        id: chainId,
        name: 'anvil',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [args.rpcUrl] } },
    })

    const publicClient = createPublicClient({ chain, transport: http(args.rpcUrl) })

    const walletClient = createWalletClient({
        account,
        chain,
        transport: http(args.rpcUrl),
    })

    const deployHash = await walletClient.deployContract({
        abi: accountAbi,
        bytecode: loadAccountCreationBytecode(),
        args: ['0x0000000000000000000000000000000000000001'],
    })

    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
    const implementation = deployReceipt.contractAddress

    if (!implementation) {
        throw new AccountPasskeyError('CHAIN_FAILED', 'Account deployment did not return an address')
    }

    const delegation = `0xef0100${implementation.slice(2).toLowerCase()}` as Hex
    await rpc(args.rpcUrl, 'anvil_setCode', [account.address, delegation])
    const code = await publicClient.getCode({ address: account.address })

    if (code?.toLowerCase() !== delegation) {
        throw new AccountPasskeyError(
            'CHAIN_FAILED',
            'anvil did not install the EIP-7702 delegation designator',
        )
    }

    const keyHash = computeKeyHash('p256', publicKey)

    const signature = encodeP256Signature({
        authenticatorData,
        clientDataJSON: clientDataJson,
        r: args.r,
        s: args.s,
        keyHash,
        prehash: args.prehash,
    })

    const authorizeHash = await walletClient.writeContract({
        address: account.address,
        abi: accountAbi,
        functionName: 'authorize',
        args: [
            {
                expiry: 0,
                keyType: keyTypeToEnum('p256'),
                isSuperAdmin: false,
                publicKey,
            },
        ],
    })

    await publicClient.waitForTransactionReceipt({ hash: authorizeHash })

    const [isValid, got] = await publicClient.readContract({
        address: account.address,
        abi: accountAbi,
        functionName: 'unwrapAndValidateSignature',
        args: [digest, signature],
    })

    return {
        type: 'account_passkey',
        valid: isValid,
        keyHash: got,
        account: account.address,
        implementation,
    }
}
