/**
 * @group main
 */

import { makeTestClient, waitFor } from '../testUtils'
import { Client } from '../../client'
import { makeUniqueGDMChannelStreamId, streamIdAsString } from '../../id'
import { CreationCookie, CreationCookieSchema, InfoRequestSchema } from '@towns-labs/proto'
import { deriveKeyAndIV, encryptAESGCM } from '@towns-labs/sdk-crypto'
import { create } from '@bufbuild/protobuf'

describe('mediaTests', () => {
    let bobsClient: Client
    let inviteeClient: Client

    beforeEach(async () => {
        bobsClient = await makeTestClient()
        inviteeClient = await makeTestClient()
        await bobsClient.initializeUser()
        await inviteeClient.initializeUser()
        bobsClient.startSync()
        inviteeClient.startSync()
    })

    afterEach(async () => {
        await inviteeClient.stop()
        await bobsClient.stop()
    })

    async function bobCreateMediaStream(
        chunkCount: number,
        firstChunk?: Uint8Array,
        iv?: Uint8Array,
    ): Promise<{ creationCookie: CreationCookie; channelId: string }> {
        const { streamId: channelId } = await bobsClient.createGDMChannel([inviteeClient.userId])

        const result = await bobsClient.createMediaStream(
            channelId,
            undefined,
            undefined,
            chunkCount,
            firstChunk ?? new Uint8Array(100),
            iv,
        )
        return { ...result, channelId }
    }

    async function bobSendMediaPayloads(
        creationCookie: CreationCookie,
        chunks: number,
    ): Promise<CreationCookie> {
        let cc: CreationCookie = create(CreationCookieSchema, creationCookie)
        for (let i = 1; i < chunks; i++) {
            const chunk = new Uint8Array(100)
            // Create novel chunk content for testing purposes
            chunk.fill(i, 0, 100)
            const last = i == chunks - 1
            const result = await bobsClient.sendMediaPayload(cc, last, chunk, i)
            cc = create(CreationCookieSchema, {
                ...cc,
                prevMiniblockHash: new Uint8Array(result.creationCookie.prevMiniblockHash),
                miniblockNum: result.creationCookie.miniblockNum,
            })
        }
        return cc
    }

    async function bobSendEncryptedMediaPayload(
        creationCookie: CreationCookie,
        last: boolean,
        chunkIndex: number,
        data: Uint8Array,
    ): Promise<CreationCookie> {
        const result = await bobsClient.sendMediaPayload(creationCookie, last, data, chunkIndex)
        return result.creationCookie
    }

    function createTestMediaChunks(chunks: number): Uint8Array {
        const data: Uint8Array = new Uint8Array(10 * chunks)
        for (let i = 0; i < chunks; i++) {
            const start = i * 10
            const end = start + 10
            data.fill(i, start, end)
        }
        return data
    }

    test('clientCanCreateMediaStream', async () => {
        await expect(bobCreateMediaStream(5)).resolves.not.toThrow()
    })

    test('clientCanSendMediaPayload', async () => {
        const mediaStreamInfo = await bobCreateMediaStream(5)
        await bobSendMediaPayloads(mediaStreamInfo.creationCookie, 5)
    })

    test('clientCanSendEncryptedDerivedAesGmPayload', async () => {
        const data = createTestMediaChunks(2)
        const mediaStreamInfo = await bobCreateMediaStream(3)
        await expect(
            bobSendEncryptedMediaPayload(mediaStreamInfo.creationCookie, false, 1, data),
        ).resolves.not.toThrow()
    })

    test('clientCanSendEncryptedDerivedAesGmPayloadInCreationRequest', async () => {
        const data = createTestMediaChunks(2)
        await expect(bobCreateMediaStream(3, data)).resolves.not.toThrow()
    })

    test('clientCanDownloadEncryptedDerivedAesGmPayload', async () => {
        const channelId = makeUniqueGDMChannelStreamId()
        const { iv, key } = await deriveKeyAndIV(channelId)
        const data = createTestMediaChunks(2)
        const encryptedData = await encryptAESGCM(data, key, iv)
        const mediaStreamInfo = await bobCreateMediaStream(
            2,
            encryptedData.ciphertext.subarray(0, encryptedData.ciphertext.length / 2),
        )
        const creationCookie = await bobSendEncryptedMediaPayload(
            mediaStreamInfo.creationCookie,
            true,
            1,
            encryptedData.ciphertext.subarray(encryptedData.ciphertext.length / 2),
        )
        await waitFor(async () => {
            const decryptedChunks = await bobsClient.getMediaPayload(
                streamIdAsString(creationCookie.streamId),
                key,
                iv,
            )
            expect(decryptedChunks).toEqual(data)
        })
    })

    test('chunkIndexNeedsToBeWithinBounds', async () => {
        const result = await bobCreateMediaStream(5)
        const chunk = new Uint8Array(100)
        await expect(
            bobsClient.sendMediaPayload(result.creationCookie, false, chunk, -1),
        ).rejects.toThrow()
        await expect(
            bobsClient.sendMediaPayload(result.creationCookie, false, chunk, 6),
        ).rejects.toThrow()
    })

    test('chunkSizeCanBeAtLimit', async () => {
        const result = await bobCreateMediaStream(5)
        const chunk = new Uint8Array(1200000)
        await expect(
            bobsClient.sendMediaPayload(result.creationCookie, false, chunk, 0),
        ).resolves.not.toThrow()
    })

    test('chunkSizeNeedsToBeWithinLimit', async () => {
        const result = await bobCreateMediaStream(5)
        const chunk = new Uint8Array(1200001)
        await expect(
            bobsClient.sendMediaPayload(result.creationCookie, false, chunk, 0),
        ).rejects.toThrow()
    })

    test('chunkCountNeedsToBeWithinLimit', async () => {
        await expect(bobCreateMediaStream(6)).rejects.toThrow()
    })

    test('clientCanOnlyPostToTheirOwnMediaStream', async () => {
        const result = await bobCreateMediaStream(5)
        const chunk = new Uint8Array(100)

        const alicesClient = await makeTestClient()
        await alicesClient.initializeUser()
        alicesClient.startSync()

        await expect(
            alicesClient.sendMediaPayload(result.creationCookie, false, chunk, 5),
        ).rejects.toThrow()
        await alicesClient.stop()
    })

    test('clientCanOnlyPostToTheirOwnPublicMediaStream', async () => {
        const result = await bobCreateMediaStream(5)
        const chunk = new Uint8Array(100)

        const alicesClient = await makeTestClient()
        await alicesClient.initializeUser()
        alicesClient.startSync()

        await expect(
            alicesClient.sendMediaPayload(result.creationCookie, false, chunk, 5),
        ).rejects.toThrow()
        await alicesClient.stop()
    })

    test('channelNeedsToExistBeforeCreatingMediaStream', async () => {
        const nonExistentChannelId = makeUniqueGDMChannelStreamId()
        await expect(
            bobsClient.createMediaStream(nonExistentChannelId, undefined, undefined, 5),
        ).rejects.toThrow()
    })

    test('userCanUploadMediaToGdmIfMember', async () => {
        const alicesClient = await makeTestClient()
        await alicesClient.initializeUser()
        alicesClient.startSync()

        const charliesClient = await makeTestClient()
        await charliesClient.initializeUser()
        charliesClient.startSync()

        const { streamId } = await bobsClient.createGDMChannel([
            alicesClient.userId,
            charliesClient.userId,
        ])
        await expect(
            bobsClient.createMediaStream(streamId, undefined, undefined, 5),
        ).resolves.not.toThrow()
        await alicesClient.stop()
        await charliesClient.stop()
    })

    // This test is flaky because there is a bug in GetStreamEx where sometimes the miniblock is not
    // finalized before the client tries to fetch it. This is a known issue, see HNT-5291.
    test.skip('mediaStreamGetStreamEx', async () => {
        const { creationCookie } = await bobCreateMediaStream(5)
        const streamId = streamIdAsString(creationCookie.streamId)
        // Send a series of media chunks
        await bobSendMediaPayloads(creationCookie, 5)
        // Force server to flush minipool events into a block
        await bobsClient.rpcClient.info(
            create(InfoRequestSchema, {
                debug: ['make_miniblock', streamId],
            }),
            { timeoutMs: 10000 },
        )

        // Grab stream from both endpoints
        const stream = await bobsClient.getStream(streamId)
        const streamEx = await bobsClient.getStreamEx(streamId)

        // Assert exact content equality with bobSendMediaPayloads
        expect(streamEx.mediaContent.info).toBeDefined()
        expect(streamEx.mediaContent.info?.chunks.length).toEqual(5)
        for (let i = 0; i < 5; i++) {
            const chunk = new Uint8Array(100)
            chunk.fill(i, 0, 100)
            expect(streamEx.mediaContent.info?.chunks[i]).toBeDefined()
            expect(streamEx.mediaContent.info?.chunks[i]).toEqual(chunk)
        }

        // Assert equality of mediaContent between getStream and getStreamEx
        // use-chunked-media.ts utilizes the tream.mediaContent.info property, so equality here
        // will result in the same behavior in the client app.
        expect(stream.mediaContent).toEqual(streamEx.mediaContent)
    })

    test('userMediaStream', async () => {
        const alicesClient = await makeTestClient()
        await alicesClient.initializeUser()
        alicesClient.startSync()
        await expect(
            alicesClient.createMediaStream(undefined, undefined, alicesClient.userId, 5),
        ).resolves.not.toThrow()
    })
})
