import { makeEvent } from '../sign'
import { MembershipOp, SyncStreamsResponse, Envelope, SyncOp } from '@towns-labs/proto'
import { DLogger } from '@towns-labs/utils'
import {
    makeEvent_test,
    makeTestRpcClient,
    sendFlush,
    TEST_ENCRYPTED_MESSAGE_PROPS,
    waitForSyncStreams,
    waitForSyncStreamsMessage,
} from './testUtils'
import {
    makeUniqueGDMChannelStreamId,
    makeUserStreamId,
    streamIdToBytes,
    userIdFromAddress,
} from '../id'
import {
    make_GDMChannelPayload_Inception,
    make_GDMChannelPayload_Message,
    make_MemberPayload_Membership2,
    make_UserPayload_Inception,
} from '../types'
import { SignerContext } from '../signerContext'

export const bobTalksToHimself = async (
    log: DLogger,
    bobsContext: SignerContext,
    flush: boolean,
    presync: boolean,
) => {
    log('start')

    const bob = await makeTestRpcClient()

    const maybeFlush = flush
        ? async () => {
              await sendFlush(bob)
              log('flushed')
          }
        : async () => {}

    const bobsUserId = userIdFromAddress(bobsContext.creatorAddress)
    const bobsUserStreamIdStr = makeUserStreamId(bobsUserId)
    const bobsUserStreamId = streamIdToBytes(bobsUserStreamIdStr)
    await bob.createStream({
        events: [
            await makeEvent(
                bobsContext,
                make_UserPayload_Inception({
                    streamId: bobsUserStreamId,
                }),
            ),
        ],
        streamId: bobsUserStreamId,
    })
    await maybeFlush()

    const gdmIdStr = makeUniqueGDMChannelStreamId()
    const gdmId = streamIdToBytes(gdmIdStr)

    const gdmInceptionEvent = await makeEvent(
        bobsContext,
        make_GDMChannelPayload_Inception({
            streamId: gdmId,
        }),
    )
    const gdmJoinEvent = await makeEvent(
        bobsContext,
        make_MemberPayload_Membership2({
            userId: bobsUserId,
            op: MembershipOp.SO_JOIN,
            initiatorId: bobsUserId,
        }),
    )
    const gdmEvents = [gdmInceptionEvent, gdmJoinEvent]
    log('creating gdm with events=', gdmEvents)
    await bob.createStream({
        events: gdmEvents,
        streamId: gdmId,
    })

    log('Bob created gdm, reads it back')
    const gdm = await bob.getStream({ streamId: gdmId })
    expect(gdm).toBeDefined()
    expect(gdm.stream).toBeDefined()
    expect(gdm.stream?.nextSyncCookie?.streamId).toEqual(gdmId)
    await maybeFlush()

    let presyncEvent: Envelope | undefined = undefined
    if (presync) {
        log('adding event before sync, so it should be the first event in the sync stream')
        presyncEvent = await makeEvent(
            bobsContext,
            make_GDMChannelPayload_Message({
                ...TEST_ENCRYPTED_MESSAGE_PROPS,
                ciphertext: 'presync',
            }),
            gdm.stream?.miniblocks.at(-1)?.header?.hash,
        )
        await bob.addEvent({
            streamId: gdmId,
            event: presyncEvent,
        })
        await maybeFlush()
    }

    log('Bob starts sync with sync cookie=', gdm.stream?.nextSyncCookie)

    let syncCookie = gdm.stream!.nextSyncCookie!
    const bobSyncStreamIterable: AsyncIterable<SyncStreamsResponse> = bob.syncStreams(
        {
            syncPos: [syncCookie],
        },
        {
            timeoutMs: -1,
            headers: { 'X-Use-Shared-Sync': 'true' },
        },
    )
    await expect(
        waitForSyncStreams(
            bobSyncStreamIterable,
            async (res) => res.syncOp === SyncOp.SYNC_NEW && res.syncId !== undefined,
        ),
    ).resolves.not.toThrow()

    if (flush || presync) {
        log('flush or presync, wait for sync to return initial events')
        const syncResult = await waitForSyncStreamsMessage(bobSyncStreamIterable, 'presync')
        expect(syncResult?.stream).toBeDefined()
        const stream = syncResult.stream
        expect(stream).toBeDefined()
        if (!stream) {
            throw new Error('stream is undefined')
        }
        expect(stream.nextSyncCookie?.streamId).toEqual(gdmId)

        if (flush) {
            expect(stream.events).toEqual(presync ? [...gdmEvents, presyncEvent] : gdmEvents)
        } else {
            expect(stream.events).toEqual(expect.arrayContaining([presyncEvent]))
        }

        syncCookie = stream.nextSyncCookie!
    }

    log('Bob posts a message')

    await maybeFlush()
    const hashResponse = await bob.getLastMiniblockHash({ streamId: gdmId })
    const helloEvent = await makeEvent(
        bobsContext,
        make_GDMChannelPayload_Message({
            ...TEST_ENCRYPTED_MESSAGE_PROPS,
            ciphertext: 'hello',
        }),
        hashResponse.hash,
    )
    await bob.addEvent({
        streamId: gdmId,
        event: helloEvent,
    })

    log('Bob waits for sync to complete')
    const syncResult = await waitForSyncStreamsMessage(bobSyncStreamIterable, 'hello')
    expect(syncResult?.stream).toBeDefined()
    const stream = syncResult?.stream
    expect(stream).toBeDefined()
    expect(stream?.nextSyncCookie?.streamId).toEqual(gdmId)
    // With direct miniblock production, sync receives both the user event and the
    // miniblock header event in a single update (previously these came separately)
    expect(stream?.events).toEqual(expect.arrayContaining([helloEvent]))
    expect(stream?.events?.length).toBeGreaterThanOrEqual(1)

    log('stopping sync')
    await bob.cancelSync({ syncId: syncResult.syncId })

    log("Bob can't post event without previous event hashes")
    await maybeFlush()
    const badEvent = await makeEvent_test(
        bobsContext,
        make_GDMChannelPayload_Message({
            ...TEST_ENCRYPTED_MESSAGE_PROPS,
            ciphertext: 'hello',
        }),
        Uint8Array.from([1, 2, 3]),
    )
    await expect(
        bob.addEvent({
            streamId: gdmId,
            event: badEvent,
        }),
    ).rejects.toThrow(/24:BAD_PREV_MINIBLOCK_HASH/)

    log('Adding event again succeeds')
    await maybeFlush()
    await expect(
        bob.addEvent({
            streamId: gdmId,
            event: helloEvent,
        }),
    ).resolves.not.toThrow()

    log('done')
}
