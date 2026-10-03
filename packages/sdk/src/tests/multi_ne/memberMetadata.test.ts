import { Client } from '../../client'
import { makeDonePromise, makeTestClient } from '../testUtils'

describe('memberMetadataTests', () => {
    let bobsClient: Client
    let alicesClient: Client

    beforeEach(async () => {
        bobsClient = await makeTestClient()
        alicesClient = await makeTestClient()
        await Promise.all([bobsClient.initializeUser(), alicesClient.initializeUser()])
    })

    afterEach(async () => {
        await bobsClient.stop()
        await alicesClient.stop()
    })

    test('clientDoesntHaveAppAddress', async () => {
        const { streamId } = await bobsClient.createGDMChannel([
            bobsClient.userId,
            alicesClient.userId,
        ])
        await bobsClient.waitForStream(streamId)
        const streamView = bobsClient.streams.get(streamId)!.view
        expect(streamView.getMemberMetadata().userInfo(bobsClient.userId).appAddress).toEqual(
            undefined,
        )
    })

    test('clientCanSetStreamEncryptionAlgorithm', async () => {
        bobsClient.startSync()
        const { streamId } = await bobsClient.createGDMChannel([
            bobsClient.userId,
            alicesClient.userId,
        ])
        await bobsClient.waitForStream(streamId)

        // initial value is "undefined"
        expect(bobsClient.stream(streamId)?.view.membershipContent.encryptionAlgorithm).toBe(
            undefined,
        )

        const newAlgorithm = 'mega_v1'
        const truePromise = makeDonePromise()
        bobsClient.once('streamEncryptionAlgorithmUpdated', (updatedStreamId, value) => {
            expect(updatedStreamId).toBe(streamId)
            expect(value).toBe(newAlgorithm)
            truePromise.done()
        })

        await expect(
            bobsClient.setStreamEncryptionAlgorithm(streamId, newAlgorithm),
        ).resolves.not.toThrow()
        await truePromise.expectToSucceed()
        expect(bobsClient.stream(streamId)?.view.membershipContent.encryptionAlgorithm).toBe(
            newAlgorithm,
        )

        // toggle back to to undefined
        const falsePromise = makeDonePromise()
        bobsClient.once('streamEncryptionAlgorithmUpdated', (updatedStreamId, value) => {
            expect(updatedStreamId).toBe(streamId)
            expect(value).toBe(undefined)
            falsePromise.done()
        })

        await expect(
            bobsClient.setStreamEncryptionAlgorithm(streamId, undefined),
        ).resolves.not.toThrow()
        await falsePromise.expectToSucceed()
        expect(bobsClient.stream(streamId)?.view.membershipContent.encryptionAlgorithm).toBe(
            undefined,
        )
    })
})
