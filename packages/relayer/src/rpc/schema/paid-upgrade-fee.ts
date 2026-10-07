import {
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    keccak256,
    toBytes,
    type Address,
    type Hex,
} from 'viem'

/**
 * EIP-3009 window for a paid-upgrade fee authorization.
 *
 * 10 minutes. The default quote lives 300 seconds (`QUOTE_TTL_SECONDS`).
 * 600 seconds covers that quote plus clock skew between the wallet and the
 * relayer, and it is the same length as the paid-upgrade rate window. A
 * longer window would leave a bearer pull that can be submitted after the
 * account owner has walked away. `validBefore` must be in the future, no
 * later than now + this window, and no later than the quote TTL.
 */
export const PAID_UPGRADE_FEE_AUTH_WINDOW_SECONDS = 600

/** Circle FiatTokenV2 domain. Base USDC uses version "2". */
export const USDC_EIP712_NAME = 'USD Coin'
export const USDC_EIP712_VERSION = '2'

export const PAID_UPGRADE_FEE_NONCE_DOMAIN = keccak256(toBytes('nubl.paid-upgrade.fee.v1'))

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
    ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
    ],
} as const

/**
 * `receiveWithAuthorization` is the pull. Circle requires `msg.sender == to`,
 * so only the fee recipient can submit it. A mempool watcher cannot front-run
 * `transferWithAuthorization` and consume the nonce.
 */
export const receiveWithAuthorizationAbi = [
    {
        type: 'function',
        name: 'receiveWithAuthorization',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
            { name: 'v', type: 'uint8' },
            { name: 'r', type: 'bytes32' },
            { name: 's', type: 'bytes32' },
        ],
        outputs: [],
    },
    {
        type: 'function',
        name: 'authorizationState',
        stateMutability: 'view',
        inputs: [
            { name: 'authorizer', type: 'address' },
            { name: 'nonce', type: 'bytes32' },
        ],
        outputs: [{ name: '', type: 'bool' }],
    },
    {
        type: 'event',
        name: 'Transfer',
        inputs: [
            { name: 'from', type: 'address', indexed: true },
            { name: 'to', type: 'address', indexed: true },
            { name: 'value', type: 'uint256', indexed: false },
        ],
    },
] as const

export type PaidUpgradeFeeStatus =
    | 'pull_intent'
    | 'fee_collected'
    | 'upgrade_pending'
    | 'upgrade_confirmed'
    | 'upgrade_landed'
    | 'upgrade_failed'
    | 'pull_failed'

export interface PaidUpgradeFeeRecord {
    status: PaidUpgradeFeeStatus
    fee: string
    from: Address
    to: Address
    nonce: Hex
    pullTx?: Hex
    upgradeTx?: Hex
    bundleId?: string
}

export interface PaidUpgradeFeeAuthorization {
    validAfter: string
    validBefore: string
    nonce: Hex
    signature: Hex
}

const FEE_STATUSES = new Set<PaidUpgradeFeeStatus>([
    'pull_intent',
    'fee_collected',
    'upgrade_pending',
    'upgrade_confirmed',
    'upgrade_landed',
    'upgrade_failed',
    'pull_failed',
])

export function isPaidUpgradeFeeStatus(value: unknown): value is PaidUpgradeFeeStatus {
    return typeof value === 'string' && FEE_STATUSES.has(value as PaidUpgradeFeeStatus)
}

/** 32-byte quote HMAC. The EIP-3009 nonce is derived from this and the payee. */
export function paidUpgradeQuoteKey(quoteSignature: Hex): string {
    if (!/^0x[0-9a-fA-F]{64}$/.test(quoteSignature)) {
        throw new Error('Quote signature is not a 32-byte HMAC')
    }
    return quoteSignature.toLowerCase()
}

/**
 * Nonce bound to this quote HMAC, chain, account, fee recipient, and value.
 * A replay against another quote, or a redirect to another payee or amount,
 * produces a different nonce. The signed authorization cannot be reused.
 */
export function paidUpgradeFeeNonce(input: {
    quoteSignature: Hex
    chainId: number
    from: Address
    to: Address
    value: bigint
}): Hex {
    const signature = paidUpgradeQuoteKey(input.quoteSignature) as Hex
    return keccak256(
        encodeAbiParameters(
            [
                { type: 'bytes32' },
                { type: 'bytes32' },
                { type: 'uint256' },
                { type: 'address' },
                { type: 'address' },
                { type: 'uint256' },
            ],
            [
                PAID_UPGRADE_FEE_NONCE_DOMAIN,
                signature,
                BigInt(input.chainId),
                getAddress(input.from),
                getAddress(input.to),
                input.value,
            ],
        ),
    )
}

