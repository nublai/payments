import { findMessageByText, waitFor } from '../../testUtils'
import { Bot } from '../../../sync-agent/utils/bot'
import { RiverTimelineEvent } from '../../../views/models/timelineTypes'

describe('appClientAddress.test.ts', () => {
    test.concurrent('appClientAddress surfaces on receiver timeline', async () => {
        const aliceUser = new Bot()
        const bobUser = new Bot()
        await Promise.all([aliceUser.fundWallet(), bobUser.fundWallet()])
        const [alice, bob] = await Promise.all([aliceUser.makeSyncAgent(), bobUser.makeSyncAgent()])
        await Promise.all([alice.start(), bob.start()])

        const { streamId } = await alice.gdms.createGDM([bob.userId])
        const aliceGdm = alice.gdms.getGdm(streamId)
        const bobGdm = bob.gdms.getGdm(streamId)
        await waitFor(() => expect(aliceGdm.value.initialized).toBe(true))
        await waitFor(() => expect(bobGdm.value.initialized).toBe(true))

        // Alice sends a slash command targeting bob
        await aliceGdm.sendMessage('/ask what is life', {
            appClientAddress: bob.userId,
        })

        // Bob sees the message with appClientAddress
        await waitFor(() => {
            const event = findMessageByText(bobGdm.timeline.events.value, '/ask what is life')
            expect(event).toBeTruthy()
            if (event?.content?.kind === RiverTimelineEvent.ChannelMessage) {
                expect(event.content.appClientAddress).toBeTruthy()
            }
        })

        // Alice (sender) sees it too after confirmation
        await waitFor(() => {
            const event = findMessageByText(aliceGdm.timeline.events.value, '/ask what is life')
            expect(event).toBeTruthy()
            if (event?.content?.kind === RiverTimelineEvent.ChannelMessage) {
                expect(event.content.appClientAddress).toBeTruthy()
            }
        })

        await alice.stop()
        await bob.stop()
    })

    test.concurrent('appClientAddress persists after server confirmation', async () => {
        const aliceUser = new Bot()
        const bobUser = new Bot()
        await Promise.all([aliceUser.fundWallet(), bobUser.fundWallet()])
        const [alice, bob] = await Promise.all([aliceUser.makeSyncAgent(), bobUser.makeSyncAgent()])
        await Promise.all([alice.start(), bob.start()])

        const { streamId } = await alice.gdms.createGDM([bob.userId])
        const aliceGdm = alice.gdms.getGdm(streamId)
        await waitFor(() => expect(aliceGdm.value.initialized).toBe(true))

        const { eventId } = await aliceGdm.sendMessage('/ask meaning of life', {
            appClientAddress: bob.userId,
        })

        // After send resolves, the confirmed event should still have appClientAddress
        await waitFor(() => {
            const event = aliceGdm.timeline.events.value.find((e) => e.eventId === eventId)
            expect(event).toBeTruthy()
            expect(event?.content?.kind).toBe(RiverTimelineEvent.ChannelMessage)
            if (event?.content?.kind === RiverTimelineEvent.ChannelMessage) {
                expect(event.content.appClientAddress).toBeTruthy()
            }
        })

        await alice.stop()
        await bob.stop()
    })

    test.concurrent('normal message has no appClientAddress', async () => {
        const aliceUser = new Bot()
        const bobUser = new Bot()
        await Promise.all([aliceUser.fundWallet(), bobUser.fundWallet()])
        const [alice, bob] = await Promise.all([aliceUser.makeSyncAgent(), bobUser.makeSyncAgent()])
        await Promise.all([alice.start(), bob.start()])

        const { streamId } = await alice.gdms.createGDM([bob.userId])
        const aliceGdm = alice.gdms.getGdm(streamId)
        const bobGdm = bob.gdms.getGdm(streamId)
        await waitFor(() => expect(aliceGdm.value.initialized).toBe(true))
        await waitFor(() => expect(bobGdm.value.initialized).toBe(true))

        await aliceGdm.sendMessage('just a normal message')

        await waitFor(() => {
            const event = findMessageByText(bobGdm.timeline.events.value, 'just a normal message')
            expect(event).toBeTruthy()
            if (event?.content?.kind === RiverTimelineEvent.ChannelMessage) {
                expect(event.content.appClientAddress).toBeUndefined()
            }
        })

        await alice.stop()
        await bob.stop()
    })
})
