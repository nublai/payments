import { isEqual } from 'lodash-es'
import { isGDMChannelStreamId } from '../../id'
import { MentionResult } from '../models/timelineTypes'
import { TimelinesViewModel } from '../streams/timelinesModel'
import { UnreadMarkersModel } from './unreadMarkersTransform'

export interface MentionsModel {
    mentionsMap: Record<
        string,
        {
            mentions: MentionResult[]
            unreadThreadCount: number
            unreadChannelCount: number
        }
    >
}

type Input = {
    timelinesView: TimelinesViewModel
    fullyReadMarkers: UnreadMarkersModel
}

export function spaceMentionsTransform(
    value: Input,
    prev: Input,
    state?: MentionsModel,
): MentionsModel {
    state = state ?? { mentionsMap: {} }

    const unreadMarkers = value.fullyReadMarkers.markers
    const threadsStats = value.timelinesView.threadsStats
    const timelines = value.timelinesView.timelines

    const mentionsMap: Record<string, MentionResult[]> = {}

    for (const [streamId, timeline] of Object.entries(timelines)) {
        if (!isGDMChannelStreamId(streamId)) {
            continue
        }
        const gdmId = streamId
        if (!timeline?.length) {
            return state
        }

        let mentions = mentionsMap[gdmId]
        if (!mentions) {
            mentions = []
            mentionsMap[gdmId] = mentions
        }

        const channelMentions = timeline
            .filter((event) => event.isMentioned)
            .map((event) => {
                const threadStat = event.threadParentId
                    ? threadsStats[gdmId]?.[event.threadParentId]
                    : undefined
                const fullyReadMarker = unreadMarkers[event.threadParentId ?? gdmId]
                return {
                    type: 'mention' as const,
                    unread:
                        fullyReadMarker?.isUnread === true &&
                        event.eventNum >= fullyReadMarker.eventNum,
                    channelId: gdmId,
                    timestamp: event.createdAtEpochMs,
                    event,
                    thread: threadStat?.parentEvent,
                }
            })
        mentions.push(...channelMentions)
    }

    for (const [streamId, mentions] of Object.entries(mentionsMap)) {
        mentions.sort(
            //firstBy<MentionResult>((m) => (m.unread ? 0 : 1)).thenBy((a) => a.timestamp, -1),
            (a: MentionResult, b: MentionResult): number => {
                if (a.unread && !b.unread) {
                    return -1
                } else if (!a.unread && b.unread) {
                    return 1
                } else if (a.timestamp > b.timestamp) {
                    return -1
                } else if (a.timestamp < b.timestamp) {
                    return 1
                } else {
                    return 0
                }
            },
        )
        state = setMentions(streamId, mentions, state)
    }
    return state
}

function setMentions(
    streamId: string,
    mentions: MentionResult[],
    prev: MentionsModel,
): MentionsModel {
    if (isEqual(prev.mentionsMap[streamId]?.mentions, mentions)) {
        return prev
    }
    const unreadThreadCount = mentions.reduce((count, m) => {
        return m.thread && m.unread ? count + 1 : count
    }, 0)
    const unreadChannelCount = mentions.reduce((count, m) => {
        return !m.thread && m.unread ? count + 1 : count
    }, 0)
    const next = { mentions, unreadThreadCount, unreadChannelCount }
    return { mentionsMap: { ...prev.mentionsMap, [streamId]: next } }
}
