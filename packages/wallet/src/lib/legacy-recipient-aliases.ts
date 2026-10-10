import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LEGACY_RECIPIENT_ALIASES_VERSION = 1 as const

function normalizeLegacyAlias(alias: string): string {
    return alias.trim().toLowerCase()
}

function resolveLegacyRecipientAliasesPath(): string {
    return join(homedir(), '.config', 'agentic-payments', 'tw', 'contacts.json')
}

async function readLegacyRecipientAliasesContacts(): Promise<string[]> {
    const path = resolveLegacyRecipientAliasesPath()
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)

    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('version' in parsed) ||
        parsed.version !== LEGACY_RECIPIENT_ALIASES_VERSION ||
        !('contacts' in parsed) ||
        typeof parsed.contacts !== 'object' ||
        parsed.contacts === null
    ) {
        throw new Error(`Unsupported legacy recipient aliases file at ${path}.`)
    }

    return Object.keys(parsed.contacts)
}

export async function hasLegacyRecipientAlias(input: string): Promise<boolean> {
    try {
        const aliases = await readLegacyRecipientAliasesContacts()
        const normalizedAlias = normalizeLegacyAlias(input)

        return aliases.some((alias) => normalizeLegacyAlias(alias) === normalizedAlias)
    } catch {
        return false
    }
}
