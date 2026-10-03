import { constants } from 'node:fs'
import { access, readFile, unlink, writeFile } from 'node:fs/promises'
import type { Client, SignerContext, SyncMode } from '@towns-labs/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import type { EnvName } from './network-config'

const TOWNS_NODE_URLS: Record<EnvName, string> = {
    prod: 'https://chat1.nodes.prod.towns.com',
    stage: 'https://chat1.nodes.staging.towns.com',
    dev: 'https://localhost:5170',
}

export type AgentClient = Pick<
    Client,
    | 'createGDMChannel'
    | 'getStream'
    | 'initStream'
    | 'initializeUser'
    | 'off'
    | 'on'
    | 'sendChannelMessage_Text'
    | 'sendMessage'
    | 'startSync'
    | 'stop'
    | 'updateGDMChannelProperties'
    | 'uploadDeviceKeys'
    | 'cryptoBackend'
>

export function isErrnoNotFound(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
    )
}

function isErrnoCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === code
    )
}

async function unlinkIfExists(path: string): Promise<void> {
    try {
        await unlink(path)
    } catch (error) {
        if (isErrnoNotFound(error)) {
            return
        }
        throw error
    }
}

export function resolveAgentListenPidPath(sessionPath: string): string {
    return sessionPath.replace(/\.json$/, '.listen.pid')
}

export async function checkAgentListenPid(
    sessionPath: string,
): Promise<{ active: boolean; pidPath: string }> {
    const pidPath = resolveAgentListenPidPath(sessionPath)
    try {
        await access(pidPath, constants.F_OK)
    } catch (error) {
        if (isErrnoNotFound(error)) {
            return { active: false, pidPath }
        }
        throw error
    }

    try {
        const rawPid = (await readFile(pidPath, 'utf8')).trim()
        const pid = Number.parseInt(rawPid, 10)
        if (!Number.isFinite(pid) || pid <= 0) {
            await unlinkIfExists(pidPath)
            return { active: false, pidPath }
        }
        process.kill(pid, 0)
        return { active: true, pidPath }
    } catch (error) {
        if (isErrnoCode(error, 'ESRCH') || isErrnoCode(error, 'ENOENT')) {
            await unlinkIfExists(pidPath)
            return { active: false, pidPath }
        }
        throw error
    }
}

async function readPidFile(path: string): Promise<number | undefined> {
    try {
        const rawPid = (await readFile(path, 'utf8')).trim()
        const pid = Number.parseInt(rawPid, 10)
        return Number.isFinite(pid) && pid > 0 ? pid : undefined
    } catch (error) {
        if (isErrnoNotFound(error)) {
            return undefined
        }
        throw error
    }
}

export async function claimAgentListenPid(sessionPath: string): Promise<{
    pidPath: string
    release: () => Promise<void>
}> {
    const pidPath = resolveAgentListenPidPath(sessionPath)

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await writeFile(pidPath, `${process.pid}\n`, { flag: 'wx' })
            return {
                pidPath,
                release: async () => {
                    const currentPid = await readPidFile(pidPath)
                    if (currentPid !== process.pid) {
                        return
                    }
                    await unlinkIfExists(pidPath)
                },
            }
        } catch (error) {
            if (isErrnoCode(error, 'EEXIST')) {
                const current = await checkAgentListenPid(sessionPath)
                if (current.active) {
                    throw error
                }
                continue
            }
            throw error
        }
    }

    throw new Error(`Failed to claim listen pid file for ${sessionPath}`)
}

export async function defaultCreateAgentClient(input: {
    env: EnvName
    sessionPrivateKey: Hex
    options?: { syncMode?: SyncMode }
}): Promise<AgentClient> {
    const sdk = await import('@towns-labs/sdk')
    const account = privateKeyToAccount(input.sessionPrivateKey)
    const signerContext: SignerContext = {
        signerPrivateKey: () => input.sessionPrivateKey.slice(2),
        creatorAddress: Buffer.from(account.address.slice(2), 'hex'),
    }
    const rpcClient = sdk.makeStreamRpcClient(TOWNS_NODE_URLS[input.env])
    const cryptoStore = sdk.RiverDbManager.getCryptoDb(account.address)
    return new sdk.Client(signerContext, undefined, rpcClient, cryptoStore, input.options)
}
