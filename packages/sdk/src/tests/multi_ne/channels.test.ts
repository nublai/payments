/**
 * @group main
 */

import { getTimelineMessagePayload, makeTestClient, waitFor } from '../testUtils'
import { Client } from '../../client'
import { RiverTimelineEvent } from '../../views/models/timelineTypes'

describe('channelsTests', () => {
    let bobsClient: Client
    let alicesClient: Client

    beforeEach(async () => {
        bobsClient = await makeTestClient()
        await bobsClient.initializeUser()
        bobsClient.startSync()

        alicesClient = await makeTestClient()
        await alicesClient.initializeUser()
        alicesClient.startSync()
    })

    afterEach(async () => {
        await bobsClient.stop()
        await alicesClient.stop()
    })

    test('clientsCanSendRedactionEvents', async () => {
        const { streamId } = await bobsClient.createGDMChannel([alicesClient.userId])

        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(bobsClient.sendMessage(streamId, 'Very bad message!')).resolves.not.toThrow()

        const channelStream = await bobsClient.waitForStream(streamId)
        let eventId: string | undefined
        await waitFor(() => {
            const event = channelStream.view.timeline.find(
                (e) => getTimelineMessagePayload(e) === 'Very bad message!',
            )
            expect(event).toBeDefined()
            eventId = event?.eventId
        })

        expect(channelStream).toBeDefined()
        expect(eventId).toBeDefined()

        await expect(bobsClient.redactMessage(streamId, eventId!)).resolves.not.toThrow()
        await waitFor(() => {
            const event = channelStream.view.timeline.find(
                (e) =>
                    e.content?.kind === RiverTimelineEvent.RedactionActionEvent &&
                    e.content.refEventId === eventId!,
            )
            expect(event).toBeDefined()
        })
    })
})
