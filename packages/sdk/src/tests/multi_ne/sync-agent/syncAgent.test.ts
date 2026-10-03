/**
 * @group with-entitlements
 */

import { dlogger } from '@towns-labs/utils'
import { waitFor } from '../../testUtils'
import { MembershipOp } from '@towns-labs/proto'
import { Bot } from '../../../sync-agent/utils/bot'
import { AuthStatus } from '../../../sync-agent/river-connection/models/authStatus'
import { makeBearerToken, makeSignerContextFromBearerToken } from '../../../signerContext'
import { SyncAgent } from '../../../sync-agent/syncAgent'
import { townsEnv } from '../../../townsEnv'

const logger = dlogger('csb:test:syncAgent')

describe('syncAgent.test.ts', () => {
    const townsConfig = townsEnv().makeTownsConfig()
    const testUser = new Bot(undefined, townsConfig)

    beforeEach(async () => {
        await testUser.fundWallet()
    })

    test('syncAgent', async () => {
        const aliceUser = new Bot()
        await aliceUser.fundWallet()

        const syncAgent = await testUser.makeSyncAgent()
        const alice = await aliceUser.makeSyncAgent()

        expect(syncAgent.riverConnection.authStatus.value).toBe(AuthStatus.Initializing)
        await Promise.all([syncAgent.start(), alice.start()])
        await waitFor(() =>
            expect(syncAgent.riverConnection.authStatus.value).toBe(AuthStatus.ConnectedToRiver),
        )

        await waitFor(() => expect(syncAgent.user.memberships.value.initialized).toBe(true))
        await waitFor(() => expect(syncAgent.user.inbox.value.initialized).toBe(true))
        await waitFor(() => expect(syncAgent.user.deviceKeys.value.initialized).toBe(true))
        await waitFor(() => expect(syncAgent.user.settings.value.initialized).toBe(true))
        await waitFor(() => expect(syncAgent.gdms.value.initialized).toBe(true))

        const { streamId } = await syncAgent.gdms.createGDM([alice.userId])
        logger.log('streamId', streamId)
        await waitFor(() =>
            expect(syncAgent.user.memberships.value.streamMemberships[streamId]?.op).toBe(
                MembershipOp.SO_JOIN,
            ),
        )
        expect(syncAgent.gdms.value.streamIds).toContain(streamId)

        await syncAgent.stop()
        await alice.stop()
    })

    test('syncAgent loads again', async () => {
        const syncAgent = await testUser.makeSyncAgent()
        await syncAgent.start()

        expect(syncAgent.riverConnection.authStatus.value).toBe(AuthStatus.ConnectedToRiver)
        await waitFor(() => expect(syncAgent.user.memberships.value.initialized).toBe(true))
        await waitFor(() => expect(syncAgent.gdms.value.initialized).toBe(true))

        await syncAgent.stop()
    })

    test('logIn with delegate', async () => {
        const aliceUser = new Bot()
        await aliceUser.fundWallet()

        const bearerToken = await makeBearerToken(testUser.signer, { days: 1 })
        logger.log('bearerTokenStr', bearerToken)
        const signerContext = await makeSignerContextFromBearerToken(bearerToken)
        const syncAgent = new SyncAgent({
            townsConfig: townsEnv().makeTownsConfig(),
            context: signerContext,
        })
        const alice = await aliceUser.makeSyncAgent()
        await Promise.all([syncAgent.start(), alice.start()])

        expect(syncAgent.riverConnection.authStatus.value).toBe(AuthStatus.ConnectedToRiver)
        const { streamId } = await syncAgent.gdms.createGDM([alice.userId])
        await waitFor(() =>
            expect(syncAgent.user.memberships.value.streamMemberships[streamId]?.op).toBe(
                MembershipOp.SO_JOIN,
            ),
        )

        await syncAgent.stop()
        await alice.stop()
    })
})
