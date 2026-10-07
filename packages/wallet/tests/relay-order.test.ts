import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { hashRelayOrder } from '../src/lib/relay-order'

const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/relay-base-usdc-polygon-quote.json', import.meta.url), 'utf8'),
) as {
    requestId: string
    orderId: string
    orderData: unknown
    deposit: { data: string }
}

test('hashRelayOrder matches the live quote order id and not the request id', () => {
    const hash = hashRelayOrder(fixture.orderData)
    expect(hash).toBe(fixture.orderId)
    expect(hash).not.toBe(fixture.requestId)
    expect(fixture.deposit.data.endsWith(fixture.orderId.slice(2))).toBe(true)
    expect(fixture.deposit.data.length).toBe(2 + 8 + 64 * 4)
})
