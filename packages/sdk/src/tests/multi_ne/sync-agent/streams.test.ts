/**
 * @group with-entitlements
 */

import { dlogger } from '@towns-labs/utils'
import { Bot } from '../../../sync-agent/utils/bot'
import { makeUniqueGDMChannelStreamId, streamIdAsBytes } from '../../../id'

const logger = dlogger('csb:test:streams')

describe('streams.test.ts', () => {
    logger.log('start')

    test('stream exists', async () => {
        const bobUser = new Bot()
        const aliceUser = new Bot()
        await Promise.all([bobUser.fundWallet(), aliceUser.fundWallet()])

        const bob = await bobUser.makeSyncAgent()
        const alice = await aliceUser.makeSyncAgent()
        await Promise.all([bob.start(), alice.start()])

        const { streamId } = await bob.gdms.createGDM([alice.userId])

        const streamExists = await bob.riverConnection.streamExists(streamIdAsBytes(streamId))
        expect(streamExists).toBe(true)

        const notAStream = makeUniqueGDMChannelStreamId()
        const notAStreamExists = await bob.riverConnection.streamExists(streamIdAsBytes(notAStream))
        expect(notAStreamExists).toBe(false)

        await bob.stop()
        await alice.stop()
    })
})
