import { SnapshotSchema } from '@towns-labs/proto'
import { snapshotMigration0001 } from '../../migrations/snapshotMigration0001'
import { ethers } from 'ethers'
import { addressFromUserId, streamIdAsBytes } from '../../id'
import { check } from '@towns-labs/utils'
import { create } from '@bufbuild/protobuf'

// a no-op migration test for the initial snapshot, use as a template for new migrations
describe('snapshotMigration0001', () => {
    test('run migration', () => {
        const wallet = ethers.Wallet.createRandom()
        const userAddress = addressFromUserId(wallet.address)
        const streamId = streamIdAsBytes(wallet.address)

        // members
        const badMemberSnap = create(SnapshotSchema, {
            members: {
                joined: [{ userAddress: userAddress }, { userAddress: userAddress }],
            },
        })
        const result = snapshotMigration0001(badMemberSnap)
        expect(result.members?.joined.length).toBe(1)

        // user payload
        const badUserPayload = create(SnapshotSchema, {
            content: {
                case: 'userContent',
                value: {
                    memberships: [{ streamId }, { streamId }],
                },
            },
        })
        const result3 = snapshotMigration0001(badUserPayload)
        check(result3.content.case === 'userContent')
        expect(result3.content?.value.memberships.length).toBe(1)

        // user settings
        const badUserSettings = create(SnapshotSchema, {
            content: {
                case: 'userSettingsContent',
                value: {
                    fullyReadMarkers: [{ streamId }, { streamId }],
                },
            },
        })
        const result4 = snapshotMigration0001(badUserSettings)
        check(result4.content.case === 'userSettingsContent')
        expect(result4.content?.value.fullyReadMarkers.length).toBe(1)
    })
})
