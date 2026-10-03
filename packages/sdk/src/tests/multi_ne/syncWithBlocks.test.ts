/**
 * @group main
 */

import { MembershipOp, StreamAndCookie, SyncOp } from '@towns-labs/proto'
import { dlog } from '@towns-labs/utils'
import {
    makeUniqueGDMChannelStreamId,
    makeUserStreamId,
    streamIdToBytes,
    userIdFromAddress,
} from '../../id'
import { makeEvent, unpackStream, unpackStreamEnvelopes } from '../../sign'
import {
    getMessagePayload,
    getMiniblockHeader,
    make_GDMChannelPayload_Inception,
    make_GDMChannelPayload_Message,
    make_MemberPayload_Membership2,
    make_UserPayload_Inception,
} from '../../types'
import {
    TEST_ENCRYPTED_MESSAGE_PROPS,
    makeRandomUserContext,
    makeTestRpcClient,
    iterableWrapper,
} from '../testUtils'
import { SignerContext } from '../../signerContext'

const log = dlog('csb:test:syncWithBlocks')

describe('syncWithBlocks', () => {
    let bobsContext: SignerContext

    beforeEach(async () => {
        bobsContext = await makeRandomUserContext()
    })

    test('blocksGetGeneratedAndSynced', async () => {
        log('start')

        const bob = await makeTestRpcClient()

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
        let nextHash = gdmJoinEvent.hash
        await bob.createStream({
            events: [gdmInceptionEvent, gdmJoinEvent],
            streamId: gdmId,
        })

        const gdm = await bob.getStream({ streamId: gdmId })
        expect(gdm).toBeDefined()
        expect(gdm.stream).toBeDefined()
        expect(gdm.stream?.nextSyncCookie?.streamId).toEqual(gdmId)

        const events = (
            await unpackStream(gdm.stream, undefined)
        ).streamAndCookie.miniblocks.flatMap((mb) => mb.events)
        const lastEvent = events.at(-1)

        const miniblockHeader = getMiniblockHeader(lastEvent)
        expect(miniblockHeader).toBeDefined()
        expect(miniblockHeader?.miniblockNum).toEqual(0n)
        expect(miniblockHeader?.eventHashes).toHaveLength(3)

        const knownHashes = new Set(events.map((e) => e.hashStr))

        let text = 'hello '
        const messageEvent = await makeEvent(
            bobsContext,
            make_GDMChannelPayload_Message({
                ...TEST_ENCRYPTED_MESSAGE_PROPS,
                ciphertext: text,
            }),
            gdm.stream?.miniblocks.at(-1)?.header?.hash,
        )
        nextHash = messageEvent.hash
        await bob.addEvent({
            streamId: gdmId,
            event: messageEvent,
        })

        const syncStream = bob.syncStreams(
            {
                syncPos: [gdm.stream!.nextSyncCookie!],
            },
            {
                timeoutMs: -1,
                headers: { 'X-Use-Shared-Sync': 'true' },
            },
        )

        let expectMessage = true
        let blocksSeen = 0
        let cancelled = false

        for await (const res of iterableWrapper(syncStream)) {
            if (res.syncOp === SyncOp.SYNC_CLOSE) {
                break
            }
            if (res.syncOp !== SyncOp.SYNC_UPDATE || !res.stream) {
                continue
            }

            const stream: StreamAndCookie | undefined = res.stream
            expect(stream).toBeDefined()
            const parsed = await unpackStreamEnvelopes(res.stream, undefined)
            for (const p of parsed) {
                if (knownHashes.has(p.hashStr)) {
                    continue
                }
                knownHashes.add(p.hashStr)

                if (expectMessage) {
                    const message = getMessagePayload(p)
                    expect(message).toBeDefined()
                    expect(message?.ciphertext).toEqual(text)
                    expectMessage = false
                    continue
                }

                const header = getMiniblockHeader(p)
                expect(header).toBeDefined()
                expect(header?.miniblockNum).toEqual(BigInt(blocksSeen + 1))
                expect(header?.eventHashes).toHaveLength(1)
                expect(header?.eventHashes[0]).toEqual(nextHash)

                if (blocksSeen > 10) {
                    await bob.cancelSync({ syncId: res.syncId })
                    cancelled = true
                    break
                }

                expectMessage = true
                text = `${text} ${blocksSeen}`
                blocksSeen++

                const nextMessage = await makeEvent(
                    bobsContext,
                    make_GDMChannelPayload_Message({
                        ...TEST_ENCRYPTED_MESSAGE_PROPS,
                        ciphertext: text,
                    }),
                    p.hash,
                )
                nextHash = nextMessage.hash
                await bob.addEvent({
                    streamId: gdmId,
                    event: nextMessage,
                })
            }

            if (cancelled) {
                break
            }
        }

        log('done')
    })
})
