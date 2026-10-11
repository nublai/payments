import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const LEGACY_RECIPIENT_ALIASES_VERSION = 1 as const

const legacyRecipientAliasesFileSchema = z
    .object({
        version: z.unknown(),
        contacts: z.unknown(),
    })
    .passthrough()

const contactsSchema = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())])

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
    const file = legacyRecipientAliasesFileSchema.safeParse(parsed)
    const contacts = file.success ? contactsSchema.safeParse(file.data.contacts) : undefined

    if (
        !file.success ||
        file.data.version !== LEGACY_RECIPIENT_ALIASES_VERSION ||
        !contacts?.success
    ) {
        throw new Error(`Unsupported legacy recipient aliases file at ${path}.`)
    }

    // SAFETY: contacts was accepted as a JSON object; keys come from the original parse.
    return Object.keys((parsed as { contacts: object }).contacts)
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
