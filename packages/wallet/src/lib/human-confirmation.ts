import { createInterface } from 'node:readline'
import { PromptCancelledError } from './password-readline'

/**
 * Confirmation for operations a prompt-injected MCP client or a non-TTY `tw`
 * must not be able to complete by itself. The phrase is read from an
 * interactive terminal. `TW_PASSWORD`, `--yes`, and raw private-key arguments
 * are not accepted as substitutes.
 */
export class HumanConfirmationError extends Error {
    readonly code = 'HUMAN_CONFIRMATION_REQUIRED' as const

    constructor(message: string) {
        super(message)
        this.name = 'HumanConfirmationError'
    }
}

export const CONFIRM_SEND_PHRASE = 'SEND USDC'
export const CONFIRM_FULL_ACCESS_PHRASE = 'CREATE FULL ACCESS SESSION'
export const CONFIRM_ROTATE_FULL_ACCESS_PHRASE = 'ROTATE FULL ACCESS SESSION'
export const CONFIRM_PASSKEY_PHRASE = 'AUTHORIZE PASSKEY'
export const CONFIRM_ORACLE_SIGN_PHRASE = 'SIGN ESCROW SETTLEMENT'

export function isMcpCaller(argv: readonly string[] = process.argv): boolean {
    return argv.includes('--mcp')
}

export function isInteractiveTerminal(
    stdin: { isTTY?: boolean } = process.stdin,
    stdout: { isTTY?: boolean } = process.stdout,
): boolean {
    return stdin.isTTY === true && stdout.isTTY === true
}

export function humanConfirmationMessage(operation: string, phrase: string): string {
    return `HUMAN_CONFIRMATION_REQUIRED: ${operation} requires a human at an interactive terminal. Type "${phrase}" when prompted. MCP and non-interactive callers cannot set or bypass this confirmation.`
}

export function quoteConfirmationMessage(kind: 'swap' | 'bridge'): string {
    return `HUMAN_CONFIRMATION_REQUIRED: ${kind} requires a human at an interactive terminal. MCP and non-interactive callers cannot pass yes to skip the quote confirmation. Run \`tw ${kind}\` in a terminal.`
}

export function privateKeyMcpRefusal(operation: string, phrase: string): string {
    return `HUMAN_CONFIRMATION_REQUIRED: ${operation} does not accept a raw private key over MCP. Run the command in an interactive terminal and type "${phrase}" when prompted.`
}

export async function requireHumanConfirmation(input: {
    operation: string
    phrase: string
    prompt: (phrase: string) => Promise<boolean>
    mcp?: boolean
    interactive?: boolean
}): Promise<void> {
    const mcp = input.mcp ?? isMcpCaller()
    const interactive = input.interactive ?? isInteractiveTerminal()
    if (mcp || !interactive) {
        throw new HumanConfirmationError(humanConfirmationMessage(input.operation, input.phrase))
    }

    const confirmed = await input.prompt(input.phrase)
    if (!confirmed) {
        throw new HumanConfirmationError(
            `HUMAN_CONFIRMATION_REQUIRED: confirmation did not match. Type "${input.phrase}" exactly.`,
        )
    }
}

/** Line prompt on stderr. Only call this after `isInteractiveTerminal()` is true. */
export function promptTerminalPhrase(expectedPhrase: string): Promise<boolean> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
    })
    return new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void) => {
            if (settled) return
            settled = true
            rl.close()
            fn()
        }
        rl.once('line', (line) => {
            finish(() => resolve(line.trim() === expectedPhrase))
        })
        rl.once('close', () => {
            finish(() => reject(new PromptCancelledError()))
        })
        // Listen before the prompt so a PTY helper can answer as soon as it sees it.
        process.stderr.write(`Type "${expectedPhrase}" to confirm:\n`)
    })
}
