import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const walletDir = resolve(import.meta.dir, '..')

const missingEnvMessage =
    'Missing --env. Pass `--env prod`, `--env stage`, or `--env dev`.'

function runCli(args: string[]) {
    const home = mkdtempSync(join(tmpdir(), 'tw-env-required-'))

    return spawnSync('bun', ['./src/cli.ts', ...args], {
        cwd: walletDir,
        encoding: 'utf8',
        env: {
            ...process.env,
            HOME: home,
            // Prod and stage URLs are set, so a silent prod default would get past URL checks.
            RELAYER_URL_PROD: 'http://127.0.0.1:8787',
            RELAYER_URL_STAGE: 'http://127.0.0.1:8787',
        },
    })
}

test('omitting --env exits non-zero and does not select prod', () => {
    const result = runCli(['account', 'balance', '--profile', 'agent'])
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

    expect(result.status).not.toBe(0)
    expect(result.status).not.toBe(null)
    expect(output).toContain('--env')
    expect(output).toContain(missingEnvMessage)
    // A restored prod default would look up a keystore instead of rejecting the flag.
    expect(output).not.toContain('Keystore not found')
    expect(output).not.toContain('account_balance')
})
