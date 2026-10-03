import { hashPersonalMessage } from '@ethereumjs/util'
import { Signer } from 'ethers'
import { bin_fromHexString, check } from '@towns-labs/utils'
import { Err } from '@towns-labs/proto'
import { isDefined } from './check'
import {
    makeAuthenticationRpcClient,
    type AuthenticationRpcClient,
} from './makeAuthenticationRpcClient'
import { RpcOptions } from './rpcCommon'
import { errorContains } from './rpcInterceptors'
import { meganodeAuthHash, riverSign } from './sign'
import { SignerContext } from './signerContext'

type StartAuthenticationResponse = Awaited<
    ReturnType<AuthenticationRpcClient['startAuthentication']>
>
type FinishAuthenticationResponse = Awaited<
    ReturnType<AuthenticationRpcClient['finishAuthentication']>
>

type AuthenticateCommonResult<TRpcClient> = {
    startResponse: StartAuthenticationResponse
    finishResponse: FinishAuthenticationResponse
    rpcClient: TRpcClient
}

type AuthenticateCommonParams<TRpcClient> = {
    userId: Uint8Array
    serviceUrl: string
    opts?: RpcOptions
    getSignature: (hash: Uint8Array) => Promise<Uint8Array>
    extraFinishAuthParams: Record<string, unknown>
    makeRpcClient: (serviceUrl: string, sessionToken: string, opts?: RpcOptions) => TRpcClient
}

async function authenticateCommon<TRpcClient>({
    userId,
    serviceUrl,
    opts,
    getSignature,
    extraFinishAuthParams,
    makeRpcClient,
}: AuthenticateCommonParams<TRpcClient>): Promise<AuthenticateCommonResult<TRpcClient>> {
    const authenticationRpcClient = makeAuthenticationRpcClient(serviceUrl, opts)

    const startResponse = await authenticationRpcClient.startAuthentication({ userId })
    check(startResponse.challenge.length >= 16, 'challenge must be 16 bytes')
    check(isDefined(startResponse.expiration), 'expiration must be defined')

    const hash = meganodeAuthHash(userId, startResponse.expiration.seconds, startResponse.challenge)
    const signature = await getSignature(hash)

    const finishResponse = await authenticationRpcClient.finishAuthentication({
        userId,
        challenge: startResponse.challenge,
        signature,
        ...extraFinishAuthParams,
    })

    return {
        startResponse,
        finishResponse,
        rpcClient: makeRpcClient(serviceUrl, finishResponse.sessionToken, opts),
    }
}

type AuthenticateWithSignerContextParams<TRpcClient> = {
    signerContext: SignerContext
    serviceUrl: string
    opts?: RpcOptions
    makeRpcClient: (serviceUrl: string, sessionToken: string, opts?: RpcOptions) => TRpcClient
}

export async function authenticateWithSignerContext<TRpcClient>({
    signerContext,
    serviceUrl,
    opts,
    makeRpcClient,
}: AuthenticateWithSignerContextParams<TRpcClient>): Promise<AuthenticateCommonResult<TRpcClient>> {
    return authenticateCommon({
        userId: signerContext.creatorAddress,
        serviceUrl,
        opts,
        getSignature: async (hashSrc) => {
            const hash = hashPersonalMessage(hashSrc)
            return await riverSign(hash, signerContext.signerPrivateKey())
        },
        extraFinishAuthParams: {
            delegateSig: signerContext.delegateSig,
            delegateExpiryEpochMs: signerContext.delegateExpiryEpochMs,
        },
        makeRpcClient,
    })
}

type AuthenticateWithSignerParams<TRpcClient> = {
    userId: string | Uint8Array
    signer: Signer
    serviceUrl: string
    opts?: RpcOptions
    makeRpcClient: (serviceUrl: string, sessionToken: string, opts?: RpcOptions) => TRpcClient
}

export async function authenticateWithSigner<TRpcClient>({
    userId,
    signer,
    serviceUrl,
    opts,
    makeRpcClient,
}: AuthenticateWithSignerParams<TRpcClient>): Promise<AuthenticateCommonResult<TRpcClient>> {
    const userIdBytes = typeof userId === 'string' ? bin_fromHexString(userId) : userId
    return authenticateCommon({
        userId: userIdBytes,
        serviceUrl,
        opts,
        getSignature: async (hash) => {
            const sigHex = await signer.signMessage(hash)
            return bin_fromHexString(sigHex)
        },
        extraFinishAuthParams: {},
        makeRpcClient,
    })
}

type ReauthenticatingClientParams<TClient extends object> = {
    authenticate: () => Promise<TClient>
}

export function createReauthenticatingClientFactory<TClient extends object>({
    authenticate,
}: ReauthenticatingClientParams<TClient>): () => Promise<TClient> {
    let currentClient: TClient | undefined
    let reAuthPromise: Promise<void> | undefined
    let proxy: TClient | undefined

    const reAuthenticate = async () => {
        if (!reAuthPromise) {
            reAuthPromise = authenticate()
                .then((client) => {
                    currentClient = client
                })
                .finally(() => {
                    reAuthPromise = undefined
                })
        }
        return reAuthPromise
    }

    return async () => {
        if (!currentClient) {
            await reAuthenticate()
        }
        if (!proxy) {
            /* eslint-disable @typescript-eslint/no-unsafe-return */
            proxy = new Proxy({} as TClient, {
                get(_target, prop) {
                    const client = currentClient as Record<PropertyKey, unknown>
                    const value = client[prop]
                    if (typeof value !== 'function') {
                        return value
                    }
                    return async (...args: unknown[]) => {
                        try {
                            return await value.apply(client, args)
                        } catch (err) {
                            if (errorContains(err, Err.UNAUTHENTICATED)) {
                                await reAuthenticate()
                                const newClient = currentClient as Record<PropertyKey, unknown>
                                const newValue = newClient[prop]
                                if (typeof newValue !== 'function') {
                                    return newValue
                                }
                                return await newValue.apply(newClient, args)
                            }
                            throw err
                        }
                    }
                },
            })
            /* eslint-enable @typescript-eslint/no-unsafe-return */
        }
        return proxy
    }
}
