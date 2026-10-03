import { RiverConnection } from './river-connection/riverConnection'
import { TownsConfig } from '../townsEnv'
import { RetryParams } from '../rpcInterceptors'
import { SignerContext } from '../signerContext'
import { userIdFromAddress } from '../id'
import { User } from './user/user'
import { RiverDbManager } from '../riverDbManager'
import { Observable } from '../observable/observable'
import { AuthStatus } from './river-connection/models/authStatus'
import { ethers } from 'ethers'
import type { EncryptionDeviceInitOpts } from '@towns-labs/encryption'
import { Gdms, type GdmsModel } from './gdms/gdms'
import { UnpackEnvelopeOpts } from '../sign'
import { dlog, DLogger, shortenHexString } from '@towns-labs/utils'
import { UserStreamModel } from '../views/streams/userStreamsView'
import { UserInboxStreamModel } from '../views/streams/userInboxStreams'
import { UserMetadataStreamModel } from '../views/streams/userMetadataStreams'
import { UserSettingsStreamModel } from '../views/streams/userSettingsStreams'
import { PlainMessage, RedeemInviteLinkResponse } from '@towns-labs/proto'
import { Stream } from '../stream'

export interface SyncAgentConfig {
    context: SignerContext
    townsConfig: TownsConfig
    retryParams?: RetryParams
    highPriorityStreamIds?: string[]
    deviceId?: string
    disablePersistenceStore?: boolean
    riverProvider?: ethers.providers.Provider
    baseProvider?: ethers.providers.Provider
    encryptionDevice?: EncryptionDeviceInitOpts
    onTokenExpired?: () => void
    unpackEnvelopeOpts?: UnpackEnvelopeOpts
    logId?: string
}

export class SyncAgent {
    log: DLogger
    userId: string
    config: SyncAgentConfig
    riverConnection: RiverConnection
    user: User
    gdms: Gdms
    private stopped = false

    // flattened observables - just pointers to the observable objects in the models
    observables: {
        riverAuthStatus: Observable<AuthStatus>
        userMemberships: Observable<UserStreamModel>
        userInbox: Observable<UserInboxStreamModel>
        userMetadata: Observable<UserMetadataStreamModel>
        userSettings: Observable<UserSettingsStreamModel>
        gdms: Observable<GdmsModel>
    }

    constructor(config: SyncAgentConfig) {
        this.userId = userIdFromAddress(config.context.creatorAddress)
        const logId = config.logId ?? shortenHexString(this.userId)
        this.log = dlog('csb:syncAgent', { defaultEnabled: false }).extend(logId)
        this.config = config
        this.riverConnection = new RiverConnection(config.townsConfig, {
            signerContext: config.context,
            cryptoStore: RiverDbManager.getCryptoDb(this.userId, this.cryptoDbName()),
            opts: {
                persistenceStoreName:
                    config.disablePersistenceStore !== true ? this.persistenceDbName() : undefined,
                logNamespaceFilter: undefined,
                highPriorityStreamIds: this.config.highPriorityStreamIds,
                unpackEnvelopeOpts: config.unpackEnvelopeOpts,
                logId: config.logId,
            },
            rpcRetryParams: config.retryParams,
            encryptionDevice: config.encryptionDevice,
            onTokenExpired: config.onTokenExpired,
        })

        this.user = new User(this.userId, this.riverConnection)
        this.gdms = new Gdms(this.riverConnection, this.user.memberships)
        // flatten out the observables
        this.observables = {
            riverAuthStatus: this.riverConnection.authStatus,
            userMemberships: this.user.memberships,
            userInbox: this.user.inbox,
            userMetadata: this.user.deviceKeys,
            userSettings: this.user.settings,
            gdms: this.gdms,
        }
    }

    async start() {
        if (this.stopped) {
            throw new Error('SyncAgent is stopped, please instantiate a new sync agent')
        }
        this.log('SyncAgent::start: starting river connection')
        // start this river connection, this will log us in if the user is already signed up
        // it will leave us in a connected state otherwise, see riverConnection.authStatus
        await this.riverConnection.start()
        this.log('SyncAgent::start: river connection started')
    }

    async stop() {
        this.stopped = true
        await this.riverConnection.stop()
    }

    async joinStream(
        streamId: string | Uint8Array,
        opts?: {
            redeemedInvite?: PlainMessage<RedeemInviteLinkResponse>
            skipWaitForMiniblockConfirmation?: boolean
            skipWaitForUserStreamUpdate?: boolean
        },
    ): Promise<Stream> {
        return this.riverConnection.call(async (client) => {
            return client.joinStream(streamId, opts)
        })
    }

    syncAgentDbName(): string {
        return this.dbName('syncAgent')
    }

    persistenceDbName(): string {
        return this.dbName('persistence')
    }

    cryptoDbName(): string {
        return this.dbName('database')
    }

    dbName(db: string): string {
        const envSuffix =
            this.config.townsConfig.environmentId === 'beta'
                ? ''
                : `-${this.config.townsConfig.environmentId}`
        const postfix = this.config.deviceId !== undefined ? `-${this.config.deviceId}` : ''
        const dbName = `${db}-${this.userId}${envSuffix}${postfix}`
        return dbName
    }
}
