/**
 * @group main
 */

import { MembershipOp } from '@towns-labs/proto'
import { makeTestClient, waitFor } from '../testUtils'

describe('streamStateView_User', () => {
    test('userStreamMembershipsJoin', async () => {
        const bob = await makeTestClient()
        const alice = await makeTestClient()

        try {
            await bob.initializeUser()
            await alice.initializeUser()
            bob.startSync()
            alice.startSync()

            const { streamId } = await bob.createGDMChannel([])
            await expect(bob.waitForStream(streamId)).resolves.not.toThrow()

            await expect(bob.inviteUser(streamId, alice.userId)).resolves.not.toThrow()
            const aliceUserStream = await alice.waitForStream(alice.userStreamId!)
            await waitFor(
                () =>
                    aliceUserStream.view.userContent.streamMemberships[streamId]?.op ===
                    MembershipOp.SO_INVITE,
            )

            await expect(alice.joinStream(streamId)).resolves.not.toThrow()
            await waitFor(
                () =>
                    aliceUserStream.view.userContent.streamMemberships[streamId]?.op ===
                    MembershipOp.SO_JOIN,
            )

            await expect(alice.leaveStream(streamId)).resolves.not.toThrow()
            await waitFor(
                () =>
                    aliceUserStream.view.userContent.streamMemberships[streamId]?.op ===
                    MembershipOp.SO_LEAVE,
            )
        } finally {
            await bob.stop()
            await alice.stop()
        }
    })
})
