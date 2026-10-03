/**
 * @group with-entitlements
 */

import { dlogger } from '@towns-labs/utils'
import { MembershipOp } from '@towns-labs/proto'
import { Bot } from '../../../sync-agent/utils/bot'
import { findMessageByText, waitFor } from '../../testUtils'

const logger = dlogger('csb:test:spaces')

describe('gdms.test.ts', () => {
    logger.log('start')

    test('create/join/leave gdm', async () => {
        const bobUser = new Bot()
        const aliceUser = new Bot()
        await Promise.all([bobUser.fundWallet(), aliceUser.fundWallet()])

        const bob = await bobUser.makeSyncAgent()
        const alice = await aliceUser.makeSyncAgent()
        await Promise.all([bob.start(), alice.start()])

        await waitFor(() => expect(bob.gdms.value.initialized).toBe(true))
        const { streamId } = await bob.gdms.createGDM([alice.userId])
        await waitFor(() => expect(bob.gdms.value.streamIds).toContain(streamId))
        await waitFor(() => expect(alice.gdms.value.streamIds).toContain(streamId))

        const bobGdm = bob.gdms.getGdm(streamId)
        const aliceGdm = alice.gdms.getGdm(streamId)
        await waitFor(() => expect(bobGdm.value.initialized).toBe(true))
        await waitFor(() => expect(aliceGdm.value.initialized).toBe(true))

        await bobGdm.sendMessage('hello world')
        await waitFor(() =>
            expect(findMessageByText(aliceGdm.timeline.events.value, 'hello world')).toBeDefined(),
        )

        await bobGdm.leave()
        await waitFor(() =>
            expect(bob.user.memberships.getMembership(streamId)?.op).toBe(MembershipOp.SO_LEAVE),
        )

        await bob.stop()
        await alice.stop()
    })
})
