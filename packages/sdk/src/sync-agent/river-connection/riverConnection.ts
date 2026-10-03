import { makeStreamRpcClient, StreamRpcClient } from '../../makeStreamRpcClient'
import { check, dlogger, shortenHexString } from '@towns-labs/utils'
import { PromiseQueue } from '../utils/promiseQueue'
import { CryptoStore, type EncryptionDeviceInitOpts } from '@towns-labs/encryption'
import { Client, ClientOptions } from '../../client'
import { SignerContext } from '../../signerContext'
import { streamIdAsBytes, userIdFromAddress } from '../../id'
import { Observable } from '../../observable/observable'
import { AuthStatus } from './models/authStatus'
import { expiryInterceptor, RetryParams } from '../../rpcInterceptors'
import { Stream } from '../../stream'
import { isDefined } from '../../check'
import { TownsConfig } from '../../townsEnv'
import { RpcOptions } from '../../rpcCommon'

export interface ClientParams {
    signerContext: SignerContext
    appAddress?: string
    cryptoStore: CryptoStore
    opts?: ClientOptions
    encryptionDevice?: EncryptionDeviceInitOpts
    onTokenExpired?: () => void
    rpcRetryParams?: RetryParams
}

export type OnStoppedFn = () => void
export type onClientStartedFn = (client: Client) => OnStoppedFn

class LoginContext {
    constructor(public cancelled: boolean = false) {}
}

export class RiverConnection {
    client?: Client
    authStatus = new Observable<AuthStatus>(AuthStatus.Initializing)
    rpcClientOpts: RpcOptions
    rpcClient: StreamRpcClient
    loginError?: Error
    private logger: ReturnType<typeof dlogger>
    private clientQueue = new PromiseQueue<Client>()
    private views: onClientStartedFn[] = []
    private tempViews: ((client: Client) => void)[] = []
    private onStoppedFns: OnStoppedFn[] = []
    private loginPromise?: { promise: Promise<void>; context: LoginContext }
    get signerContext(): SignerContext {
        return this.clientParams.signerContext
    }

    constructor(
        public townsConfig: TownsConfig,
        public clientParams: ClientParams,
    ) {
        const logId = this.clientParams.opts?.logId ?? shortenHexString(this.userId)
        this.logger = dlogger(`csb:rconn:${logId}`)
        this.rpcClientOpts = {
            retryParams: this.clientParams.rpcRetryParams,
            interceptors: [
                expiryInterceptor({
                    onTokenExpired: this.clientParams.onTokenExpired,
                }),
            ],
        }
        this.rpcClient = makeStreamRpcClient(
            this.townsConfig.services.node.url,
            undefined,
            this.rpcClientOpts,
        )
    }

    get userId(): string {
        return userIdFromAddress(this.clientParams.signerContext.creatorAddress)
    }
    async start() {
        await this.createStreamsClient()
        await this.login()
    }

    async stop() {
        for (const fn of this.onStoppedFns) {
            fn()
        }
        this.onStoppedFns = []
        if (this.loginPromise) {
            this.loginPromise.context.cancelled = true
        }
        await this.client?.stop()
        this.client = undefined
        this.authStatus.setValue(AuthStatus.Disconnected)
    }

    call<T>(fn: (client: Client) => Promise<T>): Promise<T> {
        if (this.client) {
            return fn(this.client)
        } else {
            // Enqueue the request if client is not available
            return this.clientQueue.enqueue(fn)
        }
    }

    withStream(streamId: string): {
        call: <T>(fn: (client: Client, stream: Stream) => Promise<T>) => Promise<T>
    } {
        return {
            call: (fn) => {
                return this.call(async (client) => {
                    const stream = await client.waitForStream(streamId)
                    return fn(client, stream)
                })
            },
        }
    }

    callWithStream<T>(streamId: string, fn: (client: Client, stream: Stream) => Promise<T>) {
        return this.withStream(streamId).call(fn)
    }

    registerView(viewFn: onClientStartedFn) {
        if (this.client) {
            const onStopFn = viewFn(this.client)
            this.onStoppedFns.push(onStopFn)
        }
        this.views.push(viewFn)
    }

