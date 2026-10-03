/**
 * @group with-entitlements
 */

import { dlogger } from '@towns-labs/utils'
import { SyncAgent } from '../../../sync-agent/syncAgent'
import { Bot } from '../../../sync-agent/utils/bot'
import { findMessageByText, waitFor, waitForValue } from '../../testUtils'

const logger = dlogger('csb:test:syncAgents')

describe('syncAgents.test.ts', () => {
    logger.log('start')
    const bobUser = new Bot()
    const aliceUser = new Bot()
    const charlieUser = new Bot()
    let bob: SyncAgent
    let alice: SyncAgent
    let charlie: SyncAgent

    beforeEach(async () => {
        await Promise.all([bobUser.fundWallet(), aliceUser.fundWallet(), charlieUser.fundWallet()])
        bob = await bobUser.makeSyncAgent()
        alice = await aliceUser.makeSyncAgent()
        charlie = await charlieUser.makeSyncAgent()
    })

    afterEach(async () => {
        await bob.stop()
        await alice.stop()
        await charlie.stop()
    })

    test('syncAgents', async () => {
        await Promise.all([bob.start(), alice.start(), charlie.start()])

        const { streamId } = await bob.gdms.createGDM([alice.userId, charlie.userId])
        await waitFor(() => expect(bob.gdms.value.streamIds).toContain(streamId))
        await waitFor(() => expect(alice.gdms.value.streamIds).toContain(streamId))
        await waitFor(() => expect(charlie.gdms.value.streamIds).toContain(streamId))
    })

    test('syncAgents load async', async () => {
        await bob.start()
        const { streamId } = await bob.gdms.createGDM([alice.userId])

        await alice.start()
        await waitFor(() => expect(alice.gdms.value.streamIds).toContain(streamId))
    })

    test('syncAgents send a message', async () => {
        await Promise.all([bob.start(), alice.start()])
        const { streamId } = await bob.gdms.createGDM([alice.userId])

        const bobGdm = bob.gdms.getGdm(streamId)
        const aliceGdm = alice.gdms.getGdm(streamId)
        await waitFor(() => expect(bobGdm.value.initialized).toBe(true))
        await waitFor(() => expect(aliceGdm.value.initialized).toBe(true))

        await bobGdm.sendMessage('Hello, World!')
        await waitFor(() =>
            expect(
                findMessageByText(aliceGdm.timeline.events.value, 'Hello, World!'),
            ).toBeDefined(),
        )
    })

    test('syncAgents send a message with disableSignatureValidation=true', async () => {
        const prevBobOpts = bob.riverConnection.clientParams.opts?.unpackEnvelopeOpts
        const prevAliceOpts = alice.riverConnection.clientParams.opts?.unpackEnvelopeOpts
        bob.riverConnection.clientParams.opts = {
            ...bob.riverConnection.clientParams.opts,
            unpackEnvelopeOpts: {
                disableSignatureValidation: true,
            },
        }
        alice.riverConnection.clientParams.opts = {
            ...alice.riverConnection.clientParams.opts,
            unpackEnvelopeOpts: {
                disableSignatureValidation: true,
            },
        }

        await Promise.all([bob.start(), alice.start()])
        const { streamId } = await bob.gdms.createGDM([alice.userId])

        const bobGdm = bob.gdms.getGdm(streamId)
        const aliceGdm = alice.gdms.getGdm(streamId)
        await bobGdm.sendMessage('Hello, World again!')
        await waitFor(() =>
            expect(
                findMessageByText(aliceGdm.timeline.events.value, 'Hello, World again!'),
            ).toBeDefined(),
        )

        bob.riverConnection.clientParams.opts = {
            ...bob.riverConnection.clientParams.opts,
            unpackEnvelopeOpts: prevBobOpts,
        }
        alice.riverConnection.clientParams.opts = {
            ...alice.riverConnection.clientParams.opts,
            unpackEnvelopeOpts: prevAliceOpts,
        }
    })

    test('syncAgents pin a message', async () => {
        await Promise.all([bob.start(), alice.start()])
        const { streamId } = await bob.gdms.createGDM([alice.userId])
        const bobGdm = bob.gdms.getGdm(streamId)
        const aliceGdm = alice.gdms.getGdm(streamId)

        await bobGdm.sendMessage('pin me')
        const event = await waitForValue(() => {
            const found = findMessageByText(bobGdm.timeline.events.value, 'pin me')
            expect(found).toBeDefined()
            return found
        })

        await bobGdm.pin(event.eventId)
        await waitFor(() =>
            expect(
                bob.riverConnection.client?.streams.get(streamId)?.view.membershipContent.pins
                    .length,
            ).toBe(1),
        )
        await bobGdm.unpin(event.eventId)
        await waitFor(() =>
            expect(
                bob.riverConnection.client?.streams.get(streamId)?.view.membershipContent.pins
                    .length,
            ).toBe(0),
        )

        await waitFor(() => expect(aliceGdm.value.initialized).toBe(true))
        await aliceGdm.pin(event.eventId)
    })

    test('gdm', async () => {
        await Promise.all([bob.start(), alice.start(), charlie.start()])
        const { streamId } = await bob.gdms.createGDM([alice.userId, charlie.userId])
        const bobGdm = bob.gdms.getGdm(streamId)
        await waitFor(() => expect(bobGdm.members.value.initialized).toBe(true))
        expect(bobGdm.members.value.userIds).toEqual(
            expect.arrayContaining([bob.userId, alice.userId, charlie.userId]),
        )
        await bobGdm.sendMessage('Hello, World!')
        const aliceGdm = alice.gdms.getGdm(streamId)
        await waitFor(() =>
            expect(
                findMessageByText(aliceGdm.timeline.events.value, 'Hello, World!'),
            ).toBeDefined(),
        )
    })
})
