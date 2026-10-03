import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
    assertAgentPasswordAvailable,
    normalizeChannelSecret,
    parseAgentName,
    parseChannelName,
    resolveAgentName,
} from '../src/lib/agent-identifiers'
import {
    checkAgentListenPid,
    claimAgentListenPid,
    resolveAgentListenPidPath,
} from '../src/lib/agent-runtime'

test('parseAgentName trims valid values and rejects uppercase names', () => {
    expect(parseAgentName('alice-1')).toBe('alice-1')
    expect(parseAgentName('  alice-1  ')).toBe('alice-1')
    expect(() => parseAgentName('Alice')).toThrow(
        'Use lowercase letters, numbers, and hyphens only.',
    )
})

test('resolveAgentName prefers --from over TW_AGENT and falls back to the environment', () => {
    expect(resolveAgentName({ from: 'alice' }, { TW_AGENT: 'bob' })).toBe('alice')
    expect(resolveAgentName({}, { TW_AGENT: 'bob' })).toBe('bob')
    expect(() => resolveAgentName({}, {})).toThrow(
        'No agent specified. Use --from <name> or set TW_AGENT environment variable.',
    )
})

test('parseChannelName normalizes case and validates separators', () => {
    expect(parseChannelName(' Art_Topic ')).toBe('art_topic')
    expect(parseChannelName('marketing-1')).toBe('marketing-1')
    expect(() => parseChannelName('bad topic')).toThrow(
        'Use lowercase letters, numbers, hyphens, or underscores.',
    )
})

test('normalizeChannelSecret trims input and rejects empty secrets', () => {
    expect(normalizeChannelSecret('  shared-secret  ')).toBe('shared-secret')
    expect(() => normalizeChannelSecret('   ')).toThrow('Channel secret cannot be empty.')
})

test('assertAgentPasswordAvailable requires TW_PASSWORD for non-interactive agent commands', () => {
    expect(() =>
        assertAgentPasswordAvailable({
            envPassword: 'pw',
            passwordStdin: false,
            isInteractive: false,
        }),
    ).not.toThrow()
    expect(() =>
        assertAgentPasswordAvailable({
            envPassword: undefined,
            passwordStdin: true,
            isInteractive: false,
        }),
    ).not.toThrow()
    expect(() =>
        assertAgentPasswordAvailable({
            envPassword: undefined,
            passwordStdin: false,
            isInteractive: true,
        }),
    ).not.toThrow()
    expect(() =>
        assertAgentPasswordAvailable({
            envPassword: undefined,
            passwordStdin: false,
            isInteractive: false,
        }),
    ).toThrow('Password required. Set TW_PASSWORD environment variable for non-interactive use.')
})

test('checkAgentListenPid removes invalid pid files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wallet-agent-pid-invalid-'))
    const sessionPath = join(dir, 'agent-alice.json')
    const pidPath = resolveAgentListenPidPath(sessionPath)

    try {
        await writeFile(pidPath, 'not-a-pid\n', 'utf8')

        await expect(checkAgentListenPid(sessionPath)).resolves.toEqual({
            active: false,
            pidPath,
        })
        await expect(readFile(pidPath, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test('claimAgentListenPid replaces stale pid files and release removes the claim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wallet-agent-pid-stale-'))
    const sessionPath = join(dir, 'agent-alice.json')
    const pidPath = resolveAgentListenPidPath(sessionPath)

    try {
        await writeFile(pidPath, '999999\n', 'utf8')

        const claim = await claimAgentListenPid(sessionPath)
        expect(claim.pidPath).toBe(pidPath)
        expect(await readFile(pidPath, 'utf8')).toBe(`${process.pid}\n`)

        await claim.release()

        await expect(readFile(pidPath, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
