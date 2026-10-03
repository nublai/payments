import { AccountRecord, HybridGroupSessionRecord, UserDeviceRecord } from './storeTypes'
import { UserDevice } from './olmLib'
import { CryptoStore, DEFAULT_USER_DEVICE_EXPIRATION_TIME_MS } from './cryptoStore'
import { LRUCache } from 'lru-cache'

const DEFAULT_MAX_CRYPTO_STORE_ENTRIES = 5_000

export class CryptoStoreInMemory implements CryptoStore {
    private accounts: LRUCache<string, AccountRecord>
    private hybridGroupSessions: LRUCache<string, HybridGroupSessionRecord>
    private devices: LRUCache<string, UserDeviceRecord>

    constructor(
        public readonly userId: string,
        maxEntries: number = DEFAULT_MAX_CRYPTO_STORE_ENTRIES,
    ) {
        this.accounts = new LRUCache({ max: maxEntries })
        this.hybridGroupSessions = new LRUCache({ max: maxEntries })
        this.devices = new LRUCache({ max: maxEntries })
    }

    async initialize(): Promise<void> {
        const now = Date.now()
        const expiredKeys: string[] = []
        for (const [key, device] of this.devices.entries()) {
            if (device.expirationTimestamp < now) {
                expiredKeys.push(key)
            }
        }
        expiredKeys.forEach((key) => this.devices.delete(key))
    }

    async deleteAllData(): Promise<void> {
        this.accounts.clear()
        this.hybridGroupSessions.clear()
        this.devices.clear()
    }

    async deleteAccount(userId: string): Promise<void> {
        this.accounts.delete(userId)
    }

    async getAccount(): Promise<string> {
        const account = this.accounts.get(this.userId)
        if (!account) {
            throw new Error('account not found')
        }
        return account.accountPickle
    }

    async storeAccount(accountPickle: string): Promise<void> {
        this.accounts.set(this.userId, { id: this.userId, accountPickle })
    }

    async getHybridGroupSession(
        streamId: string,
        sessionId: string,
    ): Promise<HybridGroupSessionRecord | undefined> {
        const key = this.getHybridSessionKey(streamId, sessionId)
        return this.hybridGroupSessions.get(key)
    }

    async getHybridGroupSessionsForStream(streamId: string): Promise<HybridGroupSessionRecord[]> {
        const sessions: HybridGroupSessionRecord[] = []
        for (const session of this.hybridGroupSessions.values()) {
            if (session.streamId === streamId) {
                sessions.push(session)
            }
        }
        return sessions
    }

    async getAllHybridGroupSessions(): Promise<HybridGroupSessionRecord[]> {
        return Array.from(this.hybridGroupSessions.values())
    }

    async deleteHybridGroupSessions(streamId: string): Promise<void> {
        for (const session of this.hybridGroupSessions.values()) {
            if (session.streamId === streamId) {
                this.hybridGroupSessions.delete(
                    this.getHybridSessionKey(session.streamId, session.sessionId),
                )
            }
        }
    }

    async storeHybridGroupSession(sessionData: HybridGroupSessionRecord): Promise<void> {
        const key = this.getHybridSessionKey(sessionData.streamId, sessionData.sessionId)
        this.hybridGroupSessions.set(key, sessionData)
    }

    async getHybridGroupSessionIds(streamId: string): Promise<string[]> {
        const sessionIds: string[] = []
        for (const session of this.hybridGroupSessions.values()) {
            if (session.streamId === streamId) {
                sessionIds.push(session.sessionId)
            }
        }
        return sessionIds
    }

    async withAccountTx<T>(fn: () => Promise<T>): Promise<T> {
        // In-memory implementation doesn't need transactions
        return await fn()
    }

    async withGroupSessions<T>(fn: () => Promise<T>): Promise<T> {
        // In-memory implementation doesn't need transactions
        return await fn()
    }

    async deviceRecordCount(): Promise<number> {
        return this.devices.size
    }

    async saveUserDevices(
        userId: string,
        devices: UserDevice[],
        expirationMs: number = DEFAULT_USER_DEVICE_EXPIRATION_TIME_MS,
    ): Promise<void> {
        const expirationTimestamp = Date.now() + expirationMs
        for (const device of devices) {
            const key = this.getDeviceKey(userId, device.deviceKey)
            this.devices.set(key, { userId, expirationTimestamp, ...device })
        }
    }

    async getUserDevices(userId: string): Promise<UserDevice[]> {
        const now = Date.now()
        const userDevices: UserDevice[] = []
        for (const device of this.devices.values()) {
            if (device.userId === userId && device.expirationTimestamp > now) {
                userDevices.push({
                    deviceKey: device.deviceKey,
                    fallbackKey: device.fallbackKey,
                })
            }
        }
        return userDevices
    }

    private getHybridSessionKey(streamId: string, sessionId: string): string {
        return `${streamId}:${sessionId}`
    }

    private getDeviceKey(userId: string, deviceKey: string): string {
        return `${userId}:${deviceKey}`
    }
}
