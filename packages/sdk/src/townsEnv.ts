import { BaseChainConfig, RiverChainConfig, web3Env } from '@towns-labs/web3'
import { safeEnv, safeEnvEx, SafeEnvOpts } from '@towns-labs/utils'

export enum TownsService {
    Notifications,
    Contacts,
    AppRegistry,
    StreamMetadata,
    Node,
    Relayer,
}

export type TownsConfig = {
    environmentId: string
    base: { rpcUrl: string; chainConfig: BaseChainConfig }
    river: { rpcUrl: string; chainConfig: RiverChainConfig }
    services: {
        notifications: { url: string }
        contacts: { url: string }
        appRegistry: { url: string }
        streamMetadata: { url: string }
        node: { url: string }
        relayer: { url: string }
    }
}

export interface ITownsEnv {
    getEnvironmentId: () => string
    getEnvironmentIds: () => string[]
    getEnvironments: () => TownsConfig[]
    makeTownsConfig: (environmentId?: string) => TownsConfig
    makeBaseChainConfig: (environmentId?: string) => TownsConfig['base']
    makeRiverChainConfig: (environmentId?: string) => TownsConfig['river']
    getNotificationServiceUrl: (environmentId?: string) => string
    getContactsServiceUrl: (environmentId?: string) => string
    getAppRegistryUrl: (environmentId?: string) => string
    getStreamMetadataUrl: (environmentId?: string) => string
    getNodeUrl: (environmentId?: string) => string
    getRelayerUrl: (environmentId?: string) => string
}

// we have multiple keys for the same value for backwards compatibility, priority is left to right
const envKey: Record<string, string[]> = {
    BASE_SEPOLIA_RPC_URL: ['BASE_SEPOLIA_RPC_URL', 'BASE_CHAIN_RPC_URL'],
    BASE_MAINNET_RPC_URL: ['BASE_MAINNET_RPC_URL', 'BASE_CHAIN_RPC_URL'],
    RIVER_DEVNET_RPC_URL: ['RIVER_DEVNET_RPC_URL', 'RIVER_CHAIN_RPC_URL'],
    RIVER_MAINNET_RPC_URL: ['RIVER_MAINNET_RPC_URL', 'RIVER_CHAIN_RPC_URL'],
    NOTIFICATION_SERVICE_URL: ['NOTIFICATION_SERVICE_URL'],
    CONTACTS_SERVICE_URL: ['CONTACTS_SERVICE_URL'],
    STREAM_METADATA_URL: ['STREAM_METADATA_URL'],
    APP_REGISTRY_URL: ['APP_REGISTRY_URL'],
    RELAYER_URL: ['RELAYER_URL'],
}

function getBaseRpcUrlForChain(chainId: number, opts: SafeEnvOpts | undefined): string {
    switch (chainId) {
        case 31337:
            return 'http://localhost:8545'
        case 84532: {
            return safeEnvEx({
                keys: envKey.BASE_SEPOLIA_RPC_URL,
                opts,
                warning:
                    'neither BASE_SEPOLIA_RPC_URL nor VITE_BASE_SEPOLIA_RPC_URL is defined, using sepolia.base.org',
                defaultValue: 'https://sepolia.base.org',
            })
        }
        case 8453: {
            return safeEnvEx({
                keys: envKey.BASE_MAINNET_RPC_URL,
                opts,
                warning:
                    'neither BASE_MAINNET_RPC_URL nor VITE_BASE_MAINNET_RPC_URL is defined, using mainnet.base.org',
                defaultValue: 'https://mainnet.base.org',
            })
        }
        default:
            throw new Error(`No preset RPC url for base chainId ${chainId}`)
    }
}

function getRiverRpcUrlForChain(chainId: number, opts: SafeEnvOpts | undefined): string {
    switch (chainId) {
        case 31338:
            return 'http://localhost:8546'
        case 6524490:
            return safeEnvEx({
                keys: envKey.RIVER_DEVNET_RPC_URL,
                opts,
                defaultValue: 'https://devnet.rpc.river.build',
            })
        case 550:
            return safeEnvEx({
                keys: envKey.RIVER_MAINNET_RPC_URL,
                opts,
                defaultValue: 'https://mainnet.rpc.river.build',
            })
        default:
            throw new Error(`No preset RPC url for river chainId ${chainId}`)
    }
}

