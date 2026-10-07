import {
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    keccak256,
    parseAbiParameters,
    type Address,
    type Hex,
} from 'viem'
import { hashAuthorization, hashTypedData } from 'viem/utils'
import { accountAbi } from '@nubl/contracts/abis'
import type { AuthorizeKey } from '../actions/upgradeAccount'
import { PreparedCallsBindingError } from './bindPreparedCalls'
import { ORCHESTRATOR_DOMAIN_NAME, ORCHESTRATOR_DOMAIN_VERSION } from './bindPreparedCalls'

export const SIGNED_CALL_TYPES = {
    SignedCall: [
        { name: 'multichain', type: 'bool' },
        { name: 'eoa', type: 'address' },
        { name: 'calls', type: 'Call[]' },
        { name: 'nonce', type: 'uint256' },
    ],
    Call: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
    ],
} as const

/** Seq key 1, sequence 0. The relayer does not choose this nonce. */
export const UPGRADE_PRECALL_NONCE = 1n << 64n

const SPEND_PERIOD_VALUES = {
    minute: 0,
    hour: 1,
    day: 2,
    week: 3,
    month: 4,
    year: 5,
    forever: 6,
} as const

function refuse(detail: string): never {
    throw new PreparedCallsBindingError(`Refusing to sign account upgrade: ${detail}`)
}

function keyTypeEnum(type: AuthorizeKey['type']): number {
    if (type === 'secp256k1') return 0
    if (type === 'external') return 1
    return 2
}

function keyHash(key: AuthorizeKey): Hex {
    const encoded = encodeAbiParameters(parseAbiParameters('uint8, bytes32'), [
        keyTypeEnum(key.type),
        keccak256(key.publicKey),
    ])
    return keccak256(encoded)
}

export type UpgradeCall = { to: Address; value: bigint; data: Hex }

/**
 * Calls the wallet asked to authorize. Built locally from authorizeKeys.
 */
export function buildUpgradeExecution(
    keys: readonly AuthorizeKey[],
    accountAddress: Address,
): { calls: UpgradeCall[]; executionData: Hex } {
    if (keys.length === 0) return { calls: [], executionData: '0x' }

    const calls: UpgradeCall[] = []
    for (const key of keys) {
        calls.push({
            to: getAddress(accountAddress),
            value: 0n,
            data: encodeFunctionData({
                abi: accountAbi,
                functionName: 'authorize',
                args: [
                    {
                        expiry: Number(key.expiry),
                        keyType: keyTypeEnum(key.type),
                        isSuperAdmin: key.role === 'admin',
                        publicKey: key.publicKey,
                    },
                ],
            }),
        })

        if (key.permissions.length === 0 || key.role === 'admin') continue
        const hash = keyHash(key)
        for (const permission of key.permissions) {
            if (permission.type === 'call') {
                calls.push({
                    to: getAddress(accountAddress),
                    value: 0n,
                    data: encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'setCanExecute',
                        args: [hash, permission.to, permission.selector, true],
                    }),
                })
            } else {
                calls.push({
                    to: getAddress(accountAddress),
                    value: 0n,
                    data: encodeFunctionData({
                        abi: accountAbi,
                        functionName: 'setSpendLimit',
                        args: [
                            hash,
                            permission.token,
                            SPEND_PERIOD_VALUES[permission.period],
                            BigInt(permission.limit),
                        ],
                    }),
                })
            }
        }
    }

    const executionData = encodeAbiParameters(
        parseAbiParameters('(address to, uint256 value, bytes data)[]'),
        [calls],
    )
    return { calls, executionData }
}

export type UpgradeBindingExpectation = {
    accountAddress: Address
    chainId: number
    /** Local account proxy. Never the relayer's advertised delegation. */
    delegation: Address
    orchestrator: Address
    /** EOA transaction count from the wallet's own RPC. */
    authorizationNonce: bigint | number
    authorizeKeys: readonly AuthorizeKey[]
}

export type BoundPreparedUpgrade = {
    authDigest: Hex
    execDigest: Hex
    executionData: Hex
    typedData: {
        domain: {
            name: string
            version: string
            chainId: number
            verifyingContract: Address
        }
        types: typeof SIGNED_CALL_TYPES
        primaryType: 'SignedCall'
        message: {
            multichain: boolean
            eoa: Address
            calls: UpgradeCall[]
            nonce: bigint
        }
    }
}

type PreparedUpgrade = {
    digests?: { auth?: Hex; exec?: Hex }
    typedData?: {
        domain?: {
            name?: string
            version?: string
            chainId?: number | string | bigint
            verifyingContract?: string
        }
        primaryType?: string
        types?: {
            SignedCall?: ReadonlyArray<{ name: string; type: string }>
            Call?: ReadonlyArray<{ name: string; type: string }>
        }
        message?: {
            multichain?: boolean
            eoa?: string
            calls?: Array<{ to?: string; value?: string | bigint; data?: string }>
            nonce?: string | bigint
        }
    }
    context?: {
        authorization?: { contractAddress?: string; chainId?: number | string; nonce?: number | string }
        preCall?: { executionData?: string; eoa?: string; nonce?: string }
    }
}

