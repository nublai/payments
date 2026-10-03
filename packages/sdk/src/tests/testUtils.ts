/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { _impl_makeEvent_impl_, unpackStreamEnvelopes } from '../sign'
import {
    EncryptedData,
    Envelope,
    StreamEvent,
    ChannelMessage,
    SnapshotCaseType,
    SyncStreamsResponse,
    SyncOp,
    EncryptedDataVersion,
    PlainMessage,
    BlockchainTransaction_TokenTransfer,
} from '@towns-labs/proto'
import { Client, ClientOptions } from '../client'
import { townsEnv } from '../townsEnv'
import { genId, makeUniqueGDMChannelStreamId, userIdFromAddress } from '../id'
import { ParsedEvent, StreamTimelineEvent } from '../types'
import { secp256k1 } from '@noble/curves/secp256k1'
import { bin_fromHexString, check, dlog, publicKeyToAddress } from '@towns-labs/utils'
import { ethers } from 'ethers'
import { RiverDbManager } from '../riverDbManager'
import { StreamRpcClient, makeStreamRpcClient } from '../makeStreamRpcClient'
import { forEachRight } from 'lodash-es'
import { SignerContext, makeSignerContext } from '../signerContext'
import { LocalhostWeb3Provider } from './LocalhostWeb3Provider'
import { RiverTimelineEvent, type TimelineEvent } from '../views/models/timelineTypes'
import { RpcOptions } from '../rpcCommon'
import { isDefined } from '../check'
import { MemberTokenTransfer } from '../streamStateView_Members'

const log = dlog('csb:test:util')

const initTestUrls = async (): Promise<{
    testUrls: string[]
    refreshNodeUrl?: () => Promise<string>
}> => {
    const config = townsEnv().makeRiverChainConfig()
    const urls = townsEnv().getNodeUrl()
    log('initTestUrls, RIVER_TEST_CONNECT=', config, 'testUrls=', urls)
    return { testUrls: urls.split(','), refreshNodeUrl: undefined }
}

let curTestUrl = -1
const getNextTestUrl = async (): Promise<{
    urls: string
    refreshNodeUrl?: () => Promise<string>
}> => {
    const { testUrls, refreshNodeUrl } = await initTestUrls()
    if (testUrls.length === 1) {
        log('getNextTestUrl, url=', testUrls[0])
        return { urls: testUrls[0], refreshNodeUrl }
    } else if (testUrls.length > 1) {
        if (curTestUrl < 0) {
            const seed: string | undefined = expect.getState()?.currentTestName
            if (seed === undefined) {
                curTestUrl = Math.floor(Math.random() * testUrls.length)
                log('getNextTestUrl, setting to random, index=', curTestUrl)
            } else {
                curTestUrl =
                    seed
                        .split('')
                        .map((v) => v.charCodeAt(0))
                        .reduce((a, v) => ((a + ((a << 7) + (a << 3))) ^ v) & 0xffff) %
                    testUrls.length
                log('getNextTestUrl, setting based on test name=', seed, ' index=', curTestUrl)
            }
        }
        curTestUrl = (curTestUrl + 1) % testUrls.length
        log('getNextTestUrl, url=', testUrls[curTestUrl], 'index=', curTestUrl)
        return { urls: testUrls[curTestUrl], refreshNodeUrl }
    } else {
        throw new Error('no test urls')
    }
}

export const makeTestRpcClient = async (opts?: RpcOptions) => {
    const { urls: url, refreshNodeUrl } = await getNextTestUrl()
    return makeStreamRpcClient(url, refreshNodeUrl, opts)
}

export const makeEvent_test = async (
    context: SignerContext,
    payload: PlainMessage<StreamEvent>['payload'],
    prevMiniblockHash?: Uint8Array,
): Promise<Envelope> => {
    return _impl_makeEvent_impl_(context, payload, prevMiniblockHash)
}

export const TEST_ENCRYPTED_MESSAGE_PROPS: PlainMessage<EncryptedData> = {
    sessionId: '',
    sessionIdBytes: new Uint8Array(0),
    ciphertext: '',
    algorithm: '',
    senderKey: '',
    ciphertextBytes: new Uint8Array(0),
    ivBytes: new Uint8Array(0),
    version: EncryptedDataVersion.ENCRYPTED_DATA_VERSION_1,
}

export const twoEth = BigInt(2e18)
export const oneEth = BigInt(1e18)
export const threeEth = BigInt(3e18)
export const oneHalfEth = BigInt(5e17)

export const makeUniqueGDMStreamId = (): string => {
    return makeUniqueGDMChannelStreamId()
}

