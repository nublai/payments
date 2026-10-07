import { expect, test } from 'bun:test'
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
