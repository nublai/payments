import TypedEmitter from 'typed-emitter'
import {
    ChannelProperties,
    EncryptedData,
    GdmChannelPayload,
    GdmChannelPayload_Snapshot,
    Snapshot,
} from '@towns-labs/proto'
import { StreamStateView_AbstractContent } from './streamStateView_AbstractContent'
import {
    ConfirmedTimelineEvent,
    ParsedEvent,
    RemoteTimelineEvent,
    StreamTimelineEvent,
} from './types'
import { DecryptedContent, toDecryptedContent } from './encryptedContentTypes'
import { StreamEncryptionEvents, StreamEvents, StreamStateEvents } from './streamEvents'
import { bin_toHexString, check, dlog } from '@towns-labs/utils'
import { logNever } from './check'
import { GdmStreamModel, GdmStreamsView } from './views/streams/gdmStreams'

export class StreamStateView_GDMChannel extends StreamStateView_AbstractContent {
    log = dlog('csb:streams:gdm_channel')
    readonly streamId: string

    // named channelProperties for backwards compatibility
    get channelProperties(): ChannelProperties | undefined {
        return this.gdmStreamModel.metadata
    }

    get metadataEventId(): string | undefined {
        return this.gdmStreamModel.metadataEventId
    }

    get lastEventCreatedAtEpochMs(): bigint {
        return this.gdmStreamModel.lastEventCreatedAtEpochMs
    }

    get gdmStreamModel(): GdmStreamModel {
        return this.gdmStreamsView.get(this.streamId)
    }

    constructor(
        streamId: string,
        private gdmStreamsView: GdmStreamsView,
    ) {
        super()
        this.streamId = streamId
    }

    applySnapshot(
        snapshot: Snapshot,
        content: GdmChannelPayload_Snapshot,
        cleartexts: Record<string, Uint8Array | string> | undefined,
        encryptionEmitter: TypedEmitter<StreamEncryptionEvents> | undefined,
    ): void {
        if (content.channelProperties) {
            const encryptedChannelProperties = content.channelProperties
            if (!encryptedChannelProperties.data) {
                return
            }

            const eventId = bin_toHexString(encryptedChannelProperties.eventHash)
            const cleartext = cleartexts?.[eventId]
            this.gdmStreamsView.setLatestMetadataEventId(this.streamId, eventId)
            this.decryptChannelPropertiesPayload(
                encryptedChannelProperties.data,
                eventId,
                cleartext,
                encryptionEmitter,
            )
        }
    }

    prependEvent(
        event: RemoteTimelineEvent,
        cleartext: Uint8Array | string | undefined,
        encryptionEmitter: TypedEmitter<StreamEncryptionEvents> | undefined,
        _stateEmitter: TypedEmitter<StreamStateEvents> | undefined,
    ): void {
        check(event.remoteEvent.event.payload.case === 'gdmChannelPayload')
        const payload: GdmChannelPayload = event.remoteEvent.event.payload.value
        switch (payload.content.case) {
            case 'inception':
                this.updateLastEvent(event.remoteEvent, undefined)
                break
            case 'message':
                this.decryptEvent(
                    'channelMessage',
                    event,
                    payload.content.value,
                    cleartext,
                    encryptionEmitter,
                )
                this.updateLastEvent(event.remoteEvent, undefined)
                break
            case 'channelProperties':
                // nothing to do, conveyed in the snapshot
                break
            case 'custom':
                break
            case 'redaction':
                break
            case 'interactionRequest': {
                const encryptedData = payload.content.value.encryptedData
                if (encryptedData) {
                    this.decryptEvent(
                        'interactionRequestPayload',
                        event,
                        encryptedData,
                        cleartext,
                        encryptionEmitter,
                    )
                }
                break
            }
            case 'interactionResponse':
                break
            case undefined:
                break
            default:
                logNever(payload.content)
        }
    }

