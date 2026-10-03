/**
 * @group with-entitlements
 */

import { dlogger } from '@towns-labs/utils'
import { Bot } from '../../../sync-agent/utils/bot'
import { waitFor } from '../../testUtils'
import { MembershipOp } from '@towns-labs/proto'

const logger = dlogger('csb:test:user')

describe('User.test.ts', () => {
    logger.log('start')
    const testUser = new Bot()

    beforeEach(async () => {
        await testUser.fundWallet()
    })

    test('User initializes', async () => {
        const aliceUser = new Bot()
        await aliceUser.fundWallet()

        const syncAgent = await testUser.makeSyncAgent()
        const alice = await aliceUser.makeSyncAgent()
        const user = syncAgent.user
        const gdms = syncAgent.gdms

        expect(user.id).toBe(testUser.userId)
        expect(user.memberships.value.initialized).toBe(false)
        expect(user.inbox.value.initialized).toBe(false)
        expect(user.deviceKeys.value.initialized).toBe(false)
        expect(user.settings.value.initialized).toBe(false)

        await Promise.all([syncAgent.start(), alice.start()])
        await waitFor(() => expect(user.memberships.value.initialized).toBe(true))
        await waitFor(() => expect(user.inbox.value.initialized).toBe(true))
        await waitFor(() => expect(user.deviceKeys.value.initialized).toBe(true))
        await waitFor(() => expect(user.settings.value.initialized).toBe(true))

        const { streamId } = await gdms.createGDM([alice.userId])
        logger.log('created streamId', streamId)
        await waitFor(() =>
            expect(user.memberships.value.streamMemberships[streamId]?.op).toBe(
                MembershipOp.SO_JOIN,
            ),
        )

        expect(user.memberships.value.initialized).toBe(true)
        expect(user.inbox.value.initialized).toBe(true)
        expect(user.deviceKeys.value.initialized).toBe(true)
        expect(user.settings.value.initialized).toBe(true)
        await syncAgent.stop()
        await alice.stop()
    })

    test('User loads from db', async () => {
        const syncAgent = await testUser.makeSyncAgent()
        const user = syncAgent.user
        await syncAgent.start()
        await waitFor(() => expect(user.memberships.value.initialized).toBe(true))
        await waitFor(() => expect(user.inbox.value.initialized).toBe(true))
        await waitFor(() => expect(user.deviceKeys.value.initialized).toBe(true))
        await waitFor(() => expect(user.settings.value.initialized).toBe(true))
        await syncAgent.stop()
    })
})
