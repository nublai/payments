import { check } from '@towns-labs/utils'
import { isDefined } from '../../../check'
import { Identifiable } from '../../../store/store'
import { RiverConnection } from '../../river-connection/riverConnection'
import { Members } from '../../members/members'
import type {
    ChannelMessage_Post_Attachment,
    ChannelMessage_Post_Mention,
    ChannelProperties,
    PlainMessage,
    RedeemInviteLinkResponse,
} from '@towns-labs/proto'
import { MessageTimeline } from '../../timeline/timeline'
import { type Address } from '@towns-labs/web3'
import { ethers } from 'ethers'
import { Observable } from '../../../observable/observable'

export interface GdmModel extends Identifiable {
    /** The id of the GDM stream. */
    id: string
    /** Whether the SyncAgent has loaded this data. */
    initialized: boolean
    /** Whether the current user has joined the GDM stream. */
    isJoined: boolean
    /** The metadata of the GDM stream. @see {@link ChannelProperties} */
    metadata?: ChannelProperties
}

export class Gdm extends Observable<GdmModel> {
    timeline: MessageTimeline
    members: Members
    constructor(
        id: string,
        private riverConnection: RiverConnection,
    ) {
        super({ id, isJoined: false, initialized: false })
        this.timeline = new MessageTimeline(id, riverConnection.userId, riverConnection)
        this.members = new Members(id, riverConnection)

        this.riverConnection.registerView((client) => {
            if (
                client.streams.has(this.value.id) &&
                client.streams.get(this.value.id)?.view.isInitialized
            ) {
                this.onStreamInitialized(this.value.id)
            }
            client.on('streamInitialized', this.onStreamInitialized)
            client.on('streamNewUserJoined', this.onStreamUserJoined)
            client.on('streamUserLeft', this.onStreamUserLeft)
            return () => {
                client.off('streamInitialized', this.onStreamInitialized)
                client.off('streamNewUserJoined', this.onStreamUserJoined)
                client.off('streamUserLeft', this.onStreamUserLeft)
            }
        })
    }

    async sendMessage(
        message: string,
        options?: {
            threadId?: string
            replyId?: string
            mentions?: PlainMessage<ChannelMessage_Post_Mention>[]
            attachments?: PlainMessage<ChannelMessage_Post_Attachment>[]
            /** The app client address that should receive the slash command. */
            appClientAddress?: string
        },
    ): Promise<{ eventId: string }> {
        const channelId = this.value.id
        const result = await this.riverConnection.withStream(channelId).call((client) => {
            return client.sendChannelMessage_Text(
                channelId,
                {
                    threadId: options?.threadId,
                    threadPreview: options?.threadId ? '🙉' : undefined,
                    replyId: options?.replyId,
                    replyPreview: options?.replyId ? '🙈' : undefined,
                    content: {
                        body: message,
                        mentions: options?.mentions ?? [],
                        attachments: options?.attachments ?? [],
                    },
                },
                {
                    appClientAddress: options?.appClientAddress,
                },
            )
        })
        return result
    }

    async leave() {
        const channelId = this.value.id
        const result = await this.riverConnection.withStream(channelId).call((client) => {
            return client.leaveStream(channelId)
        })
        return result
    }

    async pin(eventId: string) {
        const channelId = this.value.id
        const result = await this.riverConnection
            .withStream(channelId)
            .call((client) => client.pin(channelId, eventId))
        return result
    }

    async unpin(eventId: string) {
        const channelId = this.value.id
        const result = await this.riverConnection
            .withStream(channelId)
            .call((client) => client.unpin(channelId, eventId))
        return result
    }

    async sendReaction(refEventId: string, reaction: string) {
        const channelId = this.value.id
        const eventId = await this.riverConnection.call((client) =>
            client.sendChannelMessage_Reaction(channelId, {
                reaction,
                refEventId,
            }),
        )
        return eventId
    }

    /** Redacts your own event.
     * @param eventId - The event id of the message to redact
     * @param reason - The reason for the redaction
     */
    async redact(eventId: string, reason?: string) {
        const channelId = this.value.id
        const result = await this.riverConnection.withStream(channelId).call((client, stream) => {
            const event = stream.view.timeline.find((x) => x.eventId === eventId)
            if (!event) {
                throw new Error(`ref event not found: ${eventId}`)
            }
            if (event.sender.id !== this.riverConnection.userId) {
                throw new Error(
                    `You can only redact your own messages: ${eventId} - userId: ${this.riverConnection.userId}`,
                )
            }
            return client.sendChannelMessage_Redaction(channelId, {
                refEventId: eventId,
                reason,
            })
        })
        return result
    }

    /** Redacts any message as an admin.
     * @param eventId - The event id of the message to redact
     */
    async adminRedact(eventId: string) {
        const channelId = this.value.id
        const result = await this.riverConnection
            .withStream(channelId)
            .call((client) => client.redactMessage(channelId, eventId))
        return result
    }

    /** Sends a tip in a GDM context.
     * @param messageId - The event id of the message to tip
     * @param tip - The tip parameters
     * @param signer - The signer to use for the transaction
     */
    async sendTip(
        _messageId: string,
        _tip: { receiver: Address; currency: Address; amount: bigint; chainId: number },
        _signer: ethers.Signer,
    ) {
        throw new Error('sendTip is not implemented for GDMs')
    }

    /** Joins the GDM stream.
     * @param redeemedInvite - The redeemed invite link response.
     * @param opts - The options for the join.
     * @returns The stream.
     */
    async join(
        redeemedInvite: PlainMessage<RedeemInviteLinkResponse>,
        opts?: {
            skipWaitForMiniblockConfirmation?: boolean
            skipWaitForUserStreamUpdate?: boolean
        },
    ) {
        const stream = await this.riverConnection.call((client) =>
            client.joinStream(this.value.id, {
                redeemedInvite,
                ...opts,
            }),
        )
        return stream
    }

    private onStreamInitialized = (streamId: string) => {
        if (this.value.id === streamId) {
            const stream = this.riverConnection.client?.stream(streamId)
            check(isDefined(stream), 'stream is not defined')
            const view = stream.view.gdmChannelContent
            const hasJoined = stream.view.getMembers().isMemberJoined(this.riverConnection.userId)
            this.setValue({
                ...this.value,
                initialized: true,
                isJoined: hasJoined,
                metadata: view.channelProperties,
            })
            this.timeline.initialize(stream)
        }
    }

    private onStreamUserJoined = (streamId: string, userId: string) => {
        if (streamId === this.value.id && userId === this.riverConnection.userId) {
            this.setValue({ ...this.value, isJoined: true })
        }
    }

    private onStreamUserLeft = (streamId: string, userId: string) => {
        if (streamId === this.value.id && userId === this.riverConnection.userId) {
            this.setValue({ ...this.value, isJoined: false })
        }
    }
}
