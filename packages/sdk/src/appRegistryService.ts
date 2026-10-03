import { Signer } from 'ethers'
import { RpcOptions } from './rpcCommon'
import { SignerContext } from './signerContext'
import { makeAppRegistryRpcClient, type AppRegistryRpcClient } from './makeAppRegistryRpcClient'
import {
    authenticateWithSigner,
    authenticateWithSignerContext,
    createReauthenticatingClientFactory,
} from './authenticatedServiceUtils'

export class AppRegistryService {
    static async authenticate(signerContext: SignerContext, serviceUrl: string, opts?: RpcOptions) {
        const {
            startResponse,
            finishResponse,
            rpcClient: appRegistryRpcClient,
        } = await authenticateWithSignerContext({
            signerContext,
            serviceUrl,
            opts,
            makeRpcClient: makeAppRegistryRpcClient,
        })
        return {
            startResponse,
            finishResponse,
            appRegistryRpcClient,
        }
    }

    static async authenticateWithSigner(
        userId: string | Uint8Array,
        signer: Signer,
        serviceUrl: string,
        opts?: RpcOptions,
    ) {
        const {
            startResponse,
            finishResponse,
            rpcClient: appRegistryRpcClient,
        } = await authenticateWithSigner({
            userId,
            signer,
            serviceUrl,
            opts,
            makeRpcClient: makeAppRegistryRpcClient,
        })
        return {
            startResponse,
            finishResponse,
            appRegistryRpcClient,
        }
    }

    /**
     * Creates a lazy, self-healing app registry client that automatically
     * re-authenticates when the session token expires (UNAUTHENTICATED error).
     * Concurrent re-auth attempts are coalesced into a single authentication call.
     */
    static createClient(
        signerContext: SignerContext,
        serviceUrl: string,
        opts?: RpcOptions,
    ): () => Promise<AppRegistryRpcClient> {
        return createReauthenticatingClientFactory({
            authenticate: async () => {
                const { appRegistryRpcClient } = await this.authenticate(
                    signerContext,
                    serviceUrl,
                    opts,
                )
                return appRegistryRpcClient
            },
        })
    }
}
