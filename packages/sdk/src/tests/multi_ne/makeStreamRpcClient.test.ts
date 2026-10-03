/**
 * @group main
 */

import { Err, InfoRequestSchema, InfoResponse } from '@towns-labs/proto'
import { makeTestRpcClient } from '../testUtils'
import { DEFAULT_RETRY_PARAMS, errorContains } from '../../rpcInterceptors'
import { TownsConfig, townsEnv } from '../../townsEnv'
import { create } from '@bufbuild/protobuf'
import { makeStreamRpcClient } from '../../makeStreamRpcClient'

describe('protocol 1', () => {
    test('info using makeStreamRpcClient', async () => {
        const client = await makeTestRpcClient()
        expect(client).toBeDefined()

        const response: InfoResponse = await client.info(create(InfoRequestSchema, {}), {
            timeoutMs: 10000,
        })
        expect(response).toBeDefined()
        expect(response.graffiti).toEqual('River Node welcomes you!')
    })

    test('info-error using makeStreamRpcClient', async () => {
        const client = await makeTestRpcClient()
        expect(client).toBeDefined()

        try {
            await client.info(create(InfoRequestSchema, { debug: ['error'] }))
            expect(true).toBe(false)
        } catch (err) {
            expect(errorContains(err, Err.DEBUG_ERROR)).toBe(true)
        }
    })

    test('timeout using makeStreamRpcClient', async () => {
        // model some interesting behavior
        // see two retires time out locally in the retryInterceptor
        // and a third retry that times out when the global timeout passed to the .info request is reached
        const client = await makeTestRpcClient({
            retryParams: {
                ...DEFAULT_RETRY_PARAMS,
                initialRetryDelay: 10,
                maxRetryDelay: 30,
                defaultTimeoutMs: 1000,
            },
        })
        expect(client).toBeDefined()

        await client.info(create(InfoRequestSchema, { debug: ['ping'] }))

        await expect(
            client.info(create(InfoRequestSchema, { debug: ['sleep'] }), { timeoutMs: 2500 }),
        ).rejects.toThrow()
    })

    describe('protocol 2', () => {
        let townsConfig: TownsConfig

        beforeAll(async () => {
            townsConfig = townsEnv().makeTownsConfig()
        })

        test('services urls match', () => {
            expect(townsConfig.services.node.url).toBe(townsEnv().getNodeUrl())
            expect(townsConfig.services.notifications.url).toBe(
                townsEnv().getNotificationServiceUrl(),
            )
            expect(townsConfig.services.contacts.url).toBe(townsEnv().getContactsServiceUrl())
            expect(townsConfig.services.appRegistry.url).toBe(townsEnv().getAppRegistryUrl())
            expect(townsConfig.services.streamMetadata.url).toBe(townsEnv().getStreamMetadataUrl())
        })

        test('info using makeStreamRpcClient', async () => {
            const client = makeStreamRpcClient(townsConfig.services.node.url)
            expect(client).toBeDefined()

            const response: InfoResponse = await client.info(create(InfoRequestSchema, {}), {
                timeoutMs: 10000,
            })
            expect(response).toBeDefined()
            expect(response.graffiti).toEqual('River Node welcomes you!')
        })

        test('info-error using makeStreamRpcClient', async () => {
            const client = makeStreamRpcClient(townsConfig.services.node.url)
            expect(client).toBeDefined()

            try {
                await client.info(create(InfoRequestSchema, { debug: ['error'] }))
                expect(true).toBe(false)
            } catch (err) {
                expect(errorContains(err, Err.DEBUG_ERROR)).toBe(true)
            }
        })
    })
})
