import { SnapshotSchema } from '@towns-labs/proto'
import { bin_toHexString } from '@towns-labs/utils'
import { create } from '@bufbuild/protobuf'
import { snapshotMigration0004 } from '../../migrations/snapshotMigration0004'
import { streamIdToBytes, makeUniqueGDMChannelStreamId } from '../../id'

describe('snapshotMigration0004', () => {
    test('run migration with common session IDs', () => {
        // Create a test session ID that will appear frequently
        const commonSessionIdBytes = new Uint8Array(
            'common-session-id'.split('').map((c) => c.charCodeAt(0)),
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
                            { sessionIds: [commonSessionId, 'unique1_b'] },
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

        const result = snapshotMigration0004(snap, true)

        // Verify that common session IDs are removed
        for (const member of result.members!.joined) {
            for (const solicitation of member.solicitations) {
                expect(solicitation.sessionIds).not.toContain(commonSessionId)
            }
        }
    })

    test('run migration with empty members', () => {
        const snap = create(SnapshotSchema, {})
        const result = snapshotMigration0004(snap, true)
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

        const result = snapshotMigration0004(snap, true)
        // Verify the snapshot remains unchanged when no common session IDs are found
        expect(result).toEqual(snap)
    })
})
