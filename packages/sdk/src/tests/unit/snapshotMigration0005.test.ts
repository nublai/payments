import { SnapshotSchema } from '@towns-labs/proto'
import { bin_toHexString } from '@towns-labs/utils'
import { create } from '@bufbuild/protobuf'
import { snapshotMigration0005 } from '../../migrations/snapshotMigration0005'
import { streamIdToBytes, makeUniqueGDMChannelStreamId } from '../../id'

describe('snapshotMigration0005', () => {
    test('run migration with common session IDs and empty solicitations', () => {
        // Create a test session ID that will appear frequently
        const commonSessionIdBytes = new Uint8Array(
            'common-session-id-5'.split('').map((c) => c.charCodeAt(0)),
        )
        const commonSessionId = bin_toHexString(commonSessionIdBytes)
        const streamId = makeUniqueGDMChannelStreamId()
        const streamIdBytes = streamIdToBytes(streamId)

        // Create a snapshot with multiple members having the same session ID
        const snap = create(SnapshotSchema, {
            content: {
                case: 'gdmChannelContent',
                value: {
                    inception: {
                        streamId: streamIdBytes,
                    },
                },
            },
            members: {
                joined: [
                    {
                        solicitations: [
                            { sessionIds: [commonSessionId, 'unique1_a'] },
                            { sessionIds: [commonSessionId] }, // Will become empty
                        ],
                    },
                    {
                        solicitations: [{ sessionIds: [commonSessionId, 'unique2'] }],
                    },
                    {
                        solicitations: [{ sessionIds: [commonSessionId, 'unique3'] }],
                    },
                    {
                        solicitations: [{ sessionIds: ['unique4'] }],
                    },
                ],
            },
        })

        const result = snapshotMigration0005(snap, true)

        for (const member of result.members!.joined) {
            for (const solicitation of member.solicitations) {
                expect(solicitation.sessionIds).not.toContain(commonSessionId)
            }
            // All solicitations should be non-empty
            for (const solicitation of member.solicitations) {
                expect(solicitation.sessionIds.length).toBeGreaterThan(0)
            }
        }
    })

    test('run migration with empty members', () => {
        const snap = create(SnapshotSchema, {})
        const result = snapshotMigration0005(snap, true)
        expect(result).toEqual(snap)
    })

    test('run migration with no common session IDs', () => {
        const snap = create(SnapshotSchema, {
            members: {
                joined: [
                    {
                        solicitations: [{ sessionIds: ['unique1', 'unique2'] }],
                    },
                    {
                        solicitations: [{ sessionIds: ['unique4', 'unique5'] }],
                    },
                ],
            },
        })

        const result = snapshotMigration0005(snap, true)
        // Verify the snapshot remains unchanged when no common session IDs are found
        expect(result).toEqual(snap)
    })

    test('run migration with empty solicitations', () => {
        const snap = create(SnapshotSchema, {
            members: {
                joined: [{ solicitations: [] }],
            },
        })
        const result = snapshotMigration0005(snap, true)
        expect(result.members?.joined[0].solicitations).toEqual([])
    })
})
