import { getAddress, hashStruct, type Address, type Hex } from 'viem'

/**
 * Deposit ids are the EIP-712 struct hash of Relay's v1 Order, which the
 * quote API returns as `protocol.v2.orderData` (the `version` field inside
 * that object is `"v1"`). `requestId` is a different value.
 *
 * Type and `hashStruct` encoding:
 * https://github.com/relayprotocol/relay-settlement/blob/b2f3e0e5fba9381293f030ef340ffb4872687fcf/packages/sdk/src/order/index.ts
 * (`ORDER_EIP712_TYPES`, `getOrderId`). Commit b2f3e0e5fba9381293f030ef340ffb4872687fcf.
 *
 * Checked against the saved quote in
 * `packages/wallet/tests/fixtures/relay-base-usdc-polygon-quote.json`
 * (Base USDC → Polygon USDC, 2026-10-07): `protocol.v2.orderId`, the
 * `depositErc20` id word, and this hash were all
 * `0x5f4c9669be204ca72130c08d1afedcd63d6bd0944bedde4a04f7c340b074468a`.
 * A later live quote hashes to a different id. The function matches the
 * quote it is given; it does not reproduce one historical id for every quote.
 *
 * The solver on that fixture is `0xf70da97812cb96acdf810712aa562db8dfa3dbef`.
 * That address is Relay's filler, not an output payment. Any other solver
 * is rejected. Fees and `output.calls` still cannot pay a third party.
 *
 * Bytes fields are hashed as the 20-byte address the quote already carries.
 * Chain names we have not mapped fail closed. The v2 Order struct in that
 * file is a different type; live quotes still use version `"v1"`.
 */

const ORDER_EIP712_TYPES = {
    Order: [
        { name: 'version', type: 'string' },
        { name: 'solverChainId', type: 'string' },
        { name: 'solver', type: 'address' },
        { name: 'salt', type: 'uint256' },
        { name: 'inputs', type: 'Input[]' },
        { name: 'output', type: 'Output' },
        { name: 'fees', type: 'Fee[]' },
    ],
    Input: [
        { name: 'payment', type: 'InputPayment' },
        { name: 'refunds', type: 'InputRefund[]' },
    ],
    InputPayment: [
        { name: 'chainId', type: 'string' },
        { name: 'currency', type: 'bytes' },
        { name: 'amount', type: 'uint256' },
        { name: 'weight', type: 'uint256' },
    ],
    InputRefund: [
        { name: 'chainId', type: 'string' },
        { name: 'recipient', type: 'bytes' },
        { name: 'currency', type: 'bytes' },
        { name: 'minimumAmount', type: 'uint256' },
        { name: 'deadline', type: 'uint32' },
        { name: 'extraData', type: 'bytes' },
    ],
    Output: [
        { name: 'chainId', type: 'string' },
        { name: 'payments', type: 'OutputPayment[]' },
        { name: 'deadline', type: 'uint32' },
        { name: 'calls', type: 'bytes[]' },
        { name: 'extraData', type: 'bytes' },
    ],
    OutputPayment: [
        { name: 'recipient', type: 'bytes' },
        { name: 'currency', type: 'bytes' },
        { name: 'minimumAmount', type: 'uint256' },
        { name: 'expectedAmount', type: 'uint256' },
    ],
    Fee: [
        { name: 'recipientChainId', type: 'string' },
        { name: 'recipient', type: 'bytes' },
        { name: 'currencyChainId', type: 'string' },
        { name: 'currency', type: 'bytes' },
        { name: 'amount', type: 'uint256' },
    ],
} as const

/** Chains whose addresses are 20-byte EVM values in Relay's order encoding. */
const ETHEREUM_VM_CHAINS = new Set(['base', 'polygon', '8453', '137'])

/**
 * Filler on the checked Base → Polygon quote. Not a payment destination.
 * A solver outside this set, the user, and the bridge recipient is rejected.
 */
const KNOWN_RELAY_SOLVERS = new Set(['0xf70da97812cb96acdf810712aa562db8dfa3dbef'])

export class RelayOrderRejected extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RelayOrderRejected'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireEthereumChain(chainId: unknown, field: string): void {
    if (typeof chainId !== 'string' || !ETHEREUM_VM_CHAINS.has(chainId)) {
        throw new RelayOrderRejected(
            `relay.link order ${field} is on ${String(chainId)}, which is not a chain this wallet can bind.`,
        )
    }
}

function requireBytes20(value: unknown, field: string): void {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new RelayOrderRejected(`relay.link order ${field} is not a 20-byte address.`)
    }
}