export type SignerContextWithWallet = SignerContext & { wallet: ethers.Wallet }
/**
 *
 * @returns a random user context
 * Done using a worker thread to avoid blocking the main thread
 */
export const makeRandomUserContext = async (): Promise<SignerContextWithWallet> => {
    const wallet = ethers.Wallet.createRandom()
    log('makeRandomUserContext', wallet.address)
    return await makeUserContextFromWallet(wallet)
}

export const makeRandomUserAddress = (): Uint8Array => {
    return publicKeyToAddress(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), false))
}

export const makeUserContextFromWallet = async (
    wallet: ethers.Wallet,
): Promise<SignerContextWithWallet> => {
    const userPrimaryWallet = wallet
    const delegateWallet = ethers.Wallet.createRandom()
    const creatorAddress = publicKeyToAddress(bin_fromHexString(userPrimaryWallet.publicKey))
    log('makeRandomUserContext', userIdFromAddress(creatorAddress))

    return { ...(await makeSignerContext(userPrimaryWallet, delegateWallet, { days: 1 })), wallet }
}

export interface TestClient extends Client {
    wallet: ethers.Wallet
    deviceId: string
    signerContext: SignerContextWithWallet
}

export interface TestClientOpts extends ClientOptions {
    context?: SignerContextWithWallet
    appAddress?: string
    deviceId?: string
}

export const cloneTestClient = async (client: TestClient): Promise<TestClient> => {
    return makeTestClient({
        ...client.opts,
        context: {
            ...client.signerContext,
            wallet: client.wallet,
        },
        deviceId: client.deviceId,
    })
}

export const makeTestClient = async (opts?: TestClientOpts): Promise<TestClient> => {
    const context = opts?.context ?? (await makeRandomUserContext())
    const deviceId = opts?.deviceId ? `-${opts.deviceId}` : `-${genId(5)}`
    const userId = userIdFromAddress(context.creatorAddress)
    const dbName = `database-${userId}${deviceId}`
    const persistenceDbName = `persistence-${userId}${deviceId}`
    const appAddress = opts?.appAddress

    // create a new client with store(s)
    const cryptoStore = RiverDbManager.getCryptoDb(userId, dbName)
    const rpcClient = await makeTestRpcClient()
    const client = new Client(context, appAddress, rpcClient, cryptoStore, {
        ...opts,
        persistenceStoreName: persistenceDbName,
    }) as TestClient
    client.wallet = context.wallet
    client.deviceId = deviceId
    return client
}

export async function setupWalletsAndContexts() {
    const baseConfig = townsEnv().makeBaseChainConfig()

    const [alicesWallet, bobsWallet, carolsWallet] = [
        ethers.Wallet.createRandom(),
        ethers.Wallet.createRandom(),
        ethers.Wallet.createRandom(),
    ]

    const [alicesContext, bobsContext, carolsContext] = await Promise.all([
        makeUserContextFromWallet(alicesWallet),
        makeUserContextFromWallet(bobsWallet),
        makeUserContextFromWallet(carolsWallet),
    ])

    const aliceProvider = new LocalhostWeb3Provider(baseConfig.rpcUrl, alicesWallet)
    const bobProvider = new LocalhostWeb3Provider(baseConfig.rpcUrl, bobsWallet)
    const carolProvider = new LocalhostWeb3Provider(baseConfig.rpcUrl, carolsWallet)

    await Promise.all([
        aliceProvider.fundWallet(),
        bobProvider.fundWallet(),
        carolProvider.fundWallet(),
    ])

    // create a user
    const [alice, bob, carol] = await Promise.all([
        makeTestClient({
            context: alicesContext,
            deviceId: 'alice',
        }),
        makeTestClient({
            context: bobsContext,
        }),
        makeTestClient({
            context: carolsContext,
        }),
    ])

    return {
        alice,
        bob,
        carol,
        alicesWallet,
        bobsWallet,
        carolsWallet,
        alicesContext,
        bobsContext,
        carolsContext,
        aliceProvider,
        bobProvider,
        carolProvider,
    }
}

class DonePromise {
    promise: Promise<string>
    // @ts-ignore: Promise body is executed immediately, so vars are assigned before constructor returns
    resolve: (value: string) => void
    // @ts-ignore: Promise body is executed immediately, so vars are assigned before constructor returns
    reject: (reason: any) => void

    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve
            this.reject = reject
        })
    }

    done(): void {
        this.resolve('done')
    }

    async wait(): Promise<string> {
        return this.promise
    }

    async expectToSucceed(): Promise<void> {
        await expect(this.promise).resolves.toBe('done')
    }

    async expectToFail(): Promise<void> {
        await expect(this.promise).rejects.toThrow()
    }

    run(fn: () => void): void {
        try {
            fn()
        } catch (err) {
            this.reject(err)
        }
    }

    runAndDone(fn: () => void): void {
        try {
            fn()
            this.done()
        } catch (err) {
            this.reject(err)
        }
    }
}

