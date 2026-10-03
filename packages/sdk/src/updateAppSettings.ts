import type { Address } from 'viem'
import type { AppRegistryRpcClient } from './makeAppRegistryRpcClient'
import { bin_fromHexString } from '@towns-labs/utils'
import type { ForwardSettingValue, SupportedApi } from '@towns-labs/proto'

export interface UpdateAppSettingsParams {
    appRegistryClient: AppRegistryRpcClient
    appAddress: Address
    /** If omitted the existing forward setting is left unchanged. */
    forwardSetting?: ForwardSettingValue
    /** If omitted the existing supported APIs list is left unchanged. */
    supportedApis?: SupportedApi[]
}

export async function updateAppSettings(params: UpdateAppSettingsParams): Promise<void> {
    const { appRegistryClient, appAddress, forwardSetting, supportedApis } = params
    const appId = bin_fromHexString(appAddress)

    const updateMask: string[] = []
    if (forwardSetting !== undefined) {
        updateMask.push('forward_setting')
    }
    if (supportedApis !== undefined) {
        updateMask.push('supported_apis')
    }

    if (updateMask.length > 0) {
        await appRegistryClient.updateAppSettings({
            appId,
            forwardSetting,
            supportedApis,
            updateMask,
        })
    }
}
