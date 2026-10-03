import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeSessionList } from '../src/lib/session-list'

test('executeSessionList validates session keystore format with default deps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relayer-cli-session-list-'))
    const keystorePath = join(dir, 'agent.json')
    const sessionsDir = join(dir, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(
        keystorePath,
        JSON.stringify({
            version: 2,
            createdAt: new Date().toISOString(),
            network: {
                env: 'prod',
                relayerUrl: 'https://relayer.example',
                rpcUrl: 'https://rpc.example',
                chainId: 8453,
            },
            sessionRef: { active: 'agent-2', dir: 'sessions' },
            addresses: {
                root: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                delegated: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
            kdf: {
                name: 'argon2id',
                params: {
                    memoryCost: 1,
                    timeCost: 1,
                    parallelism: 1,
                    hashLength: 32,
                    salt: 'AQID',
                },
            },
            crypto: { algorithm: 'aes-256-gcm' },
            secrets: {
                rootPrivateKey: {
                    nonce: 'AQIDBAUGBwgJCgsM',
                    ciphertext: 'AA==',
                    tag: 'AA==',
                },
            },
        }),
        'utf8',
    )
    await writeFile(
        join(sessionsDir, 'agent-2.json'),
        JSON.stringify({
            version: 1,
            name: 'agent-2',
            addresses: { session: '0x1111111111111111111111111111111111111111' },
        }),
        'utf8',
    )

    await expect(
        executeSessionList({
            env: 'prod',
            keystorePath,
        }),
    ).rejects.toThrow('Unsupported session keystore format')
})
