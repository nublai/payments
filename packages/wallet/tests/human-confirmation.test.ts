import { expect, test } from 'bun:test'
import { toFunctionSelector } from 'viem'
import { ERC20_SELECTORS, ANY_FUNCTION_SELECTOR, ANY_TARGET } from '@nubl/relayer-client'
import {
    DEFAULT_SESSION_SPEND_LIMIT,
    permissionNeedsFullAccessConfirmation,
} from '../src/lib/session-common'
import {
    humanConfirmationMessage,
    quoteConfirmationMessage,
    requireHumanConfirmation,
} from '../src/lib/human-confirmation'

test('requireHumanConfirmation rejects MCP and non-interactive callers and accepts a matching TTY phrase', async () => {
    await expect(
        requireHumanConfirmation({
            operation: 'Sending USDC',
            phrase: 'SEND USDC',
            mcp: true,
            interactive: true,
            prompt: async () => true,
        }),
    ).rejects.toThrow('HUMAN_CONFIRMATION_REQUIRED')

    await expect(
        requireHumanConfirmation({
            operation: 'Sending USDC',
            phrase: 'SEND USDC',
            mcp: false,
            interactive: false,
            prompt: async () => {
                throw new Error('non-interactive caller must not be prompted')
            },
        }),
    ).rejects.toThrow('MCP and non-interactive callers cannot set or bypass')

    await expect(
        requireHumanConfirmation({
            operation: 'Sending USDC',
            phrase: 'SEND USDC',
            mcp: false,
            interactive: true,
            prompt: async () => false,
        }),
    ).rejects.toThrow('confirmation did not match')

    await expect(
        requireHumanConfirmation({
            operation: 'Sending USDC',
            phrase: 'SEND USDC',
            mcp: false,
            interactive: true,
            prompt: async (phrase) => phrase === 'SEND USDC',
        }),
    ).resolves.toBeUndefined()

    expect(humanConfirmationMessage('Sending USDC', 'SEND USDC')).toContain('SEND USDC')
    expect(quoteConfirmationMessage('swap')).toContain('cannot pass yes')
    expect(quoteConfirmationMessage('bridge')).toContain('tw bridge')
})

test('permissionNeedsFullAccessConfirmation treats wildcards, the account, admin selectors, and spend above 10 USDC as full access', () => {
    expect(permissionNeedsFullAccessConfirmation({})).toBe(false)
    expect(
        permissionNeedsFullAccessConfirmation({
            target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            selectors: [ERC20_SELECTORS.TRANSFER],
            spendLimit: DEFAULT_SESSION_SPEND_LIMIT,
        }),
    ).toBe(false)
    expect(permissionNeedsFullAccessConfirmation({ fullAccess: true })).toBe(true)
    expect(
        permissionNeedsFullAccessConfirmation({
            fullAccess: false,
            target: ANY_TARGET,
            selectors: [ANY_FUNCTION_SELECTOR],
            spendLimit: 2n ** 256n - 1n,
        }),
    ).toBe(true)
    expect(
        permissionNeedsFullAccessConfirmation({
            spendLimit: DEFAULT_SESSION_SPEND_LIMIT + 1n,
        }),
    ).toBe(true)
    expect(
        permissionNeedsFullAccessConfirmation({
            selectors: [toFunctionSelector('revoke(bytes32)')],
        }),
    ).toBe(true)
    expect(
        permissionNeedsFullAccessConfirmation({
            target: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
            accountAddresses: ['0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a'],
        }),
    ).toBe(true)
})

const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

test('permissionNeedsFullAccessConfirmation treats short periods and non-USDC tokens as full access', () => {
    expect(
        permissionNeedsFullAccessConfirmation({
            spendPeriod: 'minute',
            defaultUsdcSpend: true,
            usdcAddress: usdc,
        }),
    ).toBe(true)
    expect(
        permissionNeedsFullAccessConfirmation({
            spendPeriod: 'hour',
            spendLimit: DEFAULT_SESSION_SPEND_LIMIT,
            usdcAddress: usdc,
        }),
    ).toBe(true)
    expect(
        permissionNeedsFullAccessConfirmation({
            defaultUsdcSpend: true,
            usdcAddress: usdc,
        }),
    ).toBe(false)
    expect(
        permissionNeedsFullAccessConfirmation({
            spendPeriod: 'day',
            spendLimit: DEFAULT_SESSION_SPEND_LIMIT,
            token: usdc,
            usdcAddress: usdc,
        }),
    ).toBe(false)
    expect(
        permissionNeedsFullAccessConfirmation({
            spendPeriod: 'week',
            spendLimit: DEFAULT_SESSION_SPEND_LIMIT * 7n,
            token: usdc,
            usdcAddress: usdc,
        }),
    ).toBe(true)
    expect(
        permissionNeedsFullAccessConfirmation({
            spendPeriod: 'forever',
            spendLimit: DEFAULT_SESSION_SPEND_LIMIT,
            token: usdc,
            usdcAddress: usdc,
        }),
    ).toBe(false)
    expect(
        permissionNeedsFullAccessConfirmation({
            spendPeriod: 'minute',
            spendLimit: DEFAULT_SESSION_SPEND_LIMIT,
            token: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
            usdcAddress: usdc,
        }),
    ).toBe(true)
    expect(
        permissionNeedsFullAccessConfirmation({
            spendPeriod: 'minute',
            spendLimit: DEFAULT_SESSION_SPEND_LIMIT,
            token: '0x0000000000000000000000000000000000000000',
            usdcAddress: usdc,
        }),
    ).toBe(true)
    expect(
        permissionNeedsFullAccessConfirmation({
            spendPeriod: 'minute',
            spendLimit: DEFAULT_SESSION_SPEND_LIMIT,
            token: '0x0000000000000000000000000000000000000001',
            usdcAddress: usdc,
        }),
    ).toBe(true)
})