function assertOrderShape(order: Record<string, unknown>): void {
    if (order.version !== 'v1') {
        throw new RelayOrderRejected(
            'relay.link order version is not v1. Refusing to bind the deposit id.',
        )
    }
    requireEthereumChain(order.solverChainId, 'solverChainId')
    requireBytes20(order.solver, 'solver')
    if (!Array.isArray(order.inputs) || order.inputs.length === 0) {
        throw new RelayOrderRejected('relay.link order is missing inputs.')
    }
    for (const input of order.inputs) {
        if (!isRecord(input) || !isRecord(input.payment) || !Array.isArray(input.refunds)) {
            throw new RelayOrderRejected('relay.link order input is malformed.')
        }
        requireEthereumChain(input.payment.chainId, 'input.chainId')
        requireBytes20(input.payment.currency, 'input.currency')
        for (const refund of input.refunds) {
            if (!isRecord(refund)) {
                throw new RelayOrderRejected('relay.link order refund is malformed.')
            }
            requireEthereumChain(refund.chainId, 'refund.chainId')
            requireBytes20(refund.recipient, 'refund.recipient')
            requireBytes20(refund.currency, 'refund.currency')
        }
    }
    if (!isRecord(order.output) || !Array.isArray(order.output.payments)) {
        throw new RelayOrderRejected('relay.link order is missing output payments.')
    }
    requireEthereumChain(order.output.chainId, 'output.chainId')
    if (!Array.isArray(order.output.calls)) {
        throw new RelayOrderRejected('relay.link order is missing output calls.')
    }
    for (const payment of order.output.payments) {
        if (!isRecord(payment)) {
            throw new RelayOrderRejected('relay.link order output payment is malformed.')
        }
        requireBytes20(payment.recipient, 'output.recipient')
        requireBytes20(payment.currency, 'output.currency')
    }
    if (!Array.isArray(order.fees)) {
        throw new RelayOrderRejected('relay.link order is missing fees.')
    }
    for (const fee of order.fees) {
        if (!isRecord(fee)) {
            throw new RelayOrderRejected('relay.link order fee is malformed.')
        }
        requireEthereumChain(fee.recipientChainId, 'fee.recipientChainId')
        requireEthereumChain(fee.currencyChainId, 'fee.currencyChainId')
        requireBytes20(fee.recipient, 'fee.recipient')
        requireBytes20(fee.currency, 'fee.currency')
    }
}

/** `hashStruct` of the order. This is the deposit id, not the EIP-712 digest. */
export function hashRelayOrder(order: unknown): Hex {
    if (!isRecord(order)) {
        throw new RelayOrderRejected('relay.link quote is missing protocol.v2.orderData.')
    }
    assertOrderShape(order)
    try {
        return hashStruct({
            types: ORDER_EIP712_TYPES,
            primaryType: 'Order',
            data: order,
        })
    } catch {
        throw new RelayOrderRejected('relay.link order could not be hashed. Refusing to sign.')
    }
}

function asUint(value: unknown, field: string): bigint {
    if (typeof value === 'bigint' && value >= 0n) return value
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value)
    if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value)
    throw new RelayOrderRejected(`relay.link order ${field} is not an amount.`)
}

function addressOf(value: unknown, field: string): Address {
    if (typeof value !== 'string') {
        throw new RelayOrderRejected(`relay.link order ${field} is not an address.`)
    }
    try {
        return getAddress(value)
    } catch {
        throw new RelayOrderRejected(`relay.link order ${field} is not an address.`)
    }
}

function isUserOrRecipient(address: Address, user: Address, recipient: Address): boolean {
    const normalized = address.toLowerCase()
    return normalized === user.toLowerCase() || normalized === recipient.toLowerCase()
}

/**
 * Fees, solver, and output calls are not covered by the output-payment check.
 * A fee or a non-empty output call can pay someone the deposit id does not name.
 * The known Relay filler may be the solver. It may not be a fee recipient.
 */
export function assertOrderRecipients(order: unknown, user: Address, recipient: Address): void {
    if (!isRecord(order) || !isRecord(order.output)) {
        throw new RelayOrderRejected('relay.link quote is missing protocol.v2.orderData.')
    }
    const solver = addressOf(order.solver, 'solver')
    if (
        !isUserOrRecipient(solver, user, recipient) &&
        !KNOWN_RELAY_SOLVERS.has(solver.toLowerCase())
    ) {
        throw new RelayOrderRejected(
            `relay.link order solver ${solver} is not the user, the bridge recipient, or the Relay filler.`,
        )
    }
    const calls = order.output.calls
    if (!Array.isArray(calls) || calls.length > 0) {
        throw new RelayOrderRejected(
            'relay.link order output calls are not bound to the user or the bridge recipient.',
        )
    }
    if (!Array.isArray(order.output.payments)) {
        throw new RelayOrderRejected('relay.link order is missing output payments.')
    }
    for (const payment of order.output.payments) {
        if (!isRecord(payment)) {
            throw new RelayOrderRejected('relay.link order output payment is malformed.')
        }
        if (asUint(payment.minimumAmount, 'output.minimumAmount') === 0n) {
            throw new RelayOrderRejected(
                'relay.link order output minimum is 0. Refusing to sign.',
            )
        }
    }
    if (!Array.isArray(order.fees)) {
        throw new RelayOrderRejected('relay.link order is missing fees.')
    }
    for (const fee of order.fees) {
        if (!isRecord(fee)) {
            throw new RelayOrderRejected('relay.link order fee is malformed.')
        }
        const payee = addressOf(fee.recipient, 'fee.recipient')
        if (!isUserOrRecipient(payee, user, recipient)) {
            throw new RelayOrderRejected(
                `relay.link order fee pays ${payee}, which is not the user or the bridge recipient.`,
            )
        }
    }
}

export function orderPayees(order: unknown): { outputs: string[]; refunds: string[] } {
    if (!isRecord(order) || !isRecord(order.output) || !Array.isArray(order.inputs)) {
        return { outputs: [], refunds: [] }
    }
    const outputs = Array.isArray(order.output.payments)
        ? order.output.payments
              .map((payment) => (isRecord(payment) ? payment.recipient : undefined))
              .filter((value): value is string => typeof value === 'string')
        : []
    const refunds = order.inputs.flatMap((input) => {
        if (!isRecord(input) || !Array.isArray(input.refunds)) return []
        return input.refunds
            .map((refund) => (isRecord(refund) ? refund.recipient : undefined))
            .filter((value): value is string => typeof value === 'string')
    })
    return { outputs, refunds }
}
