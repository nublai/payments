/**
 * @group main
 */

import { makeEvent, makeEvents } from '../../sign'
import { MembershipOp } from '@towns-labs/proto'
import { bin_equal, dlog } from '@towns-labs/utils'
import {
    makeEvent_test,
    makeRandomUserContext,
    makeUserContextFromWallet,
    makeTestRpcClient,
    TEST_ENCRYPTED_MESSAGE_PROPS,
} from '../testUtils'
import {
    makeUniqueGDMChannelStreamId,
    makeUserStreamId,
    streamIdToBytes,
    userIdFromAddress,
} from '../../id'
import {
    make_GDMChannelPayload_Inception,
    make_GDMChannelPayload_Message,
    make_MemberPayload_Membership2,
    make_UserPayload_Inception,
    make_UserPayload_UserMembership,
} from '../../types'
import { bobTalksToHimself } from '../bob_testUtils'
import { ethers } from 'ethers'
import { SignerContext, makeSignerContext } from '../../signerContext'

const log = dlog('csb:test:streamRpcClient')

describe('streamRpcClient', () => {
    let bobsContext: SignerContext

    beforeEach(async () => {
        bobsContext = await makeRandomUserContext()
    })

    test('makeStreamRpcClient', async () => {
        const client = await makeTestRpcClient()
        expect(client).toBeDefined()
        const result = await client.info({ debug: ['graffiti'] })
        expect(result).toBeDefined()
        expect(result.graffiti).toEqual('River Node welcomes you!')
    })

    test('ping', async () => {
        const client = await makeTestRpcClient()
        const result = await client.info({ debug: ['ping'] })
        expect(result).toBeDefined()
        expect(result.graffiti).toEqual('pong')
    })

    test('error', async () => {
        const client = await makeTestRpcClient()
        await expect(client.info({ debug: ['error'] })).rejects.toThrow(
            'Error requested through Info request',
        )
    })

    test('error_untyped', async () => {
        const client = await makeTestRpcClient()
        await expect(client.info({ debug: ['error_untyped'] })).rejects.toThrow(
            '[unknown] error requested through Info request',
        )
    })

    test('charlieUsesRegularOldWallet', async () => {
        const wallet = ethers.Wallet.createRandom()
        const charliesContext = await makeUserContextFromWallet(wallet)

        const charlie = await makeTestRpcClient()
        const userId = userIdFromAddress(charliesContext.creatorAddress)
        const streamId = streamIdToBytes(makeUserStreamId(userId))
        await charlie.createStream({
            events: [
                await makeEvent(
                    charliesContext,
                    make_UserPayload_Inception({
                        streamId,
                    }),
                ),
            ],
            streamId,
        })
    })

    test('bobSendsMismatchedPayloadCase', async () => {
        const bob = await makeTestRpcClient()
        const bobsUserId = userIdFromAddress(bobsContext.creatorAddress)
        const bobsUserStreamId = streamIdToBytes(makeUserStreamId(bobsUserId))
        const inceptionEvent = await makeEvent(
            bobsContext,
            make_UserPayload_Inception({
                streamId: bobsUserStreamId,
            }),
        )
        await bob.createStream({
            events: [inceptionEvent],
            streamId: bobsUserStreamId,
        })
        const userStream = await bob.getStream({ streamId: bobsUserStreamId })
        expect(userStream).toBeDefined()
        expect(
            bin_equal(userStream.stream?.nextSyncCookie?.streamId, bobsUserStreamId),
        ).toBeTruthy()

        const event = await makeEvent(
            bobsContext,
            make_GDMChannelPayload_Message({
                ...TEST_ENCRYPTED_MESSAGE_PROPS,
                ciphertext: 'hello',
            }),
            userStream.stream?.miniblocks.at(-1)?.header?.hash,
        )
        const promise = bob.addEvent({
            streamId: bobsUserStreamId,
            event,
        })

        await expect(promise).rejects.toThrow('inception type mismatch')
    })

    test.each([
        ['bobTalksToHimself-noflush-nopresync', false],
        ['bobTalksToHimself-noflush-presync', true],
    ])('%s', async (name: string, presync: boolean) => {
        await bobTalksToHimself(log.extend(name), bobsContext, false, presync)
    })

    test.each([
        [0n, 'never'],
        [{ days: 2 }, 'in two days'],
    ])(
        'cantAddOrCreateWithExpiredDelegateSig expiry: %o expires %s',
        async (goodExpiry, _expiresDescription: string) => {
            const jimmy = await makeTestRpcClient()

            const jimmysWallet = ethers.Wallet.createRandom()
            const jimmysDelegateWallet = ethers.Wallet.createRandom()

            const jimmysGoodContext = await makeSignerContext(
                jimmysWallet,
                jimmysDelegateWallet,
                goodExpiry,
            )
            const jimmysExpiredContext = await makeSignerContext(
                jimmysWallet,
                jimmysDelegateWallet,
                {
                    days: -2,
                },
            )

            const jimmysUserId = userIdFromAddress(jimmysGoodContext.creatorAddress)
            const jimmysUserStreamId = streamIdToBytes(makeUserStreamId(jimmysUserId))

            const makeUserStreamWith = async (context: SignerContext) => {
                return jimmy.createStream({
                    events: [
                        await makeEvent(
                            context,
                            make_UserPayload_Inception({
                                streamId: jimmysUserStreamId,
                            }),
                        ),
                    ],
                    streamId: jimmysUserStreamId,
                })
            }

            await expect(makeUserStreamWith(jimmysExpiredContext)).rejects.toThrow(
                expect.objectContaining({
                    message: expect.stringContaining('7:PERMISSION_DENIED'),
                }),
            )
            await expect(makeUserStreamWith(jimmysGoodContext)).resolves.not.toThrow()

            const gdmId = streamIdToBytes(makeUniqueGDMChannelStreamId())
            const gdmEvents = await makeEvents(jimmysGoodContext, [
                make_GDMChannelPayload_Inception({
                    streamId: gdmId,
                }),
                make_MemberPayload_Membership2({
                    userId: jimmysUserId,
                    op: MembershipOp.SO_JOIN,
                    initiatorId: jimmysUserId,
                }),
            ])
            await jimmy.createStream({
                events: gdmEvents,
                streamId: gdmId,
            })

            const addEventWith = async (context: SignerContext) => {
                const lastMiniblockHash = (
                    await jimmy.getLastMiniblockHash({ streamId: jimmysUserStreamId })
                ).hash
                const membershipEvent = await makeEvent(
                    context,
                    make_UserPayload_UserMembership({
                        streamId: gdmId,
                        op: MembershipOp.SO_LEAVE,
                    }),
                    lastMiniblockHash,
                )
                return jimmy.addEvent({
                    streamId: jimmysUserStreamId,
                    event: membershipEvent,
                })
            }

            await expect(addEventWith(jimmysExpiredContext)).rejects.toThrow(
                expect.objectContaining({
                    message: expect.stringContaining('7:PERMISSION_DENIED'),
                }),
            )
            await expect(addEventWith(jimmysGoodContext)).resolves.not.toThrow()
        },
    )

    test('cantAddWithBadHash', async () => {
        const bob = await makeTestRpcClient()
        const bobsUserId = userIdFromAddress(bobsContext.creatorAddress)
        const bobsUserStreamId = streamIdToBytes(makeUserStreamId(bobsUserId))

        await expect(
            bob.createStream({
                events: [
                    await makeEvent(
                        bobsContext,
                        make_UserPayload_Inception({
                            streamId: bobsUserStreamId,
                        }),
                    ),
                ],
                streamId: bobsUserStreamId,
            }),
        ).resolves.not.toThrow()

        const gdmId = streamIdToBytes(makeUniqueGDMChannelStreamId())
        const gdmEvents = await makeEvents(bobsContext, [
            make_GDMChannelPayload_Inception({
                streamId: gdmId,
            }),
            make_MemberPayload_Membership2({
                userId: bobsUserId,
                op: MembershipOp.SO_JOIN,
                initiatorId: bobsUserId,
            }),
        ])
        await bob.createStream({
            events: gdmEvents,
            streamId: gdmId,
        })

        const gdmId2 = streamIdToBytes(makeUniqueGDMChannelStreamId())
        const gdmEvent2_0 = await makeEvent(
            bobsContext,
            make_GDMChannelPayload_Inception({
                streamId: gdmId2,
            }),
        )

        const gdmEvent2_1 = await makeEvent(
            bobsContext,
            make_MemberPayload_Membership2({
                userId: bobsUserId,
                op: MembershipOp.SO_JOIN,
                initiatorId: bobsUserId,
            }),
            Uint8Array.from(Array(32).fill(1)),
        )

        await expect(
            bob.createStream({
                events: [gdmEvent2_0, gdmEvent2_1],
                streamId: gdmId2,
            }),
        ).rejects.toThrow(
            expect.objectContaining({
                message: expect.stringContaining('19:BAD_STREAM_CREATION_PARAMS'),
            }),
        )

        const lastMiniblockHash = (await bob.getLastMiniblockHash({ streamId: gdmId })).hash
        const messageEvent = await makeEvent(
            bobsContext,
            make_GDMChannelPayload_Message({
                ...TEST_ENCRYPTED_MESSAGE_PROPS,
                ciphertext: 'Hello, World!',
            }),
            lastMiniblockHash,
        )
        await expect(
            bob.addEvent({
                streamId: gdmId,
                event: messageEvent,
            }),
        ).resolves.not.toThrow()

        await expect(
            bob.addEvent({
                streamId: gdmId,
                event: await makeEvent_test(
                    bobsContext,
                    make_GDMChannelPayload_Message({
                        ...TEST_ENCRYPTED_MESSAGE_PROPS,
                        ciphertext: 'Hello, World!',
                    }),
                ),
            }),
        ).rejects.toThrow(
            expect.objectContaining({
                message: expect.stringContaining('3:INVALID_ARGUMENT'),
            }),
        )
    })

    test('cantAddWithBadSignature', async () => {
        const bob = await makeTestRpcClient()
        const bobsUserId = userIdFromAddress(bobsContext.creatorAddress)
        const bobsUserStreamId = streamIdToBytes(makeUserStreamId(bobsUserId))

        await expect(
            bob.createStream({
                events: [
                    await makeEvent(
                        bobsContext,
                        make_UserPayload_Inception({
                            streamId: bobsUserStreamId,
                        }),
                    ),
                ],
                streamId: bobsUserStreamId,
            }),
        ).resolves.not.toThrow()

        const gdmId = streamIdToBytes(makeUniqueGDMChannelStreamId())
        const gdmEvents = await makeEvents(bobsContext, [
            make_GDMChannelPayload_Inception({
                streamId: gdmId,
            }),
            make_MemberPayload_Membership2({
                userId: bobsUserId,
                op: MembershipOp.SO_JOIN,
                initiatorId: bobsUserId,
            }),
        ])
        await bob.createStream({
            events: gdmEvents,
            streamId: gdmId,
        })

        const lastMiniblockHash = (await bob.getLastMiniblockHash({ streamId: gdmId })).hash
        const messageEvent = await makeEvent(
            bobsContext,
            make_GDMChannelPayload_Message({
                ...TEST_ENCRYPTED_MESSAGE_PROPS,
                ciphertext: 'Hello, World!',
            }),
            lastMiniblockHash,
        )
        await expect(
            bob.addEvent({
                streamId: gdmId,
                event: messageEvent,
            }),
        ).resolves.not.toThrow()

        await expect(
            bob.addEvent({
                streamId: gdmId,
                event: messageEvent,
            }),
        ).resolves.not.toThrow()

        const badEvent = await makeEvent(
            bobsContext,
            make_GDMChannelPayload_Message({
                ...TEST_ENCRYPTED_MESSAGE_PROPS,
                ciphertext: 'Nah, not really',
            }),
            lastMiniblockHash,
        )
        badEvent.signature = messageEvent.signature
        await expect(
            bob.addEvent({
                streamId: gdmId,
                event: badEvent,
            }),
        ).rejects.toThrow('22:BAD_EVENT_SIGNATURE')

        const expiredEvent = await makeEvent(
            bobsContext,
            make_GDMChannelPayload_Message({
                ...TEST_ENCRYPTED_MESSAGE_PROPS,
                ciphertext: 'Nah, not really',
            }),
            Uint8Array.from(Array(32).fill(1)),
        )
        await expect(
            bob.addEvent({
                streamId: gdmId,
                event: expiredEvent,
            }),
        ).rejects.toThrow('24:BAD_PREV_MINIBLOCK_HASH')
    })
})
