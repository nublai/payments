import { Snapshot } from '@towns-labs/proto'

// Legacy migration for space channel settings. No-op after stream-type cleanup.
export function snapshotMigration0002(snapshot: Snapshot): Snapshot {
    return snapshot
}
