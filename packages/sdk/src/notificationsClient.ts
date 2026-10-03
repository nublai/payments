import {
    FinishAuthenticationResponse,
    GdmChannelSettingValue,
    GetSettingsResponse,
    WebPushSubscriptionObject,
    PlainMessage,
    StartAuthenticationResponseSchema,
    FinishAuthenticationResponseSchema,
    GetSettingsResponseSchema,
    GdmChannelSettingSchema,
} from '@towns-labs/proto'
import { create, DescMessage, fromBinary, MessageShape, toBinary, toJson } from '@bufbuild/protobuf'
import { bin_fromBase64, bin_toBase64, dlogger } from '@towns-labs/utils'
import { cloneDeep } from 'lodash-es'
import { makeNotificationRpcClient, NotificationRpcClient } from './makeNotificationRpcClient'
import { SignerContext } from './signerContext'
import { RpcOptions } from './rpcCommon'
import { NotificationService } from './notificationService'
import { streamIdAsBytes, streamIdAsString, userIdFromAddress } from './id'
import { StreamsView } from './views/streamsView'
import { NotificationSettingsModel } from './views/streams/notificationSettings'

const logger = dlogger('csb:notifications')

export interface INotificationStore {
    getItem<Desc extends DescMessage>(schema: Desc, key: string): MessageShape<Desc> | undefined
    setItem<Desc extends DescMessage>(schema: Desc, key: string, value: MessageShape<Desc>): void
}

class InMemoryNotificationStore implements INotificationStore {
    private store: Record<string, string> = {}
    getItem<Desc extends DescMessage>(schema: Desc, key: string): MessageShape<Desc> | undefined {
        const data = this.store[`${schema.typeName}-${key}`]
        return data ? fromBinary(schema, bin_fromBase64(data)) : undefined
    }
    setItem<Desc extends DescMessage>(schema: Desc, key: string, value: MessageShape<Desc>): void {
        this.store[`${schema.typeName}-${key}`] = bin_toBase64(toBinary(schema, value))
    }
}

export class NotificationsClient {
    get notificationSettings(): NotificationSettingsModel {
        return this.streamsView.notificationSettings.value
    }
    private _client?: NotificationRpcClient
    private startResponseKey: string
    private finishResponseKey: string
    private settingsKey: string
    private getClientPromise: Promise<NotificationRpcClient | undefined> | undefined
    private getSettingsPromise: Promise<GetSettingsResponse | undefined> | undefined

    constructor(
        private readonly signerContext: SignerContext,
        private readonly url: string,
        private readonly store: INotificationStore = new InMemoryNotificationStore(),
        private readonly opts: RpcOptions | undefined = undefined,
        readonly streamsView: StreamsView,
    ) {
        this.startResponseKey = `startResponse`
        this.finishResponseKey = `finishResponse`
        this.settingsKey = `settings`
        this.streamsView.notificationSettings.initializeSettings(this.getLocalSettings())
    }

    get userId(): string {
        return userIdFromAddress(this.signerContext.creatorAddress)
    }

    private getLocalStartResponse():
        | MessageShape<typeof StartAuthenticationResponseSchema>
        | undefined {
        return this.store.getItem(StartAuthenticationResponseSchema, this.startResponseKey)
    }

    private setLocalStartResponse(
        response: MessageShape<typeof StartAuthenticationResponseSchema>,
    ) {
        this.store.setItem(StartAuthenticationResponseSchema, this.startResponseKey, response)
    }

    private getLocalFinishResponse(): FinishAuthenticationResponse | undefined {
        return this.store.getItem(FinishAuthenticationResponseSchema, this.finishResponseKey)
    }

    private setLocalFinishResponse(response: FinishAuthenticationResponse) {
        this.store.setItem(FinishAuthenticationResponseSchema, this.finishResponseKey, response)
    }

    private getLocalSettings(): GetSettingsResponse | undefined {
        return this.store.getItem(GetSettingsResponseSchema, this.settingsKey)
    }

    private setLocalSettings(settings: GetSettingsResponse) {
        this.store.setItem(GetSettingsResponseSchema, this.settingsKey, settings)
    }

    private updateLocalSettings(fn: (current: GetSettingsResponse) => void) {
        if (!this.streamsView.notificationSettings.value.settings) {
            throw new Error('TNS PUSH: settings has not been fetched')
        }
        const newSettings = cloneDeep(this.streamsView.notificationSettings.value.settings)
        fn(newSettings)
        this.setLocalSettings(newSettings)
        this.streamsView.notificationSettings.updateSettings(newSettings)
    }

