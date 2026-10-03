import type { CryptoStore } from './cryptoStore'
import { Account, Utility } from './encryptionTypes'
import { EncryptionDelegate } from './encryptionDelegate'
import { GroupEncryptionAlgorithmId, GroupEncryptionSession } from './olmLib'
import { bin_equal, bin_fromHexString, bin_toHexString, dlog } from '@towns-labs/utils'
import type { HybridGroupSessionRecord } from './storeTypes'
import {
    ExportedDevice,
    ExportedDevice_HybridGroupSession,
    ExportedDeviceSchema,
    ExportedDevice_HybridGroupSessionSchema,
    HybridGroupSessionKey,
    HybridGroupSessionKeySchema,
    PlainMessage,
} from '@towns-labs/proto'
import { exportAesGsmKeyBytes, generateNewAesGcmKey } from './cryptoAesGcm'
import { Dexie } from 'dexie'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'

const log = dlog('csb:encryption:encryptionDevice')

// The maximum size of an event is 65K, and we base64 the content, so this is a
// reasonable approximation to the biggest plaintext we can encrypt.
const MAX_PLAINTEXT_LENGTH = (65536 * 3) / 4

export type EncryptionDeviceInitOpts = {
    fromExportedDevice?: ExportedDevice
    pickleKey?: string
}

function checkPayloadLength(
    payloadString: string,
    opts: { streamId?: string; source: string },
): void {
    if (payloadString === undefined) {
        throw new Error('payloadString undefined')
    }

    if (payloadString.length > MAX_PLAINTEXT_LENGTH) {
        // might as well fail early here rather than letting the olm library throw
        // a cryptic memory allocation error.
        throw new Error(
            `Message too long (${payloadString.length} bytes). ` +
                `The maximum for an encrypted message is ${MAX_PLAINTEXT_LENGTH} bytes.` +
                `streamId: ${opts.streamId}, source: ${opts.source}`,
        )
    }
}

export class EncryptionDevice {
    // https://linear.app/hnt-labs/issue/HNT-4273/pick-a-better-pickle-key-in-olmdevice
    public pickleKey = 'DEFAULT_KEY' // set by consumers

    /** Curve25519 key for the account, unknown until we load the account from storage in init() */
    public deviceCurve25519Key: string | null = null
    /** Ed25519 key for the account, unknown until we load the account from storage in init() */
    public deviceDoNotUseKey: string | null = null
    // keyId: base64(key)
    public fallbackKey: { keyId: string; key: string } = { keyId: '', key: '' }

    // Keep track of sessions that we're starting, so that we don't start
    // multiple sessions for the same device at the same time.
    public sessionsInProgress: Record<string, Promise<void>> = {} // set by consumers

    // Used by olm to serialise prekey message decryptions
    // todo: ensure we need this to serialize prekey message given we're using fallback keys
    // not one time keys, which suffer a race condition and expire once used.
    public olmPrekeyPromise: Promise<any> = Promise.resolve() // set by consumers

    public constructor(
        private delegate: EncryptionDelegate,
        private readonly cryptoStore: CryptoStore,
    ) {}

