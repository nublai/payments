import { createClient } from '@towns-labs/rpc-connector/common'
import type { Client, ConnectTransportOptions } from '@towns-labs/rpc-connector/common'
import { ContactsService } from '@towns-labs/proto'
import { dlog } from '@towns-labs/utils'
import { getEnvVar, randomUrlSelector } from './utils'
import { RpcOptions } from './rpcCommon'
import { createHttp2ConnectTransport } from '@towns-labs/rpc-connector'
import {
    DEFAULT_RETRY_PARAMS,
    loggingInterceptor,
    retryInterceptor,
    setHeaderInterceptor,
} from './rpcInterceptors'

const logInfo = dlog('csb:rpc:info')

let nextRpcClientNum = 0

export type ContactsRpcClient = Client<typeof ContactsService> & { url: string }

export function makeContactsRpcClient(
    dest: string,
    sessionToken: string,
    opts?: RpcOptions,
): ContactsRpcClient {
    const transportId = nextRpcClientNum++
    const retryParams = opts?.retryParams ?? DEFAULT_RETRY_PARAMS
    const url = randomUrlSelector(dest)
    logInfo(
        'makeContactsRpcClient: Connecting to url=',
        url,
        ' allUrls=',
        dest,
        ' transportId =',
        transportId,
    )
    const options: ConnectTransportOptions = {
        baseUrl: url,
        interceptors: [
            ...(opts?.interceptors ?? []),
            setHeaderInterceptor({ Authorization: sessionToken }),
            loggingInterceptor(transportId, 'ContactsService'),
            retryInterceptor(retryParams),
        ],
        defaultTimeoutMs: undefined, // default timeout is undefined, we add a timeout in the retryInterceptor
    }
    if (getEnvVar('RIVER_DEBUG_TRANSPORT') !== 'true') {
        options.useBinaryFormat = true
    } else {
        logInfo('makeContactsRpcClient: running in debug mode, using JSON format')
        options.useBinaryFormat = false
        options.jsonOptions = {
            alwaysEmitImplicit: true,
            useProtoFieldName: true,
        }
    }
    const transport = createHttp2ConnectTransport(options)
    const client = createClient(ContactsService, transport) as ContactsRpcClient
    client.url = url
    return client
}
