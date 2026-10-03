import { createWalletClient, http, type Chain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { waitForBundle, type PrepareCallsParams } from '../../src'
import type { RelayerTestClient } from './client'

export async function prepareSignSendAndWait(params: {
    client: RelayerTestClient
    chain: Chain
    rpcUrl: string
    privateKey: Hex
    prepare: PrepareCallsParams
    wait?: {
        intervalMs?: number
        timeoutMs?: number
        chainId?: number
    }
}) {
    const { client, chain, rpcUrl, privateKey, prepare, wait } = params

    const prepared = await client.prepareCalls(prepare)
    const account = privateKeyToAccount(privateKey)

    const walletClient = createWalletClient({
        account,
        chain,
        transport: http(rpcUrl),
    })

    const signature = await walletClient.signTypedData({
        account,
        domain: prepared.typedData.domain,
        types: prepared.typedData.types,
        primaryType: prepared.typedData.primaryType,
        message: prepared.typedData.message,
    })

    const submission = await client.sendPreparedCalls({
        context: prepared.context,
        signature,
    })

    const status = await waitForBundle(client, {
        id: submission.id,
        intervalMs: wait?.intervalMs,
        timeoutMs: wait?.timeoutMs,
        chainId: wait?.chainId,
    })

    return { prepared, signature, submission, status }
}
