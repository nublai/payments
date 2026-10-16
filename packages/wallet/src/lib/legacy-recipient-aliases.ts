import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'incur'

const LEGACY_RECIPIENT_ALIASES_VERSION = 1 as const

const legacyRecipientAliasesFileSchema = z
    .object({
        version: z.literal(LEGACY_RECIPIENT_ALIASES_VERSION),
        contacts: z.union([z.object({}).passthrough(), z.array(z.unknown())]),
    })
    .passthrough()

function normalizeLegacyAlias(alias: string): string {
    return alias.trim().toLowerCase()
}

function resolveLegacyRecipientAliasesPath(): string {
    return join(homedir(), '.config', 'nubl', 'contacts.json')
}

async function readLegacyRecipientAliasesContacts(): Promise<string[]> {
    const path = resolveLegacyRecipientAliasesPath()
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const file = legacyRecipientAliasesFileSchema.safeParse(parsed)

    if (!file.success) {
        throw new Error(`Unsupported legacy recipient aliases file at ${path}.`)
    }

    // SAFETY: schema accepted contacts as an object; keys come from the original parse
    // so an own __proto__ key is kept.
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
