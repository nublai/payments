import { makeContactsRpcClient, type ContactsRpcClient } from './makeContactsRpcClient'
import { Signer } from 'ethers'
import { RpcOptions } from './rpcCommon'
import { SignerContext } from './signerContext'
import {
    authenticateWithSigner,
    authenticateWithSignerContext,
    createReauthenticatingClientFactory,
} from './authenticatedServiceUtils'

export class ContactsService {
    static async authenticate(signerContext: SignerContext, serviceUrl: string, opts?: RpcOptions) {
        const {
            startResponse,
            finishResponse,
            rpcClient: contactsRpcClient,
        } = await authenticateWithSignerContext({
            signerContext,
            serviceUrl,
            opts,
            makeRpcClient: makeContactsRpcClient,
        })
        return {
            startResponse,
            finishResponse,
            contactsRpcClient,
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
            rpcClient: contactsRpcClient,
        } = await authenticateWithSigner({
            userId,
            signer,
            serviceUrl,
            opts,
            makeRpcClient: makeContactsRpcClient,
        })
        return {
            startResponse,
            finishResponse,
            contactsRpcClient,
        }
    }

    /**
     * Creates a lazy, self-healing contacts client that automatically
     * re-authenticates when the session token expires (UNAUTHENTICATED error).
     * Concurrent re-auth attempts are coalesced into a single authentication call.
     */
    static createClient(
        signerContext: SignerContext,
        serviceUrl: string,
        opts?: RpcOptions,
    ): () => Promise<ContactsRpcClient> {
        return createReauthenticatingClientFactory({
            authenticate: async () => {
                const { contactsRpcClient } = await this.authenticate(
                    signerContext,
                    serviceUrl,
                    opts,
                )
                return contactsRpcClient
            },
        })
    }
}