    private async getClient(): Promise<NotificationRpcClient | undefined> {
        if (this.getClientPromise) {
            return this.getClientPromise
        }
        try {
            this.getClientPromise = this._getClient()
            const result = await this.getClientPromise
            this.getClientPromise = undefined
            return result
        } catch (error) {
            this.streamsView.notificationSettings.updateError(error as Error)
            this.getClientPromise = undefined
            return undefined
        }
    }

    private async _getClient(): Promise<NotificationRpcClient | undefined> {
        const startResponse = this.getLocalStartResponse()
        const finishResponse = this.getLocalFinishResponse()

        if (
            startResponse &&
            finishResponse &&
            startResponse.expiration &&
            startResponse.expiration.seconds > Date.now() / 1000
        ) {
            if (this._client) {
                return this._client
            }
            try {
                const client = makeNotificationRpcClient(
                    this.url,
                    finishResponse.sessionToken,
                    this.opts,
                )
                this._client = client
                return client
            } catch (error) {
                logger.error(
                    'TNS PUSH: error authenticating from local storage, will try from scratch',
                    error,
                )
            }
        }

        const service = await NotificationService.authenticate(
            this.signerContext,
            this.url,
            this.opts,
        )
        this.setLocalStartResponse(service.startResponse)
        this.setLocalFinishResponse(service.finishResponse)
        return service.notificationRpcClient
    }

    private async withClient<T>(
        fn: (client: NotificationRpcClient) => Promise<T>,
    ): Promise<T | undefined> {
        const client = await this.getClient()
        if (client) {
            try {
                return await fn(client)
            } catch (error) {
                this.streamsView.notificationSettings.updateError(error as Error)
                throw error
            }
        }
        return undefined
    }

    async getSettings(): Promise<GetSettingsResponse | undefined> {
        if (this.getSettingsPromise) {
            return this.getSettingsPromise
        }
        this.getSettingsPromise = this._getSettings()
        return this.getSettingsPromise
    }

    private async _getSettings(): Promise<GetSettingsResponse | undefined> {
        return this.withClient(async (client) => {
            try {
                const response = await client.getSettings({})
                this.setLocalSettings(response)
                this.streamsView.notificationSettings.updateSettings(response, Date.now())
                logger.log(
                    'TNS PUSH: fetched settings',
                    toJson(GetSettingsResponseSchema, response),
                )
                this.getSettingsPromise = undefined
                return response
            } catch (error) {
                this.streamsView.notificationSettings.updateError(error as Error)
                throw error
            }
        })
    }

    async subscribeWebPush(subscription: PlainMessage<WebPushSubscriptionObject>, app: string) {
        return this.withClient(async (client) => {
            logger.log('TNS PUSH: subscribing to web push')
            return client.subscribeWebPush({ subscription: subscription, app: app })
        })
    }

    async unsubscribeWebPush(subscription: PlainMessage<WebPushSubscriptionObject>) {
        return this.withClient(async (client) => {
            logger.log('TNS PUSH: unsubscribing to web push')
            return client.unsubscribeWebPush({ subscription })
        })
    }

    async setGdmGlobalSetting(value: GdmChannelSettingValue) {
        return this.withClient(async (client) => {
            await client.setDmGdmSettings({
                gdmGlobal: value,
            })

            this.updateLocalSettings((settings) => {
                settings.gdmGlobal = value
            })
        })
    }

    async setGdmChannelSetting(channelId: string, value: GdmChannelSettingValue) {
        return this.withClient(async (client) => {
            await client.setGdmChannelSetting({
                gdmChannelId: streamIdAsBytes(channelId),
                value,
            })
            this.updateLocalSettings((settings) => {
                settings.gdmChannels = settings.gdmChannels.filter(
                    (c) => streamIdAsString(c.channelId) !== channelId,
                )
                settings.gdmChannels.push(
                    create(GdmChannelSettingSchema, {
                        channelId: streamIdAsBytes(channelId),
                        value,
                    }),
                )
            })
        })
    }
}

export function getMutedChannelIds(settings?: PlainMessage<GetSettingsResponse>) {
    if (!settings) {
        return undefined
    }
    const ids = new Set<string>()
    for (const gdmSetting of settings.gdmChannels) {
        if (gdmSetting.value === GdmChannelSettingValue.GDM_MESSAGES_NO_AND_MUTE) {
            ids.add(streamIdAsString(gdmSetting.channelId))
        }
    }
    return ids
}
