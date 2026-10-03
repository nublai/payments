import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
    checkAgentListenPid,
    claimAgentListenPid,
    resolveAgentListenPidPath,
} from '../src/lib/agent-runtime'

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
