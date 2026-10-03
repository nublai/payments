import { FullyReadMarker } from '@towns-labs/proto'
import { UnreadMarkersModel } from './unreadMarkersTransform'
import { isEqual } from 'lodash-es'
import { ThreadStatsMap, TimelinesViewModel } from '../streams/timelinesModel'
import { isGDMChannelStreamId } from '../../id'

export interface SpaceUnreadsModel {
    spaceUnreads: Record<string, boolean>
    spaceMentions: Record<string, number>
    spaceUnreadChannelIds: Record<string, Set<string>>
}

interface Input {
    mutedStreamIds: Set<string>
    timelinesView: TimelinesViewModel
    myUnreadMarkers: UnreadMarkersModel
}

export function spaceUnreadsTransform(
    input: Input,
    _prevInput: Input,
    prev?: SpaceUnreadsModel,
): SpaceUnreadsModel {
    const { myUnreadMarkers, timelinesView, mutedStreamIds } = input

    let next =
        prev ??
        ({
            spaceUnreads: {},
            spaceMentions: {},
            spaceUnreadChannelIds: {},
        } satisfies SpaceUnreadsModel)

    const updateState = (
        streamId: string,
        hasUnread: boolean,
        mentions: number,
        unreadChannelIds: Set<string>,
        prev: SpaceUnreadsModel,
    ) => {
        const unreadChannelIdsArray = new Set(unreadChannelIds)

        const channelIdsAreEqual = isEqual(
            prev.spaceUnreadChannelIds[streamId],
            unreadChannelIdsArray,
        )
        if (
            prev.spaceUnreads[streamId] === hasUnread &&
            prev.spaceMentions[streamId] === mentions &&
            channelIdsAreEqual
        ) {
            return prev
        }
        const spaceUnreads =
            prev.spaceUnreads[streamId] === hasUnread
                ? prev.spaceUnreads
                : { ...prev.spaceUnreads, [streamId]: hasUnread }
        const spaceMentions =
            prev.spaceMentions[streamId] === mentions
                ? prev.spaceMentions
                : { ...prev.spaceMentions, [streamId]: mentions }
        const spaceUnreadChannelIds = channelIdsAreEqual
            ? prev.spaceUnreadChannelIds
            : { ...prev.spaceUnreadChannelIds, [streamId]: unreadChannelIdsArray }

        return {
            spaceUnreads,
            spaceMentions,
            spaceUnreadChannelIds,
        }
    }

    const markers = myUnreadMarkers.markers
    const threadsStats = timelinesView.threadsStats

    const results: Record<
        string,
        { isUnread: boolean; mentions: number; unreadChannelIds: Set<string> }
    > = {}

    // we have lots of markers! loop over the markers just once and build up the state
    // we should transition updating on a delta of markers
    Object.entries(markers).forEach(([key, marker]) => {
        // fixes symptoms of HNT-10960 by filtering out markers with
        // empty keys. We should be able to remove this once the root
        // cause has been in production for a while.
        if (!key) {
            return
        }

        // only process GDM markers
        if (isGDMChannelStreamId(marker.channelId)) {
            const streamId = marker.channelId
            if (!results[streamId]) {
                results[streamId] = {
                    isUnread: false,
                    mentions: 0,
                    unreadChannelIds: new Set(),
                }
            }
            if (marker.isUnread && isParticipatingThread(marker, threadsStats)) {
                const isMuted = mutedStreamIds?.has(marker.channelId)

                if (!isMuted) {
                    results[streamId].mentions += marker.mentions
                    results[streamId].isUnread = true
                    // dismiss threads when marking channels as unread
                    if (!marker.threadParentId) {
                        results[streamId].unreadChannelIds.add(marker.channelId)
                    }
                }
            }
        }
    })

    Object.entries(results).forEach(([streamId, { isUnread, mentions, unreadChannelIds }]) => {
        next = updateState(streamId, isUnread, mentions, unreadChannelIds, next)
    })
    return next
}

const isParticipatingThread = (marker: FullyReadMarker, threadStats: ThreadStatsMap) => {
    // if the thread has no parent, then it's a channel we're participating in
    if (!marker.threadParentId) {
        return true
    }
    const thread = threadStats[marker.channelId]?.[marker.threadParentId]
    return thread?.isParticipating
}