export const makeDonePromise = (): DonePromise => {
    return new DonePromise()
}

export const sendFlush = async (client: StreamRpcClient): Promise<void> => {
    const r = await client.info({ debug: ['flush_cache'] })
    check(r.graffiti === 'cache flushed')
}

export async function* iterableWrapper<T>(
    iterable: AsyncIterable<T>,
): AsyncGenerator<T, void, unknown> {
    const iterator = iterable[Symbol.asyncIterator]()

    while (true) {
        const result = await iterator.next()

        if (typeof result === 'string') {
            return
        }

        yield result.value
    }
}

// For example, use like this:
//
//    joinPayload = lastEventFiltered(
//        unpackStreamEnvelopes(userResponse.stream!),
//        getUserPayload_Membership,
//    )
//
// to get user membership payload from a last event containing it, or undefined if not found.
export const lastEventFiltered = <T extends (a: ParsedEvent) => any>(
    events: ParsedEvent[],
    f: T,
): ReturnType<T> | undefined => {
    let ret: ReturnType<T> | undefined = undefined
    forEachRight(events, (v): boolean => {
        const r = f(v)
        if (r !== undefined) {
            ret = r
            return false
        }
        return true
    })
    return ret
}

export const DefaultFreeAllocation = 1000

/// wait for a value, return the value if it is defined, otherwise throw an error or return undefined. false is a valid value.
export function waitForValue<T>(
    callback: () => T | undefined,
    options: { timeoutMS: number } = { timeoutMS: 10000 },
): Promise<T> {
    const tmpError = new Error('tmp')
    const timeoutContext: Error = new Error(
        'waitFor timed out after ' + options.timeoutMS.toString() + 'ms\n' + tmpError.stack,
    )
    return new Promise((resolve, reject) => {
        const timeoutMS = options.timeoutMS
        const pollIntervalMS = Math.min(timeoutMS / 2, 100)
        let lastError: any = undefined
        const intervalId = setInterval(checkCallback, pollIntervalMS)
        const timeoutId = setInterval(onTimeout, timeoutMS)
        function onDone(result: T | undefined) {
            clearInterval(intervalId)
            clearInterval(timeoutId)
            if (result) {
                resolve(result)
            } else {
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                reject(lastError)
            }
        }
        function onTimeout() {
            lastError = lastError ?? timeoutContext
            onDone(undefined)
        }
        function checkCallback() {
            try {
                const result = callback()
                if (result !== undefined) {
                    // if result is truthy, resolve
                    onDone(result)
                }
                // otherwise let the polling continue
            } catch (err: any) {
                lastError = err
            }
        }
    })
}

/// wait for the callback to not throw an error or return anything other than false (undefined is a valid value)
/// usage (preferred):
/// await waitFor(() => {
///     expect(true).toBe(true)
///     expect(myCounter.count).toBe(10)
/// })
/// usage (acceptable):
/// await waitFor(() => {
///     return myCounter.count > 9 // not preferred, but valid
/// })
/// usage (alternate):
/// const myValidValue = await waitFor(async () => {
///     const result = await myPromiseThatReturnsValueOrUndefinedOrError()
///     return result
/// })
export function waitFor<T extends void | boolean>(
    callback: (() => T) | (() => Promise<T>),
    options: { timeoutMS: number } = { timeoutMS: 10000 },
): Promise<T> {
    const tmpError = new Error('tmp')
    const timeoutContext: Error = new Error(
        'waitFor timed out after ' + options.timeoutMS.toString() + 'ms\n' + tmpError.stack,
    )
    return new Promise((resolve, reject) => {
        const timeoutMS = options.timeoutMS
        const pollIntervalMS = Math.min(timeoutMS / 2, 100)
        let timedOut = false
        let lastError: any = undefined
        let promiseStatus: 'none' | 'pending' | 'resolved' | 'rejected' = 'none'
        const intervalId = setInterval(checkCallback, pollIntervalMS)
        const timeoutId = setInterval(onTimeout, timeoutMS)
        function onDone(result?: T) {
            clearInterval(intervalId)
            clearInterval(timeoutId)
            if (result) {
                resolve(result)
            } else if (result === undefined && promiseStatus === 'resolved') {
                resolve(undefined as T)
            } else {
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                reject(lastError)
            }
        }
        function onTimeout() {
            lastError = lastError ?? timeoutContext
            timedOut = true
            onDone()
        }
        function checkCallback() {
            if (promiseStatus === 'pending') return
            try {
                const result = callback()
                if (result && result instanceof Promise) {
                    promiseStatus = 'pending'
                    result.then(
                        (res) => {
                            if (!timedOut) {
                                promiseStatus = 'resolved'
                                onDone(res)
                            }
                        },
                        (err) => {
                            promiseStatus = 'rejected'
                            lastError = err
                        },
                    )
                } else {
                    // explicitly check for false, most of these will return void
                    if (result !== false) {
                        promiseStatus = 'resolved'
                        // if result is truthy, resolve
                        onDone(result)
                    }
                    // otherwise let the polling continue
                }
            } catch (err: any) {
                lastError = err
            }
        }
    })
}

