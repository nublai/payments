import { SyncAgentConfig } from '../sync-agent/syncAgent'
import { ClientParams } from '../sync-agent/river-connection/riverConnection'
import { makeRandomUserContext } from './testUtils'
import { townsEnv } from '../townsEnv'
import { RiverDbManager } from '../riverDbManager'
import { userIdFromAddress } from '../id'

export async function makeRandomSyncAgentConfig(): Promise<SyncAgentConfig> {
    const context = await makeRandomUserContext()
    const townsConfig = townsEnv().makeTownsConfig()
    return {
        townsConfig,
        context,
    } satisfies SyncAgentConfig
}

export function makeClientParams(config: SyncAgentConfig): ClientParams {
    const userId = userIdFromAddress(config.context.creatorAddress)
    return {
        signerContext: config.context,
        cryptoStore: RiverDbManager.getCryptoDb(
            userId,
            makeTestCryptoDbName(userId, config.deviceId),
        ),
        opts: {
            persistenceStoreName: makeTestPersistenceDbName(userId, config.deviceId),
            logNamespaceFilter: undefined,
            highPriorityStreamIds: undefined,
        },
        rpcRetryParams: config.retryParams,
    } satisfies ClientParams
}

export function makeTestPersistenceDbName(userId: string, deviceId?: string) {
    return makeTestDbName('p', userId, deviceId)
}

export function makeTestCryptoDbName(userId: string, deviceId?: string) {
    return makeTestDbName('c', userId, deviceId)
}

export function makeTestSyncDbName(userId: string, deviceId?: string) {
    return makeTestDbName('s', userId, deviceId)
}

export function makeTestDbName(prefix: string, userId: string, deviceId?: string) {
    const suffix = deviceId ? `-${deviceId}` : ''
    return `${prefix}-${userId}${suffix}`
}
