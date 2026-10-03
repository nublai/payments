import { getAddress, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { EthHttpSigner } from '@towns-labs/relayer-client'
import { createEthHttpSigner } from './relayer-client-utils'
import type { SessionDaemonRpcResponse } from './session-daemon-client'
import { SessionDaemonClient } from './session-daemon-client'
import { DAEMON_ERROR_CODES, type DaemonErrorCode } from './session-daemon-protocol'
import {
    decryptSessionKeystore,
    type LoginSessionKeystoreV2,
    type RelayerSessionKeystoreV2,
} from './keystore'
import type { ExecuteSignedCallsDeps } from './execute-calls'

const DAEMON_PLACEHOLDER_PRIVATE_KEY =
    '0x0000000000000000000000000000000000000000000000000000000000000001' as const

const SESSION_EXPIRED_MESSAGE = 'Session key expired. Run `tw daemon unlock <name>` to reload.'

function unwrapDaemonSignature(response: SessionDaemonRpcResponse<Hex>): Hex {
    if (response === null || !response.ok) {
        if (response !== null && response.error.code === DAEMON_ERROR_CODES.SESSION_EXPIRED) {
            throw new SessionSignerExpiredError(SESSION_EXPIRED_MESSAGE)
        }
        throw new SessionSignerDaemonError(
            response?.error?.message ?? 'Session daemon is unavailable',
            response?.error?.code,
        )
    }
    return response.result
}

export class SessionSignerExpiredError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SessionSignerExpiredError'
    }
}

export class SessionSignerDaemonError extends Error {
    code?: DaemonErrorCode

    constructor(message: string, code?: DaemonErrorCode) {
        super(message)
        this.name = 'SessionSignerDaemonError'
        this.code = code
    }
}

export type ResolvedSessionSigner =
    | {
          mode: 'daemon'
          signTypedData: ExecuteSignedCallsDeps['signTypedData']
          authSigner: EthHttpSigner
          signerPrivateKey: Hex
      }
    | {
          mode: 'direct'
          signTypedData: ExecuteSignedCallsDeps['signTypedData']
          authSigner: EthHttpSigner
          signerPrivateKey: Hex
      }

export async function resolveSessionSigner(opts: {
    sessionName: string
    sessionKeystore: RelayerSessionKeystoreV2 | LoginSessionKeystoreV2
    resolvePassword: () => Promise<string>
    chainId: number
    decryptSessionKeystore?: typeof decryptSessionKeystore
    directSignTypedData?: ExecuteSignedCallsDeps['signTypedData']
}): Promise<ResolvedSessionSigner> {
    const client = new SessionDaemonClient()
    const ping = await client.ping()
    const normalizedName = opts.sessionName.trim()

    if (ping?.ok) {
        const list = await client.list()
        const expectedAddress = getAddress(opts.sessionKeystore.addresses.session)
        if (
            list?.ok &&
            list.result.keys.some(
                (entry) =>
                    entry.name === normalizedName &&
                    getAddress(entry.address).toLowerCase() === expectedAddress.toLowerCase(),
            )
        ) {
            const address = expectedAddress
            const authSigner: EthHttpSigner = {
                address,
                chainId: opts.chainId,
                signMessage: async (message: Uint8Array) =>
                    unwrapDaemonSignature(await client.signMessage(normalizedName, toHex(message))),
            }

            return {
                mode: 'daemon',
                signTypedData: async (input) =>
                    unwrapDaemonSignature(await client.sign(normalizedName, input.typedData)),
                authSigner,
                signerPrivateKey: DAEMON_PLACEHOLDER_PRIVATE_KEY,
            }
        }
    }

    const decrypt = opts.decryptSessionKeystore ?? decryptSessionKeystore
    const password = await opts.resolvePassword()
    const decrypted = await decrypt(opts.sessionKeystore, password)
    const sessionPrivateKey = decrypted.sessionPrivateKey

    return {
        mode: 'direct',
        signTypedData:
            opts.directSignTypedData ??
            (async (input) => privateKeyToAccount(input.privateKey).signTypedData(input.typedData)),
        authSigner: createEthHttpSigner(sessionPrivateKey, opts.chainId),
        signerPrivateKey: sessionPrivateKey,
    }
}