export async function waitForSyncStreams(
    syncStreams: AsyncIterable<SyncStreamsResponse>,
    matcher: (res: SyncStreamsResponse) => Promise<boolean>,
): Promise<SyncStreamsResponse> {
    for await (const res of iterableWrapper(syncStreams)) {
        if (await matcher(res)) {
            return res
        }
    }
    throw new Error('waitFor: timeout')
}

export async function waitForSyncStreamsMessage(
    syncStreams: AsyncIterable<SyncStreamsResponse>,
    message: string,
): Promise<SyncStreamsResponse> {
    return waitForSyncStreams(syncStreams, async (res) => {
        if (res.syncOp === SyncOp.SYNC_UPDATE) {
            const stream = res.stream
            if (stream) {
                const env = await unpackStreamEnvelopes(stream, undefined)
                for (const e of env) {
                    if (e.event.payload.case === 'gdmChannelPayload') {
                        const p = e.event.payload.value.content
                        if (p.case === 'message' && p.value.ciphertext === message) {
                            return true
                        }
                    }
                }
            }
        }
        return false
    })
}

export function getChannelMessagePayload(event?: ChannelMessage) {
    if (event?.payload?.case === 'post') {
        if (event.payload.value.content.case === 'text') {
            return event.payload.value.content.value?.body
        }
    }
    return undefined
}

export function getTimelineMessagePayload(event?: TimelineEvent) {
    if (event?.content?.kind === RiverTimelineEvent.ChannelMessage) {
        return event.content.body
    }
    return undefined
}

export function createEventDecryptedPromise(client: Client, expectedMessageText: string) {
    const recipientReceivesMessageWithoutError = makeDonePromise()
    client.on(
        'eventDecrypted',
        (streamId: string, contentKind: SnapshotCaseType, event: TimelineEvent): void => {
            recipientReceivesMessageWithoutError.runAndDone(() => {
                expect(event.content).toBeDefined()
                check(event.content?.kind === RiverTimelineEvent.ChannelMessage)
                expect(event.content.body).toEqual(expectedMessageText)
            })
        },
    )
    return recipientReceivesMessageWithoutError.promise
}

export function isValidEthAddress(address: string): boolean {
    const ethAddressRegex = /^(0x)?[0-9a-fA-F]{40}$/
    return ethAddressRegex.test(address)
}

// Type guard function based on field checks
export function isEncryptedData(obj: unknown): obj is EncryptedData {
    if (typeof obj !== 'object' || obj === null) {
        return false
    }

    const data = obj as EncryptedData
    return (
        typeof data.ciphertext === 'string' &&
        typeof data.algorithm === 'string' &&
        typeof data.senderKey === 'string' &&
        typeof data.sessionId === 'string' &&
        (typeof data.checksum === 'string' || data.checksum === undefined) &&
        (typeof data.refEventId === 'string' || data.refEventId === undefined)
    )
}

export const findMessageByText = (
    events: TimelineEvent[],
    text: string,
): TimelineEvent | undefined => {
    return events.find(
        (event) =>
            event.content?.kind === RiverTimelineEvent.ChannelMessage &&
            event.content.body === text,
    )
}

export function extractBlockchainTransactionTransferEvents(
    timeline: StreamTimelineEvent[],
): BlockchainTransaction_TokenTransfer[] {
    return timeline
        .map((e) => {
            if (
                e.remoteEvent?.event.payload.case === 'userPayload' &&
                e.remoteEvent?.event.payload.value.content.case === 'blockchainTransaction' &&
                e.remoteEvent?.event.payload.value.content.value.content.case === 'tokenTransfer'
            ) {
                return e.remoteEvent?.event.payload.value.content.value.content.value
            }
            return undefined
        })
        .filter(isDefined)
}

export function extractMemberBlockchainTransactions(
    client: Client,
    channelId: string,
): MemberTokenTransfer[] {
    const stream = client.streams.get(channelId)
    if (!stream) throw new Error('no stream found')
    return stream.view.getMembers().tokenTransfers
}