export function paidUpgradeFeeDomain(chainId: number, token: Address) {
    return {
        name: USDC_EIP712_NAME,
        version: USDC_EIP712_VERSION,
        chainId,
        verifyingContract: getAddress(token),
    }
}

export function paidUpgradeFeeMessage(input: {
    from: Address
    to: Address
    value: bigint
    validAfter: bigint
    validBefore: bigint
    nonce: Hex
}) {
    return {
        from: getAddress(input.from),
        to: getAddress(input.to),
        value: input.value,
        validAfter: input.validAfter,
        validBefore: input.validBefore,
        nonce: input.nonce,
    }
}

export function paidUpgradeFeeTypedData(input: {
    chainId: number
    token: Address
    from: Address
    to: Address
    value: bigint
    validAfter: bigint
    validBefore: bigint
    nonce: Hex
}) {
    return {
        domain: paidUpgradeFeeDomain(input.chainId, input.token),
        types: RECEIVE_WITH_AUTHORIZATION_TYPES,
        primaryType: 'ReceiveWithAuthorization' as const,
        message: paidUpgradeFeeMessage(input),
    }
}

export function feeAuthorizationWindowReason(input: {
    validAfter: bigint
    validBefore: bigint
    now: bigint
    quoteTtl: bigint
}): string | undefined {
    if (input.validAfter !== 0n) return 'Paid upgrade fee authorization is not yet valid'
    if (input.validBefore <= input.now) return 'Paid upgrade fee authorization expired'
    if (input.validBefore > input.now + BigInt(PAID_UPGRADE_FEE_AUTH_WINDOW_SECONDS)) {
        return 'Paid upgrade fee authorization window is too long'
    }
    if (input.validBefore > input.quoteTtl) return 'Paid upgrade fee authorization outlives the quote'
    return undefined
}

const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'))

function topicAddress(topic: string | undefined): Address | undefined {
    if (!topic || topic.length < 42) return undefined
    try {
        return getAddress(`0x${topic.slice(-40)}`)
    } catch {
        return undefined
    }
}

export function feeTransferLogMatches(
    log: { address?: string; topics?: readonly string[]; data?: string },
    input: { usdc: Address; from: Address; to: Address; value: bigint },
): boolean {
    if (!log.address) return false
    try {
        if (getAddress(log.address) !== getAddress(input.usdc)) return false
    } catch {
        return false
    }
    const topics = log.topics ?? []
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return false
    const from = topicAddress(topics[1])
    const to = topicAddress(topics[2])
    if (!from || !to) return false
    if (from !== getAddress(input.from) || to !== getAddress(input.to)) return false
    if (!log.data) return false
    try {
        return BigInt(log.data) === input.value
    } catch {
        return false
    }
}

/**
 * The pull counts only when the receipt succeeded and the fee arrived:
 * the recipient balance increased by exactly `value`, or the Transfer log
 * for that from/to/value is present.
 */
export function feePullConfirmed(input: {
    status: string
    logs: ReadonlyArray<{ address?: string; topics?: readonly string[]; data?: string }>
    usdc: Address
    from: Address
    to: Address
    value: bigint
    balanceBefore: bigint
    balanceAfter: bigint
}): boolean {
    if (input.status !== 'success') return false
    if (input.balanceAfter - input.balanceBefore === input.value) return true
    return input.logs.some((log) => feeTransferLogMatches(log, input))
}

export function splitEip3009Signature(signature: Hex): { v: number; r: Hex; s: Hex } {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error('Paid upgrade fee signature is invalid')
    }
    const r = `0x${signature.slice(2, 66)}` as Hex
    const s = `0x${signature.slice(66, 130)}` as Hex
    let v = Number.parseInt(signature.slice(130, 132), 16)
    if (v === 0 || v === 1) v += 27
    if (v !== 27 && v !== 28) throw new Error('Paid upgrade fee signature is invalid')
    return { v, r, s }
}

export function encodeReceiveWithAuthorization(input: {
    from: Address
    to: Address
    value: bigint
    validAfter: bigint
    validBefore: bigint
    nonce: Hex
    signature: Hex
}): Hex {
    const { v, r, s } = splitEip3009Signature(input.signature)
    return encodeFunctionData({
        abi: receiveWithAuthorizationAbi,
        functionName: 'receiveWithAuthorization',
        args: [
            getAddress(input.from),
            getAddress(input.to),
            input.value,
            input.validAfter,
            input.validBefore,
            input.nonce,
            v,
            r,
            s,
        ],
    })
}
