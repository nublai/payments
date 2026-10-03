import { findMessageByText, waitFor } from '../../testUtils'
import { Bot } from '../../../sync-agent/utils/bot'
import { RiverTimelineEvent } from '../../../views/models/timelineTypes'
import { dlog } from '@towns-labs/utils'

const log = dlog('test:timeline.test.ts')

const setupTest = async () => {
    const bobUser = new Bot()
    const aliceUser = new Bot()
    const charlieUser = new Bot()
    await Promise.all([bobUser.fundWallet(), aliceUser.fundWallet(), charlieUser.fundWallet()])
    const [bob, alice, charlie] = await Promise.all([
        bobUser.makeSyncAgent(),
        aliceUser.makeSyncAgent(),
        charlieUser.makeSyncAgent(),
    ])
    return { bob, alice, charlie, bobUser, aliceUser, charlieUser }
}

describe('timeline.test.ts', () => {
    test.concurrent('send and receive a mention', async () => {
        const { bob, alice } = await setupTest()
        await Promise.all([bob.start(), alice.start()])
        const { streamId } = await bob.gdms.createGDM([alice.userId])
        const bobGdm = bob.gdms.getGdm(streamId)
        const aliceGdm = alice.gdms.getGdm(streamId)

        await aliceGdm.sendMessage('Hi @bob', {
            mentions: [
                {
                    userId: bob.userId,
                    displayName: 'bob',
                    mentionBehavior: { case: undefined, value: undefined },
                },
            ],
        })

        await waitFor(async () => {
            const e = findMessageByText(bobGdm.timeline.events.value, 'Hi @bob')
            expect(
                e?.content?.kind === RiverTimelineEvent.ChannelMessage &&
                    e?.content?.body === 'Hi @bob' &&
                    e?.content?.mentions !== undefined &&
                    e?.content?.mentions.length > 0 &&
                    e?.content?.mentions[0].userId === bob.userId &&
                    e?.content?.mentions[0].displayName === 'bob',
                `mention: ${bobGdm.value.id}`,
            ).toEqual(true)
        })

        await bob.stop()
        await alice.stop()
    })

    test.concurrent('three users in a gdm', async () => {
        const { bob, alice, charlie } = await setupTest()
        await Promise.all([bob.start(), alice.start(), charlie.start()])
        const { streamId } = await bob.gdms.createGDM([alice.userId, charlie.userId])

        const bobGdm = bob.gdms.getGdm(streamId)
        const aliceGdm = alice.gdms.getGdm(streamId)
        const charlieGdm = charlie.gdms.getGdm(streamId)

        await waitFor(() => {
            const members = bobGdm.members.value
            expect(members.initialized).toBe(true)
            expect(members.userIds.length).toBe(3)
        })

        await bobGdm.sendMessage('hey everyone!')
        await Promise.all([
            waitFor(() =>
                expect(
                    findMessageByText(aliceGdm.timeline.events.value, 'hey everyone!'),
                ).toBeTruthy(),
            ),
            waitFor(() =>
                expect(
                    findMessageByText(charlieGdm.timeline.events.value, 'hey everyone!'),
                ).toBeTruthy(),
            ),
        ])

        await Promise.all([
            aliceGdm.sendMessage('Hello Bob from Alice!'),
            charlieGdm.sendMessage('Hello Bob from Charlie!'),
        ])
        await waitFor(() => {
            expect(
                findMessageByText(bobGdm.timeline.events.value, 'Hello Bob from Alice!'),
            ).toBeTruthy()
            expect(
                findMessageByText(bobGdm.timeline.events.value, 'Hello Bob from Charlie!'),
            ).toBeTruthy()
        })

        await bob.stop()
        await alice.stop()
        await charlie.stop()
    })

    test.concurrent('create gdm, send message, send a reaction and redact', async () => {
        const { bob, alice } = await setupTest()
        await Promise.all([bob.start(), alice.start()])
        const { streamId } = await bob.gdms.createGDM([alice.userId])
        const bobGdm = bob.gdms.getGdm(streamId)
        const aliceGdm = alice.gdms.getGdm(streamId)

        await bobGdm.sendMessage('hey!')
        await waitFor(
            async () => {
                const event = findMessageByText(aliceGdm.timeline.events.value, 'hey!')
                expect(
                    event?.content?.kind === RiverTimelineEvent.ChannelMessage &&
                        event?.content?.body === 'hey!',
                    `find hey message: ${aliceGdm.value.id}`,
                ).toEqual(true)
            },
            { timeoutMS: 20000 },
        )

        const messageEvent = findMessageByText(aliceGdm.timeline.events.value, 'hey!')
        expect(messageEvent).toBeTruthy()

        const { eventId: reactionEventId } = await aliceGdm.sendReaction(
            messageEvent!.eventId,
            '👍',
        )
        await waitFor(async () => {
            const reaction = bobGdm.timeline.reactions.value[messageEvent!.eventId]
            expect(reaction).toBeTruthy()
            expect(reaction?.['👍']).toBeTruthy()
            expect(reaction?.['👍'][alice.userId].eventId).toEqual(reactionEventId)
        })

        await aliceGdm.redact(reactionEventId)
        await waitFor(() => {
            const reaction = bobGdm.timeline.reactions.value[messageEvent!.eventId]
            expect(reaction).toStrictEqual({})
        })

        await bob.stop()
        await alice.stop()
    })

    test.concurrent('create gdm and send threaded message', async () => {
        const { bob, alice } = await setupTest()
        await Promise.all([bob.start(), alice.start()])
        const { streamId } = await bob.gdms.createGDM([alice.userId])
        const bobGdm = bob.gdms.getGdm(streamId)
        const aliceGdm = alice.gdms.getGdm(streamId)

        await bobGdm.sendMessage('hey alice, ready to sew?')
        await waitFor(
            async () => {
                const events = aliceGdm.timeline.events.value.map((e) => ({
                    kind: e.content?.kind,
                    body:
                        e.content?.kind === RiverTimelineEvent.ChannelMessage
                            ? e.content?.body
                            : undefined,
                }))
                expect(events, `find ready to sew: ${aliceGdm.value.id}`).toContainEqual({
                    kind: RiverTimelineEvent.ChannelMessage,
                    body: 'hey alice, ready to sew?',
                })
            },
            { timeoutMS: 20000 },
        )

        const event = aliceGdm.timeline.events.value.find(
            (timelineEvent) => timelineEvent.content?.kind === RiverTimelineEvent.ChannelMessage,
        )!
        expect(event?.threadParentId).toBeUndefined()

        const firstReply = await aliceGdm.sendMessage('yey lesgo!', { threadId: event.eventId })
        const secondReply = await aliceGdm.sendMessage('i was planning to make a hat', {
            threadId: event.eventId,
        })

        await waitFor(() => {
            const thread = bobGdm.timeline.threads.value[event.eventId]
            expect(thread).toBeTruthy()
            expect(
                thread?.find((e) => e.eventId === firstReply.eventId)?.content?.kind ===
                    RiverTimelineEvent.ChannelMessage,
                `find first reply ${bobGdm.value.id}`,
            ).toBeTruthy()
            expect(
                thread?.find((e) => e.eventId === secondReply.eventId)?.content?.kind ===
                    RiverTimelineEvent.ChannelMessage,
                `find second reply ${bobGdm.value.id}`,
            ).toBeTruthy()
        })

        await aliceGdm.redact(firstReply.eventId)
        await waitFor(() => {
            const thread = bobGdm.timeline.threads.value[event.eventId]
            expect(
                thread.find((e) => e.eventId === firstReply.eventId)?.content?.kind ===
                    RiverTimelineEvent.RedactedEvent,
                `find first reply redacted ${bobGdm.value.id}`,
            ).toBeTruthy()
            expect(
                thread.find((e) => e.eventId === secondReply.eventId)?.content?.kind ===
                    RiverTimelineEvent.ChannelMessage,
                `find second reply not redacted ${bobGdm.value.id}`,
            ).toBeTruthy()
        })

        await bob.stop()
        await alice.stop()
    })

    test.skip('scrollback', async () => {
        log('scrollback test is currently disabled')
    })
})