    appendEvent(
        event: RemoteTimelineEvent,
        cleartext: Uint8Array | string | undefined,
        encryptionEmitter: TypedEmitter<StreamEncryptionEvents> | undefined,
        stateEmitter: TypedEmitter<StreamStateEvents> | undefined,
    ): void {
        check(event.remoteEvent.event.payload.case === 'gdmChannelPayload')
        const payload: GdmChannelPayload = event.remoteEvent.event.payload.value
        switch (payload.content.case) {
            case 'inception':
                this.updateLastEvent(event.remoteEvent, stateEmitter)
                break
            case 'message':
                this.decryptEvent(
                    'channelMessage',
                    event,
                    payload.content.value,
                    cleartext,
                    encryptionEmitter,
                )
                this.updateLastEvent(event.remoteEvent, stateEmitter)
                break
            case 'channelProperties':
                {
                    this.gdmStreamsView.setLatestMetadataEventId(this.streamId, event.hashStr)
                    this.decryptChannelPropertiesPayload(
                        payload.content.value,
                        event.hashStr,
                        cleartext,
                        encryptionEmitter,
                    )
                }
                break
            case 'custom':
                break
            case 'redaction':
                break
            case 'interactionRequest': {
                const encryptedData = payload.content.value.encryptedData
                if (encryptedData) {
                    this.decryptEvent(
                        'interactionRequestPayload',
                        event,
                        encryptedData,
                        cleartext,
                        encryptionEmitter,
                    )
                }
                break
            }
            case 'interactionResponse':
                break
            case undefined:
                break
            default:
                logNever(payload.content)
        }
    }

    onDecryptedContent(
        eventId: string,
        content: DecryptedContent,
        emitter: TypedEmitter<StreamEvents>,
    ): void {
        if (content.kind === 'channelProperties') {
            this.handleDecryptedContent(eventId, content, emitter)
        }
    }

    onConfirmedEvent(
        event: ConfirmedTimelineEvent,
        emitter: TypedEmitter<StreamEvents> | undefined,
        encryptionEmitter: TypedEmitter<StreamEncryptionEvents> | undefined,
    ): void {
        super.onConfirmedEvent(event, emitter, encryptionEmitter)
    }

    onAppendLocalEvent(
        event: StreamTimelineEvent,
        stateEmitter: TypedEmitter<StreamStateEvents> | undefined,
    ): void {
        this.gdmStreamsView.setLastEventCreatedAtEpochMs(this.streamId, event.createdAtEpochMs)
        stateEmitter?.emit('streamLatestTimestampUpdated', this.streamId)
    }

    private updateLastEvent(
        event: ParsedEvent,
        stateEmitter: TypedEmitter<StreamStateEvents> | undefined,
    ) {
        const createdAtEpochMs = event.event.createdAtEpochMs
        if (createdAtEpochMs > this.lastEventCreatedAtEpochMs) {
            this.gdmStreamsView.setLastEventCreatedAtEpochMs(this.streamId, createdAtEpochMs)
            stateEmitter?.emit('streamLatestTimestampUpdated', this.streamId)
        }
    }

    private decryptChannelPropertiesPayload(
        payload: EncryptedData,
        eventId: string,
        cleartext: Uint8Array | string | undefined,
        encryptionEmitter: TypedEmitter<StreamEncryptionEvents> | undefined,
    ) {
        if (cleartext) {
            const decryptedContent = toDecryptedContent(
                'channelProperties',
                payload.version,
                cleartext,
            )
            this.handleDecryptedContent(eventId, decryptedContent, encryptionEmitter)
        } else {
            encryptionEmitter?.emit('newEncryptedContent', this.streamId, eventId, {
                kind: 'channelProperties',
                content: payload,
            })
        }
    }

    private handleDecryptedContent(
        eventId: string,
        content: DecryptedContent,
        emitter: TypedEmitter<StreamEvents> | undefined,
    ) {
        if (content.kind === 'channelProperties') {
            if (
                !this.gdmStreamModel.metadataEventId ||
                !this.gdmStreamModel.metadata ||
                this.gdmStreamModel.latestMetadataEventId === eventId
            ) {
                this.gdmStreamsView.setMetadata(this.streamId, content.content, eventId)
                emitter?.emit('streamChannelPropertiesUpdated', this.streamId)
            } else {
                this.log('channelProperties eventId mismatch', {
                    eventId,
                    content,
                    gdmStreamModel: this.gdmStreamModel,
                })
            }
        } else {
            check(false)
        }
    }
}