    registerViewOnce(viewFn: (client: Client) => void) {
        if (this.client) {
            viewFn(this.client)
            return () => {}
        } else {
            this.tempViews.push(viewFn)
            return () => {
                this.tempViews = this.tempViews.filter((v) => v !== viewFn)
            }
        }
    }

    private async createStreamsClient(): Promise<void> {
        if (this.client !== undefined) {
            // this is wired up to be reactive to changes in the urls
            this.logger.log('RiverConnection: rpc urls changed, client already set')
            return
        }
        // create a new rpc client each time we start the client
        this.rpcClient = makeStreamRpcClient(
            this.townsConfig.services.node.url,
            undefined,
            this.rpcClientOpts,
        )
        const client = new Client(
            this.clientParams.signerContext,
            this.clientParams.appAddress,
            this.rpcClient,
            this.clientParams.cryptoStore,
            this.clientParams.opts,
        )
        client.setMaxListeners(100)
        this.client = client
        // initialize views
        this.logger.log('registering views', this.views.length)
        this.views.forEach((viewFn) => {
            this.logger.log('registering view', viewFn.name)
            const onStopFn = viewFn(client)
            this.onStoppedFns.push(onStopFn)
        })
        this.tempViews.forEach((viewFn) => {
            viewFn(client)
        })
        this.tempViews = []
    }

    async login() {
        this.logger.log('login')
        if (!this.client) {
            await this.createStreamsClient()
        }
        await this.loginWithRetries()
    }

    private async loginWithRetries() {
        check(isDefined(this.client), 'riverConnection::loginWithRetries client is not defined')
        this.logger.info('login', { authStatus: this.authStatus.value, promise: this.loginPromise })
        if (this.loginPromise) {
            this.loginPromise.context.cancelled = true
            await this.loginPromise.promise
        }
        if (this.authStatus.value === AuthStatus.ConnectedToRiver) {
            return
        }
        const loginContext = new LoginContext()
        this.authStatus.setValue(AuthStatus.EvaluatingCredentials)
        const login = async () => {
            let retryCount = 0
            const MAX_RETRY_COUNT = 20
            while (!loginContext.cancelled) {
                check(
                    isDefined(this.client),
                    'riverConnection::loginWithRetries client is not defined',
                )
                try {
                    this.logger.info('logging in')
                    this.authStatus.setValue(AuthStatus.ConnectingToRiver)
                    const client = this.client
                    await client.initializeUser({
                        encryptionDeviceInit: this.clientParams.encryptionDevice,
                    })
                    this.logger.info('user initialized')
                    client.startSync()
                    this.authStatus.setValue(AuthStatus.ConnectedToRiver)
                    // New rpcClient is available, resolve all queued requests
                    this.clientQueue.flush(client)
                    this.loginPromise = undefined

                    break
                } catch (err) {
                    retryCount++
                    this.loginError = err as Error
                    this.logger.error(
                        `encountered exception while initializing ${this.userId}`,
                        err,
                    )

                    for (const fn of this.onStoppedFns) {
                        fn()
                    }
                    this.onStoppedFns = []
                    await this.client.stop()
                    this.client = undefined
                    await this.createStreamsClient()

                    if (loginContext.cancelled) {
                        this.logger.info('login cancelled after error')
                        this.loginPromise = undefined
                        break
                    } else if (retryCount >= MAX_RETRY_COUNT) {
                        this.logger.info('login MAX_RETRY_COUNT reached')
                        this.authStatus.setValue(AuthStatus.Error)
                        this.loginPromise = undefined
                        throw err
                    } else {
                        const retryDelay = getRetryDelay(retryCount)
                        this.logger.info('retrying', { retryDelay, retryCount })
                        // sleep
                        await new Promise((resolve) => setTimeout(resolve, retryDelay))
                    }
                }
            }
        }
        this.loginPromise = { promise: login(), context: loginContext }
        return this.loginPromise.promise
    }

    /// note, can't be used with media streams
    async streamExists(streamId: string | Uint8Array): Promise<boolean> {
        const response = await this.rpcClient.getStream({
            streamId: streamIdAsBytes(streamId),
            optional: true,
        })
        return response?.stream !== undefined
    }
}

// exponentially back off, but never wait more than 20 seconds
function getRetryDelay(retryCount: number) {
    return Math.min(1000 * 2 ** retryCount, 20000)
}
