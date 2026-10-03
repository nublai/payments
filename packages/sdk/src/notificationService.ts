import { makeNotificationRpcClient } from './makeNotificationRpcClient'
import { Signer } from 'ethers'
import { RpcOptions } from './rpcCommon'
import { SignerContext } from './signerContext'
import { authenticateWithSigner, authenticateWithSignerContext } from './authenticatedServiceUtils'

export class NotificationService {
    static async authenticate(signerContext: SignerContext, serviceUrl: string, opts?: RpcOptions) {
        const {
            startResponse,
            finishResponse,
            rpcClient: notificationRpcClient,
        } = await authenticateWithSignerContext({
            signerContext,
            serviceUrl,
            opts,
            makeRpcClient: makeNotificationRpcClient,
        })
        return {
            startResponse,
            finishResponse,
            notificationRpcClient,
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
            rpcClient: notificationRpcClient,
        } = await authenticateWithSigner({
            userId,
            signer,
            serviceUrl,
            opts,
            makeRpcClient: makeNotificationRpcClient,
        })
        return {
            startResponse,
            finishResponse,
            notificationRpcClient,
        }
    }
}
