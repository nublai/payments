/**
 * @group main
 */

import { makeTestClient, createEventDecryptedPromise, waitFor, makeDonePromise } from '../testUtils'
import { Client } from '../../client'
import { MembershipOp } from '@towns-labs/proto'
import { dlog } from '@towns-labs/utils'

const log = dlog('csb:test:gdmsTests')

describe('gdmsTests', () => {
    let bobsClient: Client
    let alicesClient: Client
    let charliesClient: Client
    let chucksClient: Client

    beforeEach(async () => {
        bobsClient = await makeTestClient()
        await bobsClient.initializeUser()
        bobsClient.startSync()

        alicesClient = await makeTestClient()
        await alicesClient.initializeUser()
        alicesClient.startSync()

        charliesClient = await makeTestClient()
        await charliesClient.initializeUser()
        charliesClient.startSync()

        chucksClient = await makeTestClient()
        await chucksClient.initializeUser()
        chucksClient.startSync()

        log('clients initialized', {
            chuck: chucksClient.userId,
            bob: bobsClient.userId,
            alice: alicesClient.userId,
            charlie: charliesClient.userId,
        })
    })

    afterEach(async () => {
        await bobsClient.stop()
        await alicesClient.stop()
        await charliesClient.stop()
        await chucksClient.stop()
    })

    test('clientCanCreateGDM', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(bobsClient.sendMessage(streamId, 'hello')).resolves.not.toThrow()
    })

    test('clientAreJoinedAutomaticallyAndCanPostToGDM', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(charliesClient.waitForStream(streamId)).resolves.not.toThrow()

        await expect(bobsClient.sendMessage(streamId, 'greetings')).resolves.not.toThrow()
        await expect(alicesClient.sendMessage(streamId, 'hello!')).resolves.not.toThrow()
        await expect(charliesClient.sendMessage(streamId, 'hi')).resolves.not.toThrow()
    })

    test('clientCannotJoinUnlessInvited', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(chucksClient.joinStream(streamId)).rejects.toThrow()
    })

    test('clientCannotPostUnlessJoined', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)

        await expect(alicesClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.leaveStream(streamId)).resolves.not.toThrow()

        const stream = await bobsClient.waitForStream(streamId)
        await waitFor(() => {
            expect(stream.view.getMembers().joinedUsers).toEqual(
                new Set([bobsClient.userId, charliesClient.userId]),
            )
        })
        await expect(alicesClient.sendMessage(streamId, 'hello!')).rejects.toThrow()
    })

    test('clientCanLeaveGDM', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.leaveStream(streamId)).resolves.not.toThrow()
    })

    test('uninvitedUsersCannotInviteOthers', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(chucksClient.inviteUser(streamId, alicesClient.userId)).rejects.toThrow()
        await expect(chucksClient.inviteUser(streamId, chucksClient.userId)).rejects.toThrow()
    })

    test('usersCanInviteOthers', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.inviteUser(streamId, chucksClient.userId)).resolves.not.toThrow()
    })

    test('unjoinedUsersCannotJoinOthers', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        // can chuck join himself?
        await expect(chucksClient.joinUser(streamId, chucksClient.userId)).rejects.toThrow()
        // can chuck join chucks friend?
        const chucksFriend = await makeTestClient()
        await chucksFriend.initializeUser()
        await expect(chucksClient.joinUser(streamId, chucksFriend.userId)).rejects.toThrow()
    })

    test('usersCanJoinOthers', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.joinUser(streamId, chucksClient.userId)).resolves.not.toThrow()
        const stream = await chucksClient.waitForStream(streamId)
        await waitFor(() => {
            expect(stream.view.getMembers().joinedUsers.has(charliesClient.userId)).toEqual(true)
        })
    })

    test('gdmsRequireTwoOrMoreUsers', async () => {
        await expect(bobsClient.createGDMChannel([])).resolves.not.toThrow()
    })

    // Sender is expected to push keys to all members of the channel before sending the message,
    test('usersReceiveKeys', async () => {
        const users = [alicesClient.userId, charliesClient.userId, chucksClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(chucksClient.waitForStream(streamId)).resolves.not.toThrow()

        const promises = [alicesClient, charliesClient, chucksClient].map((client) =>
            createEventDecryptedPromise(client, 'hello'),
        )

        await bobsClient.sendMessage(streamId, 'hello')
        log('waiting for recipients to receive message')
        await Promise.all(promises)
    })

    test('usersReceiveKeysAfterInviteAndJoin', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()

        const aliceCharliePromises = [alicesClient, charliesClient].map((client) =>
            createEventDecryptedPromise(client, 'hello'),
        )

        await bobsClient.sendMessage(streamId, 'hello')
        log(`urkaiaj 1 waiting for recipients to receive message chuck: ${chucksClient.logId}`)
        await Promise.all(aliceCharliePromises)
        log('urkaiaj 2')
        // In this test, Bob invites Chuck _after_ sending the message
        const chuckPromise = createEventDecryptedPromise(chucksClient, 'hello')
        await expect(bobsClient.inviteUser(streamId, chucksClient.userId)).resolves.not.toThrow()
        log('urkaiaj 3')
        const stream = await chucksClient.waitForStream(streamId)
        await stream.waitForMembership(MembershipOp.SO_INVITE)
        log('urkaiaj 4')
        await expect(chucksClient.joinStream(streamId)).resolves.not.toThrow()
        log('urkaiaj 5')
        await expect(chuckPromise).resolves.not.toThrow()
        log('urkaiaj 6')
    })

    // In this test, Bob goes offline after sending the message,
    // before Chuck has joined the channel.
    test('usersReceiveKeysBobGoesOffline', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()

        const aliceCharliePromises = [alicesClient, charliesClient].map((client) =>
            createEventDecryptedPromise(client, 'hello'),
        )

        await bobsClient.sendMessage(streamId, 'hello')
        log('waiting for recipients to receive message')
        await Promise.all(aliceCharliePromises)
        await bobsClient.stop()

        const chuckPromise = createEventDecryptedPromise(chucksClient, 'hello')
        await expect(alicesClient.inviteUser(streamId, chucksClient.userId)).resolves.not.toThrow()
        const stream = await chucksClient.waitForStream(streamId)
        await stream.waitForMembership(MembershipOp.SO_INVITE)
        await expect(chucksClient.joinStream(streamId)).resolves.not.toThrow()
        await expect(chuckPromise).resolves.not.toThrow()
    })

    // Users should eventually receive keys — even if they have not JOINED the channel yet.
    // for GDMS, an INVITE is enough
    test('usersReceiveKeysWithoutJoin', async () => {
        const users = [alicesClient.userId, charliesClient.userId, chucksClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()

        const promises = [alicesClient, charliesClient, chucksClient].map((client) =>
            createEventDecryptedPromise(client, 'hello'),
        )

        await bobsClient.sendMessage(streamId, 'hello')
        log('waiting for recipients to receive message')
        await Promise.all(promises)
    })

    test('usersCanSetChannelProperties', async () => {
        const users = [alicesClient.userId, charliesClient.userId, chucksClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(charliesClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(chucksClient.waitForStream(streamId)).resolves.not.toThrow()

        const name = "Bob's GDM"
        const topic = "Bob's GDM description"

        function createChannelPropertiesPromise(client: Client) {
            const donePromise = makeDonePromise()
            client.on('streamChannelPropertiesUpdated', (updatedStreamId: string): void => {
                donePromise.runAndDone(() => {
                    expect(updatedStreamId).toEqual(streamId)
                    const stream = client.streams.get(streamId)

                    const channelProperties = stream?.view.gdmChannelContent?.channelProperties
                    expect(channelProperties).toBeDefined()

                    expect(channelProperties?.name).toEqual(name)
                    expect(channelProperties?.topic).toEqual(topic)
                })
            })
            return donePromise.promise
        }

        const promises = [bobsClient, alicesClient, charliesClient, chucksClient].map(
            createChannelPropertiesPromise,
        )

        await expect(
            bobsClient.updateGDMChannelProperties(streamId, name, topic),
        ).resolves.not.toThrow()
        log('waiting for members to receive new channel props')
        await Promise.all(promises)
    })

    test('leaderCanRemoveMembers', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(charliesClient.waitForStream(streamId)).resolves.not.toThrow()
        // Bob is the leader (creator), so Bob can remove Charlie
        await expect(bobsClient.removeUser(streamId, charliesClient.userId)).resolves.not.toThrow()
        const stream = await bobsClient.waitForStream(streamId)
        await stream.waitForMembership(MembershipOp.SO_LEAVE, charliesClient.userId)
    })

    test('nonMembersCannotRemoveMembers', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(charliesClient.waitForStream(streamId)).resolves.not.toThrow()

        // @ts-ignore
        await expect(chucksClient.initStream(streamId)).resolves.not.toThrow()
        await expect(chucksClient.removeUser(streamId, charliesClient.userId)).rejects.toThrow(
            'initiator of leave is not a member of GDM',
        )
    })

    test('membershipLimitCanBeEqualedOnInception', async () => {
        const users: string[] = []
        // Create 5 users
        for (let i = 0; i < 5; i++) {
            const client = await makeTestClient()
            await client.initializeUser()
            users.push(client.userId)
        }
        // 6 members total is OK
        const { streamId } = await bobsClient.createGDMChannel(users)
        expect(streamId).toBeDefined()
    })

    test('membershipLimitCannotBeExceededOnInception', async () => {
        const users: string[] = []
        // Create 6 users
        for (let i = 0; i < 6; i++) {
            const client = await makeTestClient()
            await client.initializeUser()
            users.push(client.userId)
        }
        // 7 members total exceeds the configured limit
        await expect(bobsClient.createGDMChannel(users)).rejects.toThrow(
            /membership limit reached[\s]+membershipLimit = 6/,
        )
    })

    test('membershipLimitCannotBeExceededByJoins', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)

        // add 3 more users
        for (let i = 0; i < 3; i++) {
            const client = await makeTestClient()
            await client.initializeUser()
            await expect(bobsClient.joinUser(streamId, client.userId)).resolves.not.toThrow()
        }

        // total memberships are now 6, joining another user should fail
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        // wait for 6 confirmed memberships, should only equal 6 after miniblock confirmation
        // miniblocks should be properly replicated to all nodes
        await waitFor(() => {
            const stream = bobsClient.streams.get(streamId)
            expect(stream?.view.getMembers().joinedUsers.size).toEqual(6)
        })
        // try to join the 7th user
        await expect(bobsClient.joinUser(streamId, chucksClient.userId)).rejects.toThrow(
            /membership limit reached[\s]+membershipLimit = 6/,
        )
    })

    test('membershipLimitCannotBeExceededByInvites', async () => {
        const users = [alicesClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)

        // add 3 more users
        for (let i = 0; i < 3; i++) {
            const client = await makeTestClient()
            await client.initializeUser()
            await expect(bobsClient.joinUser(streamId, client.userId)).resolves.not.toThrow()
        }
        // wait for 6 confirmed memberships, should only equal 6 after miniblock confirmation
        // miniblocks should be properly replicated to all nodes
        await waitFor(() => {
            const stream = bobsClient.streams.get(streamId)
            expect(stream?.view.getMembers().joinedUsers.size).toEqual(6)
        })
        // total memberships are now 6, inviting another user should fail
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(bobsClient.inviteUser(streamId, chucksClient.userId)).rejects.toThrow(
            /membership limit reached[\s]+membershipLimit = 6/,
        )
    })

    test('kickPermissionsTest', async () => {
        // Bob creates a GDM with Alice, Chuck, and Charlie
        const users = [alicesClient.userId, chucksClient.userId, charliesClient.userId]
        const { streamId } = await bobsClient.createGDMChannel(users)

        // Wait for all clients to have the stream
        await expect(bobsClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(alicesClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(chucksClient.waitForStream(streamId)).resolves.not.toThrow()
        await expect(charliesClient.waitForStream(streamId)).resolves.not.toThrow()

        // Wait for all members to be joined
        const bobStream = await bobsClient.waitForStream(streamId)
        await waitFor(() => {
            expect(bobStream.view.getMembers().joinedUsers.size).toEqual(4)
        })

        // Alice tries to remove Chuck - should fail since Alice is not the leader
        await expect(alicesClient.removeUser(streamId, chucksClient.userId)).rejects.toThrow(
            /only the leader can remove members from GDM/,
        )

        // Bob (the creator/leader) removes Chuck - should succeed
        await expect(bobsClient.removeUser(streamId, chucksClient.userId)).resolves.not.toThrow()

        // Wait for Chuck to be removed
        await waitFor(() => {
            expect(bobStream.view.getMembers().joinedUsers.has(chucksClient.userId)).toEqual(false)
            expect(bobStream.view.getMembers().joinedUsers.size).toEqual(3)
        })

        // Bob leaves the GDM
        await expect(bobsClient.leaveStream(streamId)).resolves.not.toThrow()

        // Wait for Bob to be removed
        await waitFor(() => {
            const aliceStream = alicesClient.streams.get(streamId)
            expect(aliceStream?.view.getMembers().joinedUsers.has(bobsClient.userId)).toEqual(false)
            expect(aliceStream?.view.getMembers().joinedUsers.size).toEqual(2)
        })

        // Get the new leader using getLeader()
        const aliceStream = await alicesClient.waitForStream(streamId)
        const newLeader = aliceStream.view.getMembers().getLeader()
        log('New leader after Bob leaves:', newLeader)

        expect(newLeader).toEqual(alicesClient.userId) // alice was the first in the list of users

        // Alice is the new leader, she should be able to remove Charlie
        await expect(
            alicesClient.removeUser(streamId, charliesClient.userId),
        ).resolves.not.toThrow()
        await waitFor(() => {
            expect(aliceStream.view.getMembers().joinedUsers.size).toEqual(1)
        })
    })
})
