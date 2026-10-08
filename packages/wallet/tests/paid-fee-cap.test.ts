import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { installFormerProdDeployments } from './helpers/former-deployment-env'

let restoreFormerProdDeployments = () => {}

beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})

afterAll(() => {
    restoreFormerProdDeployments()
})

import type { Address } from 'viem'
import {
    executeAccountSend,
    type AccountSendDeps,
    type AccountSendOptions,
} from '../src/lib/account-send'
import { confirmedBundle } from './helpers/bundle-status'
import { testKeystoreBundle } from './helpers/keystore-bundle'
import { matchingPreparedCalls } from './helpers/matching-prepared'

/** Wallet-chosen cap. Kept literal so this file loads on the pre-fix commit. */
const PAID_FEE_CAP = 5_000_000n

const SENDER = '0x1111111111111111111111111111111111111111'

const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'

const SESSION_KEY =
    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' as const

function sendDeps(prepareCalls: ReturnType<typeof mock>, signTypedData = mock(async () =>
    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
)) {
    const sendPreparedCalls = mock(async () => ({ id: 'bundle-1' }))

    const deps: Partial<AccountSendDeps> = {
        readKeystoreBundle: mock(async () => testKeystoreBundle(SENDER)),
        decryptSessionKeystore: mock(async () => ({
            sessionPrivateKey: SESSION_KEY,
        })),
        resolveAddressOrEnsInput: mock(async () => ({
            address: '0x2222222222222222222222222222222222222222',
            ens: null,
        })),
        hasLegacyRecipientAlias: mock(async () => false),
        readNonce: mock(async () => 2n),
        prepareCalls,
        signTypedData,
        sendPreparedCalls,
        waitForBundle: mock(async () => confirmedBundle()),
    }

    return {
        signTypedData,
        sendPreparedCalls,
        deps,
    }
}

const sendOptions: AccountSendOptions = {
    env: 'prod' as const,
    amount: '1',
    recipient: '0x2222222222222222222222222222222222222222',
    chain: 'polygon',
    password: 'pw',
    keystorePath: '/tmp/alice.json',
}

test('prod send chooses a non-zero fee cap instead of copying a quote', async () => {
    const prepareCalls = mock(async (input) => matchingPreparedCalls(input))
    const { deps } = sendDeps(prepareCalls)
    await executeAccountSend(sendOptions, deps)

    const prepareInput: {
        payer?: Address
        paymentToken?: Address
        paymentMaxAmount?: bigint
    } = prepareCalls.mock.calls[0]?.[0]

    expect(prepareInput.payer).toBe(SENDER)
    expect(prepareInput.paymentToken).toBe(POLYGON_USDC)
    expect(prepareInput.paymentMaxAmount).toBe(PAID_FEE_CAP)
})

test('prod send signs a non-zero quote at or under the wallet fee cap', async () => {
    const signTypedData = mock(async () =>
        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
    )

    const prepareCalls = mock(async (input) => {
        const prepared = matchingPreparedCalls(input)
        const quote = prepared.context.quote.quotes[0]

        if (!quote) throw new Error('prepared fixture has no quote')

        quote.paymentAmount = '250000'

        return prepared
    })

    const { deps, sendPreparedCalls } = sendDeps(prepareCalls, signTypedData)
    const result = await executeAccountSend(sendOptions, deps)
    expect(result.status).toBe('complete')
    expect(signTypedData).toHaveBeenCalled()
    expect(sendPreparedCalls).toHaveBeenCalled()
})

test('prod send refuses a quote payment above the wallet fee cap', async () => {
    const signTypedData = mock(async () =>
        '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as const,
    )

    const prepareCalls = mock(async (input) => {
        const prepared = matchingPreparedCalls(input)
        const quote = prepared.context.quote.quotes[0]

        if (!quote) throw new Error('prepared fixture has no quote')

        quote.paymentAmount = (PAID_FEE_CAP + 1n).toString()

        return prepared
    })

    const { deps, sendPreparedCalls } = sendDeps(prepareCalls, signTypedData)
    await expect(executeAccountSend(sendOptions, deps)).rejects.toThrow(
        /payment amount exceeds fee cap/,
    )
    expect(signTypedData).not.toHaveBeenCalled()
    expect(sendPreparedCalls).not.toHaveBeenCalled()
})