    /**
     * Iniitialize the Account. Must be called prior to any other operation
     * on the device.
     *
     * Data from an exported device can be provided in order to recreate this device.
     *
     * Attempts to load the Account from the crypto store, or create one otherwise
     * storing the account in storage.
     *
     * Reads the device keys from the Account object.
     *
     * @param fromExportedDevice - data from exported device
     *     that must be re-created.
     *     If present, opts.pickleKey is ignored
     *     (exported data already provides a pickle key)
     * @param pickleKey - pickle key to set instead of default one
     *
     *
     */
    public async init(opts?: EncryptionDeviceInitOpts): Promise<void> {
        const { fromExportedDevice, pickleKey } = opts ?? {}
        let e2eKeys
        if (!this.delegate.isInitialized) {
            this.delegate = new EncryptionDelegate()
            await this.delegate.init()
        }
        const account = this.delegate.createAccount()
        try {
            if (fromExportedDevice) {
                this.pickleKey = fromExportedDevice.pickleKey
                await this.initializeFromExportedDevice(fromExportedDevice, account)
            } else {
                if (pickleKey) {
                    this.pickleKey = pickleKey
                }
                await this.initializeAccount(account)
            }
            await this.generateFallbackKeyIfNeeded()
            e2eKeys = JSON.parse(account.identity_keys())
            this.fallbackKey = await this.getFallbackKey()
        } finally {
            account.free()
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.deviceCurve25519Key = e2eKeys.curve25519
        // note jterzis 07/19/23: deprecating ed25519 key in favor of TDK
        // see: https://linear.app/hnt-labs/issue/HNT-1796/tdk-signature-storage-curve25519-key
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.deviceDoNotUseKey = e2eKeys.ed25519
        log(
            `init: deviceCurve25519Key: ${this.deviceCurve25519Key}, fallbackKey ${JSON.stringify(
                this.fallbackKey,
            )}`,
        )
    }

    private async initializeFromExportedDevice(
        exportedData: ExportedDevice,
        account: Account,
    ): Promise<void> {
        await this.cryptoStore.withAccountTx(() =>
            this.cryptoStore.storeAccount(exportedData.pickledAccount),
        )
        await this.cryptoStore.withGroupSessions(() =>
            Promise.all(
                exportedData.hybridGroupSessions.map((session: ExportedDevice_HybridGroupSession) =>
                    this.cryptoStore.storeHybridGroupSession(session),
                ),
            ),
        )
        account.unpickle(this.pickleKey, exportedData.pickledAccount)
    }

    private async initializeAccount(account: Account): Promise<void> {
        try {
            const pickledAccount = await this.cryptoStore.getAccount()
            account.unpickle(this.pickleKey, pickledAccount)
        } catch {
            account.create()
            const pickledAccount = account.pickle(this.pickleKey)
            await this.cryptoStore.storeAccount(pickledAccount)
        }
    }

    /**
     * Export the current device state
     * @returns ExportedDevice object containing the device state
     */
    public async exportDevice(): Promise<ExportedDevice> {
        const account = await this.getAccount()
        const pickledAccount = account.pickle(this.pickleKey)
        account.free()

        const hybridGroupSessions = await this.cryptoStore.getAllHybridGroupSessions()

        return create(ExportedDeviceSchema, {
            pickleKey: this.pickleKey,
            pickledAccount,
            hybridGroupSessions: hybridGroupSessions.map((session) =>
                create(ExportedDevice_HybridGroupSessionSchema, {
                    sessionId: session.sessionId,
                    streamId: session.streamId,
                    sessionKey: session.sessionKey,
                    miniblockNum: session.miniblockNum,
                } satisfies PlainMessage<ExportedDevice_HybridGroupSession>),
            ),
        })
    }

    /**
     * Extract our Account from the crypto store and call the given function
     * with the account object
     * The `account` object is usable only within the callback passed to this
     * function and will be freed as soon the callback returns. It is *not*
     * usable for the rest of the lifetime of the transaction.
     * This function requires a live transaction object from cryptoStore.doTxn()
     * and therefore may only be called in a doTxn() callback.
     *
     * @param txn - Opaque transaction object from cryptoStore.doTxn()
     * @internal
     */
    private async getAccount(): Promise<Account> {
        const pickledAccount = await this.cryptoStore.getAccount()
        const account = this.delegate.createAccount()
        account.unpickle(this.pickleKey, pickledAccount)
        return account
    }

    /**
     * Saves an account to the crypto store.
     * This function requires a live transaction object from cryptoStore.doTxn()
     * and therefore may only be called in a doTxn() callback.
     *
     * @param txn - Opaque transaction object from cryptoStore.doTxn()
     * @param Account object
     * @internal
     */
    private async storeAccount(account: Account): Promise<void> {
        await this.cryptoStore.storeAccount(account.pickle(this.pickleKey))
    }

    /**
     * get an OlmUtility and call the given function
     *
     * @returns result of func
     * @internal
     */
    private getUtility<T>(func: (utility: Utility) => T): T {
        const utility = this.delegate.createUtility()
        try {
            return func(utility)
        } finally {
            utility.free()
        }
    }

    /**
     * Signs a message with the ed25519 key for this account.
     *
     * @param message -  message to be signed
     * @returns base64-encoded signature
     */
    public async sign(message: string): Promise<string> {
        const account = await this.getAccount()
        return account.sign(message)
    }

    /**
     * Marks all of the fallback keys as published.
     */
    public async markKeysAsPublished(): Promise<void> {
        const account = await this.getAccount()
        account.mark_keys_as_published()
        await this.storeAccount(account)
    }

    /**
     * Generate a new fallback keys
     *
     * @returns Resolved once the account is saved back having generated the key
     */
    public async generateFallbackKeyIfNeeded(): Promise<void> {
        try {
            await this.getFallbackKey()
        } catch {
            const account = await this.getAccount()
            account.generate_fallback_key()
            await this.storeAccount(account)
        }
    }

    public async getFallbackKey(): Promise<{ keyId: string; key: string }> {
        const account = await this.getAccount()
        const record: Record<string, Record<string, string>> = JSON.parse(
            account.unpublished_fallback_key(),
        )
        const key = Object.values(record.curve25519)[0]
        const keyId = Object.keys(record.curve25519)[0]
        if (!key || !keyId) {
            throw new Error('No fallback key')
        }
        return { key, keyId }
    }

    public async forgetOldFallbackKey(): Promise<void> {
        const account = await this.getAccount()
        account.forget_old_fallback_key()
        await this.storeAccount(account)
    }

    /** */
    public async getHybridGroupSessionKeyForStream(
        streamId: string,
    ): Promise<HybridGroupSessionKey> {
        return this.cryptoStore.withGroupSessions(async () => {
            const sessionRecords = await this.cryptoStore.getHybridGroupSessionsForStream(streamId)
            if (sessionRecords.length === 0) {
                throw new Error(`hybrid group session not found for stream ${streamId}`)
            }
            // sort on session.miniblockNum decending
            const sessionRecord = sessionRecords.reduce(
                (max, current) => (current.miniblockNum > max.miniblockNum ? current : max),
                sessionRecords[0],
            )
            return fromBinary(HybridGroupSessionKeySchema, sessionRecord.sessionKey)
        })
    }

    /** */
    public async getHybridGroupSessionKey(
        streamId: string,
        sessionId: string,
    ): Promise<HybridGroupSessionKey> {
        return this.cryptoStore.withGroupSessions(async () => {
            const sessionRecord = await this.cryptoStore.getHybridGroupSession(streamId, sessionId)
            if (!sessionRecord) {
                throw new Error(`hybrid group session not found for stream ${streamId}`)
            }
            return fromBinary(HybridGroupSessionKeySchema, sessionRecord.sessionKey)
        })
    }

    /** */
    public async createHybridGroupSession(
        streamId: string,
        miniblockNum: bigint,
        miniblockHash: Uint8Array,
    ): Promise<{
        sessionId: string
        sessionRecord: HybridGroupSessionRecord
        sessionKey: HybridGroupSessionKey
    }> {
        const streamIdBytes = bin_fromHexString(streamId)
        const aesKey = await generateNewAesGcmKey()
        const aesKeyBytes = await exportAesGsmKeyBytes(aesKey)
        const sessionIdBytes = await hybridSessionKeyHash(
            streamIdBytes,
            aesKeyBytes,
            miniblockNum,
            miniblockHash,
        )
        const sessionKey = create(HybridGroupSessionKeySchema, {
            sessionId: sessionIdBytes,
            streamId: streamIdBytes,
            key: aesKeyBytes,
            miniblockNum,
            miniblockHash,
        } satisfies PlainMessage<HybridGroupSessionKey>)
        const sessionId = bin_toHexString(sessionIdBytes)
        const sessionRecord: HybridGroupSessionRecord = {
            sessionId,
            streamId: streamId,
            sessionKey: toBinary(HybridGroupSessionKeySchema, sessionKey),
            miniblockNum,
        }

        return this.cryptoStore.withGroupSessions(async () => {
            await this.cryptoStore.storeHybridGroupSession(sessionRecord)
            return { sessionId, sessionRecord, sessionKey }
        })
    }

    /** */
    public async addHybridGroupSession(streamId: string, sessionId: string, sessionKey: string) {
        const sessionKeyBytes = bin_fromHexString(sessionKey)
        const session = fromBinary(HybridGroupSessionKeySchema, sessionKeyBytes)
        if (bin_toHexString(session.streamId) !== streamId) {
            throw new Error(`Stream ID mismatch for hybrid group session ${streamId}`)
        }
        if (bin_toHexString(session.sessionId) !== sessionId) {
            throw new Error(`Session ID mismatch for hybrid group session ${sessionId}`)
        }
        const expectedSessionPromise = hybridSessionKeyHash(
            session.streamId,
            session.key,
            session.miniblockNum,
            session.miniblockHash,
        )
        const expectedSessionId = await Dexie.waitFor(expectedSessionPromise)
        if (!bin_equal(expectedSessionId, bin_fromHexString(sessionId))) {
            throw new Error(
                `Session ID mismatch for hybrid group session ${sessionId} expected ${bin_toHexString(
                    expectedSessionId,
                )}`,
            )
        }
        await this.cryptoStore.withGroupSessions(async () => {
            await this.cryptoStore.storeHybridGroupSession({
                sessionId,
                streamId,
                sessionKey: sessionKeyBytes,
                miniblockNum: session.miniblockNum,
            })
        })
    }

    public async encryptUsingFallbackKey(
        theirIdentityKey: string,
        fallbackKey: string,
        payload: string,
    ): Promise<{ type: 0 | 1; body: string }> {
        checkPayloadLength(payload, { source: 'encryptUsingFallbackKey' })
        return this.cryptoStore.withAccountTx(async () => {
            const session = this.delegate.createSession()
            try {
                const account = await this.getAccount()
                session.create_outbound(account, theirIdentityKey, fallbackKey)
                const result = session.encrypt(payload)
                return result
            } catch (error) {
                log('Error encrypting message with fallback key', error)
                throw error
            } finally {
                session.free()
            }
        })
    }

    /**
     * Decrypt an incoming message using an existing session
     *
     * @param theirDeviceIdentityKey - Curve25519 identity key for the
     *     remote device
     * @param messageType -  messageType field from the received message
     * @param ciphertext - base64-encoded body from the received message
     *
     * @returns decrypted payload.
     */
    public async decryptMessage(
        ciphertext: string,
        theirDeviceIdentityKey: string,
        messageType: number = 0,
    ): Promise<string> {
        if (messageType !== 0) {
            throw new Error('Only pre-key messages supported')
        }

        checkPayloadLength(ciphertext, { source: 'decryptMessage' })
        return await this.cryptoStore.withAccountTx(async () => {
            const account = await this.getAccount()
            const session = this.delegate.createSession()
            const sessionDesc = session.describe()
            log(
                'Session ID ' +
                    session.session_id() +
                    ' from ' +
                    theirDeviceIdentityKey +
                    ': ' +
                    sessionDesc,
            )
            try {
                session.create_inbound_from(account, theirDeviceIdentityKey, ciphertext)
                await this.storeAccount(account)
                return session.decrypt(messageType, ciphertext)
            } catch (e) {
                throw new Error(
                    'Error decrypting prekey message: ' + JSON.stringify((<Error>e).message),
                )
            } finally {
                session.free()
            }
        })
    }

    // Utilities
    // =========

    /**
     * Verify an ed25519 signature.
     *
     * @param key - ed25519 key
     * @param message - message which was signed
     * @param signature - base64-encoded signature to be checked
     *
     * @throws Error if there is a problem with the verification. If the key was
     * too small then the message will be "OLM.INVALID_BASE64". If the signature
     * was invalid then the message will be "OLM.BAD_MESSAGE_MAC".
     */
    public verifySignature(key: string, message: string, signature: string): void {
        this.getUtility(function (util: Utility) {
            util.ed25519_verify(key, message, signature)
        })
    }

    public async getHybridGroupSessionIds(streamId: string): Promise<string[]> {
        return await this.cryptoStore.getHybridGroupSessionIds(streamId)
    }

    /** */
    public async hasHybridGroupSessionKey(streamId: string, sessionId: string): Promise<boolean> {
        const key = await this.cryptoStore.getHybridGroupSession(streamId, sessionId)
        return key !== undefined
    }

    /** */
    public async exportHybridGroupSession(
        streamId: string,
        sessionId: string,
    ): Promise<GroupEncryptionSession | undefined> {
        const sessionData = await this.cryptoStore.getHybridGroupSession(streamId, sessionId)
        if (!sessionData) {
            return undefined
        }
        return {
            streamId: streamId,
            sessionId: sessionId,
            sessionKey: bin_toHexString(sessionData.sessionKey),
            algorithm: GroupEncryptionAlgorithmId.HybridGroupEncryption,
        }
    }

    public async exportHybridGroupSessions(): Promise<GroupEncryptionSession[]> {
        const sessions = await this.cryptoStore.getAllHybridGroupSessions()
        return sessions.map((session: HybridGroupSessionRecord): GroupEncryptionSession => {
            return {
                streamId: session.streamId,
                sessionId: session.sessionId,
                sessionKey: bin_toHexString(session.sessionKey),
                algorithm: GroupEncryptionAlgorithmId.HybridGroupEncryption,
            }
        })
    }
}

const hybridSessionKeyHashPrefixBytes = new TextEncoder().encode('RVR_HSK:')

// TODO: needs unit tests
export async function hybridSessionKeyHash(
    streamId: Uint8Array,
    key: Uint8Array,
    miniblockNum: bigint,
    miniblockHash: Uint8Array,
): Promise<Uint8Array> {
    const length =
        hybridSessionKeyHashPrefixBytes.length +
        streamId.length +
        key.length +
        8 +
        miniblockHash.length

    const bytes = new ArrayBuffer(length)

    const dataView = new DataView(bytes)
    const arrayView = new Uint8Array(bytes)
    arrayView.set(hybridSessionKeyHashPrefixBytes)
    let offset = hybridSessionKeyHashPrefixBytes.length
    arrayView.set(streamId, offset)
    offset += streamId.length
    arrayView.set(key, offset)
    offset += key.length
    dataView.setBigUint64(offset, miniblockNum)
    offset += 8
    arrayView.set(miniblockHash, offset)
    offset += miniblockHash.length
    if (offset !== length) {
        throw new Error(`Final offset ${offset} does not match expected length ${length}`)
    }

    const hashBytes = await crypto.subtle.digest('SHA-256', bytes)
    return new Uint8Array(hashBytes)
}
