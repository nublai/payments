import { decodeEventLog, type Hex } from 'viem'
import { bin_toHexString } from '@towns-labs/utils'

export enum TipRecipientType {
    Member = 0,
    Bot = 1,
    Any = 2,
}

export type TipSentEventObject = {
    sender: string
    receiver: string
    recipientType: TipRecipientType
    currency: string
    amount: bigint
    tokenId: bigint | undefined
    messageId: string
    channelId: string
}

export enum SpaceReviewAction {
    None = -1,
    Add = 0,
    Update = 1,
    Delete = 2,
}

export interface SpaceReviewEventObject {
    action: SpaceReviewAction
    user: string
    comment?: string
    rating: number
}

const reviewAbi = [
    {
        type: 'event',
        name: 'ReviewAdded',
        inputs: [
            { name: 'user', type: 'address', indexed: false },
            { name: 'comment', type: 'string', indexed: false },
            { name: 'rating', type: 'uint8', indexed: false },
        ],
    },
    {
        type: 'event',
        name: 'ReviewUpdated',
        inputs: [
            { name: 'user', type: 'address', indexed: false },
            { name: 'comment', type: 'string', indexed: false },
            { name: 'rating', type: 'uint8', indexed: false },
        ],
    },
    {
        type: 'event',
        name: 'ReviewDeleted',
        inputs: [{ name: 'user', type: 'address', indexed: false }],
    },
] as const

export function getSpaceReviewEventDataBin(
    binLogs: { topics: Uint8Array[]; data: Uint8Array; address: Uint8Array }[],
    from: Uint8Array,
): SpaceReviewEventObject {
    const logs = binLogs.map((log) => ({
        address: ('0x' + bin_toHexString(log.address)) as Hex,
        topics: log.topics.map((topic) => ('0x' + bin_toHexString(topic)) as Hex) as [
            Hex,
            ...Hex[],
        ],
        data: ('0x' + bin_toHexString(log.data)) as Hex,
    }))
    const senderWallet = ('0x' + bin_toHexString(from)).toLowerCase()

    for (const log of logs) {
        try {
            const decoded = decodeEventLog({
                abi: reviewAbi,
                data: log.data,
                topics: log.topics,
            })
            if (
                decoded.eventName === 'ReviewAdded' &&
                decoded.args.user.toLowerCase() === senderWallet
            ) {
                return {
                    user: decoded.args.user,
                    comment: decoded.args.comment,
                    rating: decoded.args.rating,
                    action: SpaceReviewAction.Add,
                }
            } else if (
                decoded.eventName === 'ReviewUpdated' &&
                decoded.args.user.toLowerCase() === senderWallet
            ) {
                return {
                    user: decoded.args.user,
                    comment: decoded.args.comment,
                    rating: decoded.args.rating,
                    action: SpaceReviewAction.Update,
                }
            } else if (
                decoded.eventName === 'ReviewDeleted' &&
                decoded.args.user.toLowerCase() === senderWallet
            ) {
                return {
                    user: decoded.args.user,
                    comment: undefined,
                    rating: 0,
                    action: SpaceReviewAction.Delete,
                }
            }
        } catch {
            // not a log from the review contract
        }
    }
    return { user: '', comment: undefined, rating: 0, action: SpaceReviewAction.None }
}
