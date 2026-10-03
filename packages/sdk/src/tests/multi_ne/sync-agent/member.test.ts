/**
 * @group with-entitlements
 */

import type { SyncAgent } from '../../../sync-agent/syncAgent'
import { Bot } from '../../../sync-agent/utils/bot'
import type { Myself } from '../../../sync-agent/members/models/myself'
import { waitFor } from '../../testUtils'

describe('member.test.ts', () => {
    let bobSync: SyncAgent | undefined
    let aliceSync: SyncAgent | undefined
    let bobMyself: Myself | undefined

    beforeAll(async () => {
        const bobUser = new Bot()
        const aliceUser = new Bot()
        await Promise.all([bobUser.fundWallet(), aliceUser.fundWallet()])

        bobSync = await bobUser.makeSyncAgent()
        aliceSync = await aliceUser.makeSyncAgent()
        await Promise.all([bobSync.start(), aliceSync.start()])

        const { streamId } = await bobSync.gdms.createGDM([aliceSync.userId])
        const bobGdm = bobSync.gdms.getGdm(streamId)
        bobMyself = bobGdm.members.myself
        await waitFor(() => expect(bobMyself?.member.value.initialized).toBe(true))
    })

    afterAll(async () => {
        await bobSync?.stop()
        await aliceSync?.stop()
    })

    test('pass', async () => {
        expect(bobMyself).toBeDefined()
        expect(bobMyself?.userId).toBe(bobSync?.userId)
    })
})
