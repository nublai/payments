import { z } from 'incur'
import { getAddress, hashStruct, type Address, type Hex, type TypedData } from 'viem'

const jsonObjectSchema = z.object({}).passthrough()

const stringFieldSchema = z.string()

const bytes20Schema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

const uintAmountSchema = z.union([
    z.bigint(),
    z.number(),
    z.string().regex(/^[0-9]+$/),
])

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

const ORDER_EIP712_TYPES: TypedData = {
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

function requireEthereumChain(chainId: unknown, field: string): void {
    const parsed = stringFieldSchema.safeParse(chainId)

    if (!parsed.success || !ETHEREUM_VM_CHAINS.has(parsed.data)) {
        throw new RelayOrderRejected(
            `relay.link order ${field} is on ${String(chainId)}, which is not a chain this wallet can bind.`,
        )
    }
}

function requireBytes20(value: unknown, field: string): void {
    if (!bytes20Schema.safeParse(value).success) {
        throw new RelayOrderRejected(`relay.link order ${field} is not a 20-byte address.`)
    }
}

function assertOrder(order: {
    version?: unknown
    solverChainId?: unknown
    solver?: unknown
    salt?: unknown
    inputs?: unknown
    output?: unknown
    fees?: unknown
}): void {
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
        if (!jsonObjectSchema.safeParse(input).success) {
            throw new RelayOrderRejected('relay.link order input is malformed.')
        }

        // SAFETY: input schema accepted this as an object.
        const inputFields = input as { payment?: unknown; refunds?: unknown }

        if (!jsonObjectSchema.safeParse(inputFields.payment).success || !Array.isArray(inputFields.refunds)) {
            throw new RelayOrderRejected('relay.link order input is malformed.')
        }

        // SAFETY: payment schema accepted this as an object.
        const payment = inputFields.payment as { chainId?: unknown; currency?: unknown }

        requireEthereumChain(payment.chainId, 'input.chainId')
        requireBytes20(payment.currency, 'input.currency')

        for (const refund of inputFields.refunds) {
            if (!jsonObjectSchema.safeParse(refund).success) {
                throw new RelayOrderRejected('relay.link order refund is malformed.')
            }

            // SAFETY: refund schema accepted this as an object.
            const refundFields = refund as { chainId?: unknown; recipient?: unknown; currency?: unknown }

            requireEthereumChain(refundFields.chainId, 'refund.chainId')
            requireBytes20(refundFields.recipient, 'refund.recipient')
            requireBytes20(refundFields.currency, 'refund.currency')
        }
    }

    if (!jsonObjectSchema.safeParse(order.output).success) {
        throw new RelayOrderRejected('relay.link order is missing output payments.')
    }

    // SAFETY: output schema accepted this as an object.
    const output = order.output as { payments?: unknown; chainId?: unknown; calls?: unknown }

    if (!Array.isArray(output.payments)) {
        throw new RelayOrderRejected('relay.link order is missing output payments.')
    }

    requireEthereumChain(output.chainId, 'output.chainId')

    if (!Array.isArray(output.calls)) {
        throw new RelayOrderRejected('relay.link order is missing output calls.')
    }

    for (const payment of output.payments) {
        if (!jsonObjectSchema.safeParse(payment).success) {
            throw new RelayOrderRejected('relay.link order output payment is malformed.')
        }

        // SAFETY: payment schema accepted this as an object.
        const paymentFields = payment as { recipient?: unknown; currency?: unknown }

        requireBytes20(paymentFields.recipient, 'output.recipient')
        requireBytes20(paymentFields.currency, 'output.currency')
    }

    if (!Array.isArray(order.fees)) {
        throw new RelayOrderRejected('relay.link order is missing fees.')
    }

    for (const fee of order.fees) {
        if (!jsonObjectSchema.safeParse(fee).success) {
            throw new RelayOrderRejected('relay.link order fee is malformed.')
        }

        // SAFETY: fee schema accepted this as an object.
        const feeFields = fee as {
            recipientChainId?: unknown
            currencyChainId?: unknown
            recipient?: unknown
            currency?: unknown
        }

        requireEthereumChain(feeFields.recipientChainId, 'fee.recipientChainId')
        requireEthereumChain(feeFields.currencyChainId, 'fee.currencyChainId')
        requireBytes20(feeFields.recipient, 'fee.recipient')
        requireBytes20(feeFields.currency, 'fee.currency')
    }
}

/** `hashStruct` of the order. This is the deposit id, not the EIP-712 digest. */
export function hashRelayOrder(order: unknown): Hex {
    if (!jsonObjectSchema.safeParse(order).success) {
        throw new RelayOrderRejected('relay.link quote is missing protocol.v2.orderData.')
    }

    // SAFETY: order schema accepted this as an object; hashStruct reads the original value.
    assertOrder(order as {
        version?: unknown
        solverChainId?: unknown
        solver?: unknown
        salt?: unknown
        inputs?: unknown
        output?: unknown
        fees?: unknown
    })

    try {
        return hashStruct({
            types: ORDER_EIP712_TYPES,
            primaryType: 'Order',
            // SAFETY: assertOrder accepted the original parse object.
            data: order as {
                version?: unknown
                solverChainId?: unknown
                solver?: unknown
                salt?: unknown
                inputs?: unknown
                output?: unknown
                fees?: unknown
            },
        })
    } catch {
        throw new RelayOrderRejected('relay.link order could not be hashed. Refusing to sign.')
    }
}

