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

async function readLegacyRecipientAliasesContacts(): Promise<Record<string, string>> {
    const path = resolveLegacyRecipientAliasesPath()
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Unsupported legacy recipient aliases file at ${path}.`)
    }

    if (!('version' in parsed) || parsed.version !== LEGACY_RECIPIENT_ALIASES_VERSION) {
        throw new Error(`Unsupported legacy recipient aliases file at ${path}.`)
    }

    if (
        !('contacts' in parsed) ||
        typeof parsed.contacts !== 'object' ||
        parsed.contacts === null ||
        Array.isArray(parsed.contacts)
    ) {
        throw new Error(`Unsupported legacy recipient aliases file at ${path}.`)
    }

    const contacts: Record<string, string> = {}

    for (const [key, value] of Object.entries(parsed.contacts)) {
        if (typeof value !== 'string') {
            throw new Error(`Unsupported legacy recipient aliases file at ${path}.`)
        }

        contacts[key] = value
    }

    return contacts
}

export async function hasLegacyRecipientAlias(input: string): Promise<boolean> {
    try {
        const contacts = await readLegacyRecipientAliasesContacts()
        const normalizedAlias = normalizeLegacyAlias(input)

        return Object.keys(contacts).some(
            (alias) => normalizeLegacyAlias(alias) === normalizedAlias,
        )
    } catch {
        return false
    }
}
