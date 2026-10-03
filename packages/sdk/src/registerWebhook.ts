import type { Address } from 'viem'
import type { AppRegistryRpcClient } from './makeAppRegistryRpcClient'
import { bin_fromHexString } from '@towns-labs/utils'

export interface RegisterWebhookParams {
    appRegistryClient: AppRegistryRpcClient
    appAddress: Address
    webhookUrl: string
}

export async function registerWebhook(params: RegisterWebhookParams): Promise<void> {
    const { appRegistryClient, appAddress, webhookUrl } = params
    const appId = bin_fromHexString(appAddress)
    await appRegistryClient.registerWebhook({ appId, webhookUrl })
}
