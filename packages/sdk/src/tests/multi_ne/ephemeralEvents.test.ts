/**
 * @group main
 */

import { createEventDecryptedPromise, makeDonePromise, makeTestClient, waitFor } from '../testUtils'
import { Client } from '../../client'
import { make_MemberPayload_KeyFulfillment, make_MemberPayload_KeySolicitation } from '../../types'
import { hexToBytes } from 'ethereum-cryptography/utils'
import { MembershipOp } from '@towns-labs/proto'
import { RiverTimelineEvent } from '../../views/models/timelineTypes'

// Scaffold for ephemeral events tests

describe('ephemeralEvents', () => {
    let clients: Client[] = []

    const makeInitAndStartClient = async () => {
        const client = await makeTestClient()
        await client.initializeUser()
        client.startSync()
        clients.push(client)
        return client
    }

    beforeEach(async () => {})

    afterEach(async () => {
        for (const client of clients) {
            await client.stop()
        }
        clients = []
    })

    test('should allow ephemeral key fulfillments', async () => {
        const alice = await makeInitAndStartClient()
        const bob = await makeInitAndStartClient()
        const { streamId } = await alice.createGDMChannel([bob.userId])

        const deviceKey = alice.userDeviceKey()
        const event = make_MemberPayload_KeySolicitation({
            deviceKey: deviceKey.deviceKey,
            fallbackKey: deviceKey.fallbackKey,
            isNewDevice: false,
            sessionIds: ['abc'],
        })

        await alice.makeEventAndAddToStream(streamId, event, {
            ephemeral: true,
        })

        // before actually fulfilling the key solicitation, this event tells everyone that is listening, that bob fulfilled alice's key solicitation
        const fulfillmentEvent = make_MemberPayload_KeyFulfillment({
            userAddress: hexToBytes(bob.userId),
            deviceKey: deviceKey.deviceKey,
            sessionIds: ['abc'],
        })

        // make sure bob's stream is initialized before sending the fulfillment event
        await bob.waitForStream(streamId, { timeoutMs: 10000 })

        // try to send the fulfillment event, but it should fail because it's not the right device key
        await expect(
            bob.makeEventAndAddToStream(streamId, fulfillmentEvent, {
                ephemeral: false,
            }),
        ).rejects.toThrow('solicitation with matching device key not found')

        // now send the fulfillment event, but it should succeed because it's ephemeral
        await bob.makeEventAndAddToStream(streamId, fulfillmentEvent, {
            ephemeral: true,
        })
    })

    test('should convert ephemeral to non-ephemeral after timeout', async () => {
        // let's use a GDM to allow people to join after stream creation. we need to test that the ephemeral
        // solicitation is converted to non-ephemeral after the timeout.
        const alice = await makeInitAndStartClient()
        const bob = await makeInitAndStartClient()
        const charlie = await makeInitAndStartClient()
        const chuck = await makeInitAndStartClient()

        // Set a short timeout for testing
        chuck['decryptionExtensions']!.ephemeralTimeoutMs = 100

        const { streamId } = await alice.createGDMChannel([bob.userId, charlie.userId])

        await waitFor(() => {
            return alice.streams.get(streamId)?.view.membershipContent.joined.size === 3
        })

        const solicitationEphemeralTypes: boolean[] = []
        chuck.on('newKeySolicitation', (_, __, ___, ____, _____, ephemeral) => {
            solicitationEphemeralTypes.push(ephemeral ?? false)
        })

        // Send a message that will trigger ephemeral key solicitation
        await alice.sendMessage(streamId, 'test message')
        await alice.inviteUser(streamId, chuck.userId)
        await alice.stop()
        await bob.stop()
        await charlie.stop()

        const stream = await chuck.waitForStream(streamId)
        await stream.waitForMembership(MembershipOp.SO_INVITE)
        await expect(chuck.joinStream(streamId)).resolves.not.toThrow()

        // Wait for ephemeral and non-ephemeral solicitation
        // [true, false] indicates that chuck sent two solicitation events, one ephemeral and one non-ephemeral
        await waitFor(() => solicitationEphemeralTypes.length === 2)
        expect(solicitationEphemeralTypes).toEqual([true, false])
    })

    test('should handle ephemeral key exchange', async () => {
        const alice = await makeInitAndStartClient()
        const bob = await makeInitAndStartClient()
        const charlie = await makeInitAndStartClient()
        const chuck = await makeInitAndStartClient()
        const { streamId } = await alice.createGDMChannel([bob.userId, charlie.userId])

        const ephemeralSolicitations: boolean[] = []
        alice.on('newKeySolicitation', (_, __, ___, ____, _____, ephemeral) => {
            ephemeralSolicitations.push(ephemeral ?? false)
        })

        const ephemeralFulfillments: string[] = []
        alice.on('ephemeralKeyFulfillment', (event) => {
            ephemeralFulfillments.push(event.senderUserId)
        })

        await waitFor(() => {
            return alice.streams.get(streamId)?.view.membershipContent.joined.size === 3
        })

        await alice.sendMessage(streamId, 'hello')
        await alice.inviteUser(streamId, chuck.userId)

        const stream = await chuck.waitForStream(streamId)
        await stream.waitForMembership(MembershipOp.SO_INVITE)
        const chuckEventDecryptedPromise = createEventDecryptedPromise(chuck, 'hello')
        await expect(chuck.joinStream(streamId)).resolves.not.toThrow()
        await expect(chuckEventDecryptedPromise).resolves.not.toThrow()

        expect(ephemeralSolicitations).toEqual([true])

        // Wait for at least one ephemeral fulfillment
        await waitFor(() => expect(ephemeralFulfillments.length).toBeGreaterThanOrEqual(1))

        // Verify all fulfillments are from different clients
        const uniqueSenders = new Set(ephemeralFulfillments)
        expect(uniqueSenders.size).toEqual(ephemeralFulfillments.length)
    })

    test('ephemeral channel messages are received but not in timeline', async () => {
        const alice = await makeInitAndStartClient()
        const bob = await makeInitAndStartClient()
        const { streamId } = await alice.createGDMChannel([bob.userId])

        await bob.waitForStream(streamId, { timeoutMs: 10000 })

        // Wait for both to be synced
        await waitFor(() => {
            return (
                alice.streams.get(streamId)?.view.membershipContent.joined.size === 2 &&
                bob.streams.get(streamId)?.view.membershipContent.joined.size === 2
            )
        })

        // Send a regular message first so encryption sessions are established
        const decryptedPromise = createEventDecryptedPromise(bob, 'hello')
        await alice.sendMessage(streamId, 'hello')
        await decryptedPromise

        // Now listen for ephemeral events on bob
        const ephemeralReceived = makeDonePromise()
        bob.on('ephemeralEvent', (_streamId, event) => {
            ephemeralReceived.runAndDone(() => {
                expect(_streamId).toEqual(streamId)
                expect(event.creatorUserId).toEqual(alice.userId)
                expect(event.content).toBeDefined()
                expect(event.content?.kind).toEqual('channelMessage')
                if (event.content?.kind === 'channelMessage') {
                    const post = event.content.content.payload
                    expect(post.case).toEqual('post')
                    if (post.case === 'post') {
                        expect(post.value.content.case).toEqual('text')
                        if (post.value.content.case === 'text') {
                            expect(post.value.content.value.body).toEqual('typing preview...')
                        }
                    }
                }
            })
        })

        // Send ephemeral message
        await alice.sendMessage(streamId, 'typing preview...', [], [], { ephemeral: true })
        await ephemeralReceived.promise

        // Verify the ephemeral message is NOT in bob's timeline
        const bobTimeline = bob.streams.get(streamId)?.view.timeline ?? []
        const hasEphemeral = bobTimeline.some((e) => {
            return (
                e.content?.kind === RiverTimelineEvent.ChannelMessage &&
                e.content.body === 'typing preview...'
            )
        })
        expect(hasEphemeral).toBe(false)
    })

    test('ephemeral messages are received by all participants', async () => {
        const alice = await makeInitAndStartClient()
        const bob = await makeInitAndStartClient()
        const charlie = await makeInitAndStartClient()
        const { streamId } = await alice.createGDMChannel([bob.userId, charlie.userId])

        await bob.waitForStream(streamId, { timeoutMs: 10000 })
        await charlie.waitForStream(streamId, { timeoutMs: 10000 })

        await waitFor(() => {
            return (
                alice.streams.get(streamId)?.view.membershipContent.joined.size === 3 &&
                bob.streams.get(streamId)?.view.membershipContent.joined.size === 3 &&
                charlie.streams.get(streamId)?.view.membershipContent.joined.size === 3
            )
        })

        // Establish encryption sessions
        const bobSetup = createEventDecryptedPromise(bob, 'setup')
        const charlieSetup = createEventDecryptedPromise(charlie, 'setup')
        await alice.sendMessage(streamId, 'setup')
        await bobSetup
        await charlieSetup

        const bobReceived = makeDonePromise()
        const charlieReceived = makeDonePromise()

        bob.on('ephemeralEvent', (_streamId, event) => {
            bobReceived.runAndDone(() => {
                expect(event.creatorUserId).toEqual(alice.userId)
            })
        })

        charlie.on('ephemeralEvent', (_streamId, event) => {
            charlieReceived.runAndDone(() => {
                expect(event.creatorUserId).toEqual(alice.userId)
            })
        })

        await alice.sendMessage(streamId, 'typing...', [], [], { ephemeral: true })
        await bobReceived.promise
        await charlieReceived.promise
    })

    test('regular message still works after ephemeral', async () => {
        const alice = await makeInitAndStartClient()
        const bob = await makeInitAndStartClient()
        const { streamId } = await alice.createGDMChannel([bob.userId])

        await bob.waitForStream(streamId, { timeoutMs: 10000 })
        await waitFor(() => {
            return (
                alice.streams.get(streamId)?.view.membershipContent.joined.size === 2 &&
                bob.streams.get(streamId)?.view.membershipContent.joined.size === 2
            )
        })

        // Establish encryption sessions
        const setupPromise = createEventDecryptedPromise(bob, 'setup')
        await alice.sendMessage(streamId, 'setup')
        await setupPromise

        // Send ephemeral
        const ephemeralReceived = makeDonePromise()
        bob.on('ephemeralEvent', () => {
            ephemeralReceived.done()
        })
        await alice.sendMessage(streamId, 'thinking...', [], [], { ephemeral: true })
        await ephemeralReceived.promise

        // Send regular message after
        const regularDecrypted = createEventDecryptedPromise(bob, 'actual response')
        await alice.sendMessage(streamId, 'actual response')
        await regularDecrypted

        // Timeline should have 'setup' and 'actual response', but NOT 'thinking...'
        const bobTimeline = bob.streams.get(streamId)?.view.timeline ?? []
        const bodies = bobTimeline
            .filter((e) => e.content?.kind === RiverTimelineEvent.ChannelMessage)
            .map((e) =>
                e.content?.kind === RiverTimelineEvent.ChannelMessage ? e.content.body : '',
            )

        expect(bodies).toContain('setup')
        expect(bodies).toContain('actual response')
        expect(bodies).not.toContain('thinking...')
    })
})
