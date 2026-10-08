import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { hasLegacyRecipientAlias } from '../src/lib/legacy-recipient-aliases'

async function withLegacyContactsFile<T>(contents: unknown, run: () => Promise<T>): Promise<T> {
    const contactsPath = join(homedir(), '.config', 'agentic-payments', 'tw', 'contacts.json')
    let previousContents: string | null = null

    try {
        previousContents = await readFile(contactsPath, 'utf8').catch(() => null)
        await mkdir(join(homedir(), '.config', 'agentic-payments', 'tw'), { recursive: true })
        await writeFile(contactsPath, `${JSON.stringify(contents)}\n`, 'utf8')

        return await run()
    } finally {
        if (previousContents === null) {
            await rm(contactsPath, { force: true })
        } else {
            await writeFile(contactsPath, previousContents, 'utf8')
        }
    }
}

test('hasLegacyRecipientAlias matches a valid alias even when another entry is malformed', async () => {
    await withLegacyContactsFile(
        {
            version: 1,
            contacts: {
                Vitalik: {
                    address: '0x1111111111111111111111111111111111111111',
                    ens: null,
                },
                broken: {
                    address: 123,
                    ens: null,
                },
            },
        },
        async () => {
            await expect(hasLegacyRecipientAlias('vitalik')).resolves.toBe(true)
        },
    )
})

test('hasLegacyRecipientAlias returns false for unsupported top-level file shapes', async () => {
    await withLegacyContactsFile(
        {
            version: 1,
            contacts: null,
        },
        async () => {
            await expect(hasLegacyRecipientAlias('vitalik')).resolves.toBe(false)
        },
    )
})