export function townsEnv(opts?: SafeEnvOpts): ITownsEnv {
    const web3 = web3Env(opts)

    const getEnvironmentId = (): string => {
        const riverEnv = web3.riverEnv
        if (!riverEnv) {
            throw new Error(
                'either RIVER_ENV or VITE_RIVER_ENV is required to be set in process.env',
            )
        }
        return riverEnv
    }

    const getNotificationServiceUrl = (inEnvironmentId?: string): string => {
        const environmentId = inEnvironmentId ?? getEnvironmentId()
        // check for override
        if (environmentId === web3.riverEnv) {
            const url = safeEnv(envKey.NOTIFICATION_SERVICE_URL, opts)
            if (url) {
                return url
            }
        }
        switch (environmentId) {
            case 'local_dev':
                return 'https://localhost:5170'
            case 'alpha':
                return 'https://river-notification-service-alpha.towns.com'
            case 'beta':
                return 'https://river-notification-service-beta.towns.com'
            case 'delta':
                return 'https://river-notification-service-delta.towns.com'
            case 'omega':
                return 'https://river-notification-service-omega.towns.com'
            case 'stage':
                return 'https://river-notification-service-stage.towns.com'
            case 'prod':
                return 'https://river-notification-service-prod.towns.com'
            default:
                throw new Error(`No notification service url for environmentId ${environmentId}`)
        }
    }

    const getContactsServiceUrl = (inEnvironmentId?: string): string => {
        const environmentId = inEnvironmentId ?? getEnvironmentId()
        // check for override
        if (environmentId === web3.riverEnv) {
            const url = safeEnv(envKey.CONTACTS_SERVICE_URL, opts)
            if (url) {
                return url
            }
        }
        switch (environmentId) {
            case 'local_dev':
                return 'https://localhost:5170'
            case 'alpha':
                return 'https://river1.nodes.alpha.towns.com/'
            case 'beta':
                return 'https://river1.nodes.beta.towns.com/'
            case 'delta':
                return 'https://river1.nodes.delta.towns.com/'
            case 'omega':
                return 'https://river1.nodes.omega.towns.com/'
            case 'stage':
                return 'https://chat1.nodes.staging.towns.com'
            case 'prod':
                return 'https://chat1.nodes.prod.towns.com'
            default:
                throw new Error(`No contacts service url for environmentId ${environmentId}`)
        }
    }

    const getStreamMetadataUrl = (inEnvironmentId?: string): string => {
        const environmentId = inEnvironmentId ?? getEnvironmentId()
        // check for override
        if (environmentId === web3.riverEnv) {
            const url = safeEnv(envKey.STREAM_METADATA_URL, opts)
            if (url) {
                return url
            }
        }
        switch (environmentId) {
            case 'local_dev':
                return 'http://localhost:3002'
            case 'alpha':
                return 'https://alpha.river.delivery'
            case 'beta':
                return 'https://beta.river.delivery'
            case 'delta':
                return 'https://delta.river.delivery'
            case 'omega':
                return 'https://river.delivery'
            case 'stage':
                return 'https://stage.river.delivery'
            case 'prod':
                return 'https://prod.river.delivery'
            default:
                throw new Error(`No stream metadata url for environmentId ${environmentId}`)
        }
    }

    const getAppRegistryUrl = (inEnvironmentId?: string): string => {
        const environmentId = inEnvironmentId ?? getEnvironmentId()
        // check for override
        if (environmentId === web3.riverEnv) {
            const url = safeEnv(envKey.APP_REGISTRY_URL, opts)
            if (url) {
                return url
            }
        }
        switch (environmentId) {
            case 'local_dev':
                return 'https://localhost:5170'
            case 'alpha':
                return 'https://app-registry.alpha.towns.com'
            case 'beta':
                return 'https://app-registry.beta.towns.com'
            case 'omega':
                return 'https://app-registry.omega.towns.com'
            case 'delta':
                return 'https://app-registry.delta.towns.com'
            case 'stage':
                return 'https://chat1.nodes.staging.towns.com'
            case 'prod':
                return 'https://chat1.nodes.prod.towns.com'
            default:
                throw new Error(`No app registry url for environmentId ${environmentId}`)
        }
    }

    const getNodeUrl = (inEnvironmentId?: string): string => {
        const environmentId = inEnvironmentId ?? getEnvironmentId()
        switch (environmentId) {
            case 'local_dev':
                return 'https://localhost:5170'
            case 'alpha':
                return 'https://river1.nodes.alpha.towns.com/'
            case 'beta':
                return 'https://river1.nodes.beta.towns.com/'
            case 'delta':
                return 'https://river1.nodes.delta.towns.com/'
            case 'omega':
                return 'https://river1.nodes.omega.towns.com/'
            case 'stage':
                return 'https://chat1.nodes.staging.towns.com'
            case 'prod':
                return 'https://chat1.nodes.prod.towns.com'
            default:
                throw new Error(`No node url for environmentId ${environmentId}`)
        }
    }

    const getRelayerUrl = (inEnvironmentId?: string): string => {
        const environmentId = inEnvironmentId ?? getEnvironmentId()
        // check for override
        if (environmentId === web3.riverEnv) {
            const url = safeEnv(envKey.RELAYER_URL, opts)
            if (url) {
                return url
            }
        }
        switch (environmentId) {
            case 'local_dev':
                return 'http://127.0.0.1:8787'
            case 'stage':
                return 'https://relayer-worker-stage.towns.com/'
            case 'prod':
                return 'https://relayer-worker.towns.com/'
            default:
                throw new Error(`No relayer url for environmentId ${environmentId}`)
        }
    }

    const makeRiverChainConfig = (environmentId?: string): TownsConfig['river'] => {
        const envId = environmentId ?? getEnvironmentId()
        const env = web3.getDeployment(envId)
        return {
            rpcUrl: getRiverRpcUrlForChain(env.river.chainId, opts),
            chainConfig: env.river,
        }
    }

    const makeBaseChainConfig = (environmentId?: string): TownsConfig['base'] => {
        const env = web3.getDeployment(environmentId ?? getEnvironmentId())
        return {
            rpcUrl: getBaseRpcUrlForChain(env.base.chainId, opts),
            chainConfig: env.base,
        }
    }

    /**
     * @param inEnvironmentId - Environment id to use. If not provided, will use the environment id from the process.env.RIVER_ENV or import.meta.env.VITE_RIVER_ENV.
     * @returns River config
     *
     * If RIVER_ENV is defined, you don't need to pass an enviromnetId here
     * If RIVER_ENV is one of the known deployments,
     * you don't need to set any additional environment variables
     */
    const makeTownsConfig = (inEnvironmentId?: string): TownsConfig => {
        const environmentId = inEnvironmentId ?? getEnvironmentId()
        try {
            const config = {
                environmentId,
                base: makeBaseChainConfig(environmentId),
                river: makeRiverChainConfig(environmentId),
                services: {
                    notifications: { url: getNotificationServiceUrl(environmentId) },
                    contacts: { url: getContactsServiceUrl(environmentId) },
                    appRegistry: { url: getAppRegistryUrl(environmentId) },
                    streamMetadata: { url: getStreamMetadataUrl(environmentId) },
                    node: { url: getNodeUrl(environmentId) },
                    relayer: { url: getRelayerUrl(environmentId) },
                },
            } satisfies TownsConfig
            return config
        } catch (error) {
            throw new Error(
                `couldn't load config for env: "${environmentId}" error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            )
        }
    }
    /**
     * @returns Available environment ids
     */
    const getEnvironmentIds = (): string[] => {
        return web3.getDeploymentIds()
    }

    /**
     * @returns Available environments
     */
    const getEnvironments = (): TownsConfig[] => {
        return web3.getDeploymentIds().map((id) => {
            return makeTownsConfig(id)
        })
    }

    return {
        getEnvironmentId,
        getEnvironmentIds,
        getEnvironments,
        makeTownsConfig,
        makeBaseChainConfig,
        makeRiverChainConfig,
        getNotificationServiceUrl,
        getContactsServiceUrl,
        getAppRegistryUrl,
        getStreamMetadataUrl,
        getNodeUrl,
        getRelayerUrl,
    }
}
