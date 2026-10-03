/**
 * @group main
 */

import { Client } from '../../client'
import { dlog } from '@towns-labs/utils'
import { isDefined } from '../../check'
import { TestClientOpts, makeTestClient, waitFor } from '../testUtils'
import { Stream } from '../../stream'
import { SyncState } from '../../syncedStreamsLoop'
import { RiverTimelineEvent } from '../../views/models/timelineTypes'

const log = dlog('csb:test:decryptionExtensions')

describe('ClientDecryptionExtensions', () => {
    let clients: Client[] = []
    const makeAndStartClient = async (opts?: TestClientOpts) => {
        const client = await makeTestClient(opts)
        await client.initializeUser()
        client.startSync()
        await waitFor(() => expect(client.streams.syncState).toBe(SyncState.Syncing))
        log('started client', client.userId, client.signerContext)
        clients.push(client)
        return client
    }

    const sendMessage = async (client: Client, streamId: string, body: string) => {
        await client.waitForStream(streamId)
        return await client.sendMessage(streamId, body)
    }

    const getDecryptedChannelMessages = (stream: Stream): string[] => {
        return stream.view.timeline
            .map((e) => {
                // for tests, return decrypted content
                if (e.content?.kind === RiverTimelineEvent.ChannelMessage) {
                    return e.content.body
                }
                return undefined
            })
            .filter(isDefined)
    }

    const waitForMessages = async (client: Client, streamId: string, bodys: string[]) => {
        log('waitForMessages:', client.userId, client.logId, streamId, bodys)
        const stream = await client.waitForStream(streamId)
        log('waitForMessages stream:', client.userId, client.logId, streamId, stream.view.timeline)

        return waitFor(
            () => {
                const messages = getDecryptedChannelMessages(stream)
                expect(messages, `messages for ${client.logId}`).toEqual(bodys)
            },
            { timeoutMS: 15000 },
        )
    }

    beforeEach(async () => {})
    afterEach(async () => {
        for (const client of clients) {
            await client.stop()
        }
        clients = []
    })

    test('shareKeysWithNewDevices', async () => {
        const bob1 = await makeAndStartClient({ deviceId: 'bob1' })
        const alice1 = await makeAndStartClient({ deviceId: 'alice1' })

        const { streamId } = await bob1.createGDMChannel([alice1.userId])
        await sendMessage(bob1, streamId, 'hello')
        await expect(alice1.waitForStream(streamId)).resolves.not.toThrow()

        // wait for the message to arrive and decrypt
        await expect(waitForMessages(alice1, streamId, ['hello'])).resolves.not.toThrow()

        // boot up alice on a second device
        const alice2 = await makeAndStartClient({
            context: alice1.signerContext,
            deviceId: 'alice2',
        })

        // This wait takes over 5s
        await expect(alice2.waitForStream(streamId)).resolves.not.toThrow()

        // alice gets keys sent via new device message
        await expect(waitForMessages(alice2, streamId, ['hello'])).resolves.not.toThrow()

        // stop alice2 so she's offline
        await alice2.stop()

        // send a second message
        const bob2 = await makeAndStartClient({
            context: bob1.signerContext,
            deviceId: 'bob2',
        })

        await expect(bob2.waitForStream(streamId)).resolves.not.toThrow()

        await sendMessage(bob2, streamId, 'whats up')

        // the message should get decrypted on alice1
        await expect(waitForMessages(bob1, streamId, ['hello', 'whats up'])).resolves.not.toThrow()
        await expect(
            waitForMessages(alice1, streamId, ['hello', 'whats up']),
        ).resolves.not.toThrow()

        // start alice2 back up
        const alice2_restarted = await makeAndStartClient({
            context: alice1.signerContext,
            deviceId: 'alice2',
        })

        // she should have the keys because bob2 should share with existing members
        await expect(
            waitForMessages(alice2_restarted, streamId, ['hello', 'whats up']),
        ).resolves.not.toThrow()
    })

    // users aren't online at the same time
    test('bobIsntOnlineToShareKeys', async () => {
        // have two people come up, go offline, then two more people come up
        const bob1 = await makeAndStartClient({ deviceId: 'bob1' })
        const alice1 = await makeAndStartClient({ deviceId: 'alice1' })
        const { streamId: channelId } = await bob1.createGDMChannel([alice1.userId])
        await sendMessage(bob1, channelId, 'its bob')
        await bob1.stop()

        await expect(waitForMessages(alice1, channelId, ['its bob'])).resolves.not.toThrow()
        await sendMessage(alice1, channelId, 'its alice')
        await expect(
            waitForMessages(alice1, channelId, ['its bob', 'its alice']),
        ).resolves.not.toThrow()

        // bob comes back online, same device
        const bob1IsBack = await makeAndStartClient({
            context: bob1.signerContext,
            deviceId: 'bob1',
        })
        await expect(
            waitForMessages(bob1IsBack, channelId, ['its bob', 'its alice']),
        ).resolves.not.toThrow()

        await expect(
            waitForMessages(alice1, channelId, ['its bob', 'its alice']),
        ).resolves.not.toThrow()
    })

    test('shareKeysInMultipleStreamsToSameDevice', async () => {
        const bob1 = await makeAndStartClient({ deviceId: 'bob1' })
        const alice1 = await makeAndStartClient({ deviceId: 'alice1' })

        const { streamId: channel1StreamId } = await bob1.createGDMChannel([alice1.userId])
        const { streamId: channel2StreamId } = await bob1.createGDMChannel([alice1.userId])
        const event1 = await sendMessage(bob1, channel1StreamId, 'hello channel 1')
        log('hello channel 1 eventId', event1.eventId)
        const event2 = await sendMessage(bob1, channel2StreamId, 'hello channel 2')
        log('hello channel 2 eventId', event2.eventId)

        await expect(alice1.joinStream(channel1StreamId)).resolves.not.toThrow()
        await expect(alice1.joinStream(channel2StreamId)).resolves.not.toThrow()

        // wait for the message to arrive and decrypt
        await expect(
            waitForMessages(alice1, channel1StreamId, ['hello channel 1']),
            `waiting for ${event1.eventId}`,
        ).resolves.not.toThrow()
        await expect(
            waitForMessages(alice1, channel2StreamId, ['hello channel 2']),
            `waiting for ${event2.eventId}`,
        ).resolves.not.toThrow()

        // stop bob to simplify test
        await bob1.stop()

        // boot up alice on a second device
        const alice2 = await makeAndStartClient({
            context: alice1.signerContext,
            deviceId: 'alice2',
        })

        // This wait takes over 5s, we should address
        await expect(alice2.waitForStream(channel1StreamId)).resolves.not.toThrow()
        await expect(alice2.waitForStream(channel2StreamId)).resolves.not.toThrow()

        // alice gets keys sent via new device message
        await expect(
            waitForMessages(alice2, channel1StreamId, ['hello channel 1']),
        ).resolves.not.toThrow()
        await expect(
            waitForMessages(alice2, channel2StreamId, ['hello channel 2']),
        ).resolves.not.toThrow()
    })
})
