/**
 * @group main
 */

import { makeEvent, unpackStreamEnvelopes } from '../../sign'
import { MembershipOp } from '@towns-labs/proto'
import { dlog } from '@towns-labs/utils'
import { lastEventFiltered, makeRandomUserContext, makeTestRpcClient } from '../testUtils'
import {
    makeUniqueGDMChannelStreamId,
    makeUserStreamId,
    streamIdToBytes,
    userIdFromAddress,
} from '../../id'
import {
    getUserPayload_Membership,
    make_GDMChannelPayload_Inception,
    make_MemberPayload_Membership2,
    make_UserPayload_Inception,
} from '../../types'
import { SignerContext } from '../../signerContext'

const baseLog = dlog('csb:test:workflows')

describe('workflows', () => {
    let bobsContext: SignerContext

    beforeEach(async () => {
        bobsContext = await makeRandomUserContext()
    })

    test('creationSideEffects', async () => {
        const log = baseLog.extend('creationSideEffects')
        const bob = await makeTestRpcClient()

        const bobsUserId = userIdFromAddress(bobsContext.creatorAddress)
        const bobsUserStreamId = streamIdToBytes(makeUserStreamId(bobsUserId))
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
        await bob.createStream({
            events: [
                await makeEvent(
                    bobsContext,
                    make_GDMChannelPayload_Inception({
                        streamId: gdmId,
                    }),
                ),
                await makeEvent(
                    bobsContext,
                    make_MemberPayload_Membership2({
                        userId: bobsUserId,
                        op: MembershipOp.SO_JOIN,
                        initiatorId: bobsUserId,
                    }),
                ),
            ],
            streamId: gdmId,
        })

        const userResponse = await bob.getStream({ streamId: bobsUserStreamId })
        expect(userResponse.stream).toBeDefined()
        const joinPayload = lastEventFiltered(
            await unpackStreamEnvelopes(userResponse.stream!, undefined),
            getUserPayload_Membership,
        )
        expect(joinPayload).toBeDefined()
        expect(joinPayload?.op).toEqual(MembershipOp.SO_JOIN)
        expect(joinPayload?.streamId).toEqual(gdmId)

        const gdmResponse = await bob.getStream({ streamId: gdmId })
        expect(gdmResponse.stream).toBeDefined()
        const parsedGdm = await unpackStreamEnvelopes(gdmResponse.stream!, undefined)
        const inception = parsedGdm.find(
            (e) =>
                e.event.payload.case === 'gdmChannelPayload' &&
                e.event.payload.value.content.case === 'inception',
        )
        expect(inception).toBeDefined()

        log('done')
    })
})
