export interface AccountRecord {
    id: string
    accountPickle: string
}

// Kept for IndexedDB table type declarations (removing tables requires a DB migration)
export interface GroupSessionRecord {
    sessionId: string
    session: string
    streamId: string
}

// Kept for IndexedDB table type declarations (removing tables requires a DB migration)
export interface ExtendedInboundGroupSessionData {
    streamId: string
    sessionId: string
    stream_id: string
    session: string
    keysClaimed: Record<string, string>
    untrusted?: boolean
}

export interface HybridGroupSessionRecord {
    sessionId: string
    streamId: string
    sessionKey: Uint8Array
    miniblockNum: bigint
}

export interface UserDeviceRecord {
    userId: string
    deviceKey: string
    fallbackKey: string
    expirationTimestamp: number
}