function asUint(value: unknown, field: string): bigint {
    const parsed = uintAmountSchema.safeParse(value)

    if (!parsed.success) {
        throw new RelayOrderRejected(`relay.link order ${field} is not an amount.`)
    }

    try {
        if (Number.isFinite(parsed.data)) {
            const asNumber = Number(parsed.data)

            if (!Number.isInteger(asNumber) || asNumber < 0) {
                throw new RelayOrderRejected(`relay.link order ${field} is not an amount.`)
            }

            return BigInt(asNumber)
        }
    } catch (error) {
        if (error instanceof RelayOrderRejected) throw error

        const amount = BigInt(String(parsed.data))

        if (amount >= 0n) return amount
        throw new RelayOrderRejected(`relay.link order ${field} is not an amount.`)
    }

    const amount = BigInt(String(parsed.data))

    if (amount >= 0n) return amount
    throw new RelayOrderRejected(`relay.link order ${field} is not an amount.`)
}

function addressOf(value: unknown, field: string): Address {
    const parsed = stringFieldSchema.safeParse(value)

    if (!parsed.success) {
        throw new RelayOrderRejected(`relay.link order ${field} is not an address.`)
    }

    try {
        return getAddress(parsed.data)
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
    if (!jsonObjectSchema.safeParse(order).success) {
        throw new RelayOrderRejected('relay.link quote is missing protocol.v2.orderData.')
    }

    // SAFETY: order schema accepted this as an object.
    const orderFields = order as { solver?: unknown; output?: unknown; fees?: unknown }

    if (!jsonObjectSchema.safeParse(orderFields.output).success) {
        throw new RelayOrderRejected('relay.link quote is missing protocol.v2.orderData.')
    }

    // SAFETY: output schema accepted this as an object.
    const output = orderFields.output as { calls?: unknown; payments?: unknown }

    const solver = addressOf(orderFields.solver, 'solver')

    if (
        !isUserOrRecipient(solver, user, recipient) &&
        !KNOWN_RELAY_SOLVERS.has(solver.toLowerCase())
    ) {
        throw new RelayOrderRejected(
            `relay.link order solver ${solver} is not the user, the bridge recipient, or the Relay filler.`,
        )
    }

    const calls = output.calls

    if (!Array.isArray(calls) || calls.length > 0) {
        throw new RelayOrderRejected(
            'relay.link order output calls are not bound to the user or the bridge recipient.',
        )
    }

    if (!Array.isArray(output.payments)) {
        throw new RelayOrderRejected('relay.link order is missing output payments.')
    }

    for (const payment of output.payments) {
        if (!jsonObjectSchema.safeParse(payment).success) {
            throw new RelayOrderRejected('relay.link order output payment is malformed.')
        }

        // SAFETY: payment schema accepted this as an object.
        const paymentFields = payment as { minimumAmount?: unknown }

        if (asUint(paymentFields.minimumAmount, 'output.minimumAmount') === 0n) {
            throw new RelayOrderRejected(
                'relay.link order output minimum is 0. Refusing to sign.',
            )
        }
    }

    if (!Array.isArray(orderFields.fees)) {
        throw new RelayOrderRejected('relay.link order is missing fees.')
    }

    for (const fee of orderFields.fees) {
        if (!jsonObjectSchema.safeParse(fee).success) {
            throw new RelayOrderRejected('relay.link order fee is malformed.')
        }

        // SAFETY: fee schema accepted this as an object.
        const feeFields = fee as { recipient?: unknown }

        const payee = addressOf(feeFields.recipient, 'fee.recipient')

        if (!isUserOrRecipient(payee, user, recipient)) {
            throw new RelayOrderRejected(
                `relay.link order fee pays ${payee}, which is not the user or the bridge recipient.`,
            )
        }
    }
}

type OrderPayees = { outputs: string[]; refunds: string[] }

export function orderPayees(order: unknown): OrderPayees {
    if (!jsonObjectSchema.safeParse(order).success) {
        return { outputs: [], refunds: [] }
    }

    // SAFETY: order schema accepted this as an object.
    const orderFields = order as { output?: unknown; inputs?: unknown }

    if (!jsonObjectSchema.safeParse(orderFields.output).success || !Array.isArray(orderFields.inputs)) {
        return { outputs: [], refunds: [] }
    }

    // SAFETY: output schema accepted this as an object.
    const output = orderFields.output as { payments?: unknown }

    const outputs = Array.isArray(output.payments)
        ? output.payments
              .map((payment) => {
                  if (!jsonObjectSchema.safeParse(payment).success) return undefined
                  // SAFETY: payment schema accepted this as an object.
                  const recipient = (payment as { recipient?: unknown }).recipient
                  const parsed = stringFieldSchema.safeParse(recipient)

                  return parsed.success ? parsed.data : undefined
              })
              .filter((value): value is string => value !== undefined)
        : []

    const refunds = orderFields.inputs.flatMap((input) => {
        if (!jsonObjectSchema.safeParse(input).success) return []

        // SAFETY: input schema accepted this as an object.
        const inputFields = input as { refunds?: unknown }

        if (!Array.isArray(inputFields.refunds)) return []

        return inputFields.refunds
            .map((refund) => {
                if (!jsonObjectSchema.safeParse(refund).success) return undefined
                // SAFETY: refund schema accepted this as an object.
                const recipient = (refund as { recipient?: unknown }).recipient
                const parsed = stringFieldSchema.safeParse(recipient)

                return parsed.success ? parsed.data : undefined
            })
            .filter((value): value is string => value !== undefined)
    })

    return { outputs, refunds }
}