function sameTypes(
    actual: ReadonlyArray<{ name: string; type: string }> | undefined,
    expected: ReadonlyArray<{ name: string; type: string }>,
): boolean {
    return (
        !!actual &&
        actual.length === expected.length &&
        actual.every(
            (field, index) => field.name === expected[index].name && field.type === expected[index].type,
        )
    )
}

/**
 * Recompute the EIP-7702 authorization and the SignedCall the wallet requested.
 * Returns the typed data to sign. Refuses the relayer payload on any mismatch.
 */
export function bindPreparedUpgrade(
    prepared: PreparedUpgrade,
    expected: UpgradeBindingExpectation,
): BoundPreparedUpgrade {
    const delegation = getAddress(expected.delegation)
    const accountAddress = getAddress(expected.accountAddress)
    const orchestrator = getAddress(expected.orchestrator)
    const authorizationNonce = BigInt(expected.authorizationNonce)
    const authDigest = hashAuthorization({
        chainId: expected.chainId,
        contractAddress: delegation,
        nonce: Number(authorizationNonce),
    })
    if (prepared.digests?.auth?.toLowerCase() !== authDigest.toLowerCase()) {
        refuse('authorization digest does not match')
    }

    const authorization = prepared.context?.authorization
    if (!authorization) refuse('authorization is missing')
    if (Number(authorization.chainId) !== expected.chainId) refuse('authorization chain does not match')
    if (BigInt(authorization.nonce ?? -1) !== authorizationNonce) {
        refuse('authorization nonce does not match')
    }
    if (getAddress(authorization.contractAddress ?? '0x') !== delegation) {
        refuse('authorization target does not match')
    }

    const { calls, executionData } = buildUpgradeExecution(expected.authorizeKeys, accountAddress)
    const preCall = prepared.context?.preCall
    if ((preCall?.executionData ?? '0x').toLowerCase() !== executionData.toLowerCase()) {
        refuse('execution data does not match')
    }
    if (preCall?.eoa && getAddress(preCall.eoa) !== accountAddress) refuse('account does not match')
    if (preCall?.nonce !== undefined && BigInt(preCall.nonce) !== UPGRADE_PRECALL_NONCE) {
        refuse('precall nonce does not match')
    }

    const message = {
        multichain: false,
        eoa: accountAddress,
        calls,
        nonce: UPGRADE_PRECALL_NONCE,
    }
    const signingDomain = {
        name: ORCHESTRATOR_DOMAIN_NAME,
        version: ORCHESTRATOR_DOMAIN_VERSION,
        chainId: expected.chainId,
        verifyingContract: orchestrator,
    }
    const execDigest = hashTypedData({
        domain: signingDomain,
        types: SIGNED_CALL_TYPES,
        primaryType: 'SignedCall',
        message,
    })

    if (calls.length === 0) {
        if (prepared.digests?.exec && prepared.digests.exec !== '0x' && prepared.context?.preCall?.executionData !== '0x') {
            refuse('execution data does not match')
        }
        return {
            authDigest,
            execDigest,
            executionData,
            typedData: {
                domain: signingDomain,
                types: SIGNED_CALL_TYPES,
                primaryType: 'SignedCall',
                message,
            },
        }
    }

    const typed = prepared.typedData
    if (!typed?.domain || !typed.message) refuse('typed data is missing')
    if (typed.domain.name !== ORCHESTRATOR_DOMAIN_NAME || typed.domain.version !== ORCHESTRATOR_DOMAIN_VERSION) {
        refuse('domain name or version does not match')
    }
    if (Number(typed.domain.chainId) !== expected.chainId) refuse('chain id does not match')
    if (getAddress(typed.domain.verifyingContract ?? '0x') !== orchestrator) {
        refuse('verifying contract does not match')
    }
    if (typed.primaryType !== 'SignedCall') refuse('typed data primary type does not match')
    if (!sameTypes(typed.types?.SignedCall, SIGNED_CALL_TYPES.SignedCall) || !sameTypes(typed.types?.Call, SIGNED_CALL_TYPES.Call)) {
        refuse('typed data types do not match')
    }
    if (typed.message.multichain === true) refuse('multichain flag does not match')
    if (getAddress(typed.message.eoa ?? '0x') !== accountAddress) refuse('account does not match')
    if (BigInt(typed.message.nonce ?? -1) !== UPGRADE_PRECALL_NONCE) refuse('precall nonce does not match')

    const gotCalls = typed.message.calls ?? []
    if (gotCalls.length !== calls.length) refuse('call count does not match')
    for (let index = 0; index < calls.length; index++) {
        const got = gotCalls[index]
        const wanted = calls[index]
        if (getAddress(got.to ?? '0x') !== wanted.to) refuse(`call target does not match (call ${index})`)
        if (BigInt(got.value ?? 0) !== wanted.value) refuse(`call value does not match (call ${index})`)
        if ((got.data ?? '0x').toLowerCase() !== wanted.data.toLowerCase()) {
            refuse(`call data does not match (call ${index})`)
        }
    }
    if (prepared.digests?.exec?.toLowerCase() !== execDigest.toLowerCase()) {
        refuse('digest does not match')
    }

    return {
        authDigest,
        execDigest,
        executionData,
        typedData: {
            domain: signingDomain,
            types: SIGNED_CALL_TYPES,
            primaryType: 'SignedCall',
            message,
        },
    }
}
