/**
 * @group main
 */

import { makeEvent, unpackStreamEnvelopes } from '../../sign'
import { MembershipOp, SyncOp } from '@towns-labs/proto'
import {
    makeRandomUserContext,
    makeTestRpcClient,
    TEST_ENCRYPTED_MESSAGE_PROPS,
    waitForSyncStreams,
} from '../testUtils'
import {
    makeUniqueGDMChannelStreamId,
    makeUserStreamId,
    streamIdToBytes,
    userIdFromAddress,
} from '../../id'
import {
    make_GDMChannelPayload_Inception,
    make_GDMChannelPayload_Message,
    make_MemberPayload_Membership2,
    make_UserPayload_Inception,
} from '../../types'
import { SignerContext } from '../../signerContext'

describe('streamRpcClient using v2 sync', () => {
    let alicesContext: SignerContext
    let bobsContext: SignerContext

    beforeEach(async () => {
        alicesContext = await makeRandomUserContext()
        bobsContext = await makeRandomUserContext()
    })

    test('syncStreamsGetsSyncId', async () => {
        const alice = await makeTestRpcClient()
        const alicesUserId = userIdFromAddress(alicesContext.creatorAddress)
        const alicesUserStreamId = streamIdToBytes(makeUserStreamId(alicesUserId))

        await alice.createStream({
            events: [
                await makeEvent(
                    alicesContext,
                    make_UserPayload_Inception({
                        streamId: alicesUserStreamId,
                    }),
                ),
            ],
            streamId: alicesUserStreamId,
        })

        const gdmIdStr = makeUniqueGDMChannelStreamId()
        const gdmId = streamIdToBytes(gdmIdStr)
        const alicesGdm = await alice.createStream({
            events: [
                await makeEvent(
                    alicesContext,
                    make_GDMChannelPayload_Inception({
                        streamId: gdmId,
                    }),
                ),
                await makeEvent(
                    alicesContext,
                    make_MemberPayload_Membership2({
                        userId: alicesUserId,
                        op: MembershipOp.SO_JOIN,
                        initiatorId: alicesUserId,
                    }),
                ),
            ],
            streamId: gdmId,
        })

        let syncId: string | undefined
        const syncCookie = alicesGdm.stream!.nextSyncCookie!

        const aliceStreamIterable = alice.syncStreams(
            {
                syncPos: [syncCookie],
            },
            {
                timeoutMs: -1,
                headers: { 'X-Use-Shared-Sync': 'true' },
            },
        )

        await expect(
            waitForSyncStreams(aliceStreamIterable, async (res) => {
                syncId = res.syncId
                return res.syncOp === SyncOp.SYNC_NEW && res.syncId !== undefined
            }),
        ).resolves.not.toThrow()

        await alice.cancelSync({ syncId })

        expect(syncId).toBeDefined()
    })

    test('modifySyncGetsEvents', async () => {
        const alice = await makeTestRpcClient()
        const alicesUserId = userIdFromAddress(alicesContext.creatorAddress)
        const alicesUserStreamId = streamIdToBytes(makeUserStreamId(alicesUserId))

        const bob = await makeTestRpcClient()
        const bobsUserId = userIdFromAddress(bobsContext.creatorAddress)
        const bobsUserStreamId = streamIdToBytes(makeUserStreamId(bobsUserId))

        await alice.createStream({
            events: [
                await makeEvent(
                    alicesContext,
                    make_UserPayload_Inception({
                        streamId: alicesUserStreamId,
                    }),
                ),
            ],
            streamId: alicesUserStreamId,
        })
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

        const gdmIdStr = makeUniqueGDMChannelStreamId()
        const gdmId = streamIdToBytes(gdmIdStr)
        const alicesGdm = await alice.createStream({
            events: [
                await makeEvent(
                    alicesContext,
                    make_GDMChannelPayload_Inception({
                        streamId: gdmId,
                    }),
                ),
                await makeEvent(
                    alicesContext,
                    make_MemberPayload_Membership2({
                        userId: alicesUserId,
                        op: MembershipOp.SO_JOIN,
                        initiatorId: alicesUserId,
                    }),
                ),
                await makeEvent(
                    alicesContext,
                    make_MemberPayload_Membership2({
                        userId: bobsUserId,
                        op: MembershipOp.SO_JOIN,
                        initiatorId: alicesUserId,
                    }),
                ),
            ],
            streamId: gdmId,
        })

        const bobSyncStreams = bob.syncStreams(
            {
                syncPos: [],
            },
            {
                timeoutMs: -1,
                headers: { 'X-Use-Shared-Sync': 'true' },
            },
        )

        let syncId: string | undefined
        await expect(
            waitForSyncStreams(bobSyncStreams, async (resp) => {
                if (resp.syncOp === SyncOp.SYNC_NEW) {
                    syncId = resp.syncId
                    return true
                }
                return false
            }),
        ).resolves.not.toThrow()

        const bobsGdmStream = await bob.getStream({ streamId: gdmId }, { timeoutMs: -1 })
        await bob.modifySync({
            syncId: syncId!,
            addStreams: [bobsGdmStream.stream!.nextSyncCookie!],
        })

        const messageEvent = await makeEvent(
            alicesContext,
            make_GDMChannelPayload_Message({
                ...TEST_ENCRYPTED_MESSAGE_PROPS,
                ciphertext: 'hello',
            }),
            alicesGdm.stream?.miniblocks.at(-1)?.header?.hash,
        )
        await alice.addEvent({
            streamId: gdmId,
            event: messageEvent,
        })

        await expect(
            waitForSyncStreams(bobSyncStreams, async (resp) => {
                if (resp.syncOp !== SyncOp.SYNC_UPDATE || !resp.stream) {
                    return false
                }
                const events = await unpackStreamEnvelopes(resp.stream, undefined)
                return events.some(
                    (e) =>
                        e.event.payload.case === 'gdmChannelPayload' &&
                        e.event.payload.value.content.case === 'message' &&
                        e.event.payload.value.content.value.ciphertext === 'hello',
                )
            }),
        ).resolves.not.toThrow()

        await bob.cancelSync({ syncId })
    })
})
