/**
 * @group with-entitlements
 */

import { MembershipOp } from '@towns-labs/proto'
import { Bot } from '../../../sync-agent/utils/bot'
import { waitFor } from '../../testUtils'
import type { SyncAgent } from '../../../sync-agent/syncAgent'
import type { Gdm } from '../../../sync-agent/gdms/models/gdm'

describe('members.test.ts', () => {
    let syncAgent: SyncAgent | undefined
    let aliceSync: SyncAgent | undefined
    let gdm: Gdm | undefined

    beforeAll(async () => {
        const bobUser = new Bot()
        const aliceUser = new Bot()

        await Promise.all([bobUser.fundWallet(), aliceUser.fundWallet()])

        syncAgent = await bobUser.makeSyncAgent()
        aliceSync = await aliceUser.makeSyncAgent()
        await Promise.all([syncAgent.start(), aliceSync.start()])

        const { streamId } = await syncAgent.gdms.createGDM([aliceSync.userId])
        gdm = syncAgent.gdms.getGdm(streamId)
    })

    afterAll(async () => {
        await syncAgent?.stop()
        await aliceSync?.stop()
    })

    test('member should be defined in a new gdm', async () => {
        await waitFor(() => expect(syncAgent?.gdms.value.initialized).toBe(true))
        await waitFor(() => expect(gdm?.value.initialized).toBe(true))
        await waitFor(() => expect(gdm?.members.value.initialized).toBe(true))

        const members = gdm!.members.value.userIds
        expect(members).toEqual(expect.arrayContaining([syncAgent!.userId, aliceSync!.userId]))
    })

    test('Members.getMember always return a member, even if not in the gdm yet', async () => {
        const newMember = new Bot()
        const member = gdm!.members.get(newMember.userId)

        await waitFor(() => expect(member.value.initialized).toBe(true))
        expect(member.value.userId).toBe(newMember.userId)
        expect([MembershipOp.SO_UNSPECIFIED, undefined]).toContain(member.value.membership)
    })
})
