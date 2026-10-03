import { createCryptoStore, CryptoStore } from '@towns-labs/encryption'

export class RiverDbManager {
    public static getCryptoDb(userId: string, dbName?: string, maxEntries?: number): CryptoStore {
        return createCryptoStore(dbName ?? `database-${userId}`, userId, maxEntries)
    }
}
