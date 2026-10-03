import { dlogger } from '@towns-labs/utils'
import { BASE_MAINNET, BASE_SEPOLIA } from './Web3Constants'

const log = dlogger('csb:XChainConfig')

export type XchainConfig = {
    supportedRpcUrls: { [chainId: number]: string }
    etherNativeNetworkIds: number[]
    ethereumNetworkIds: number[]
    skipFetchSetup?: boolean
}

export type XchainConfigOptions = {
    skipFetchSetup?: boolean
}

interface ParsedObject {
    [key: number]: string
}

const DEFAULT_XCHAIN_IDs = [1, 137, 42161, 10, 8453]

type BlockchainInfo = {
    chainId: number
    isEtherNative: boolean
    isEthereumNetwork: boolean
}

function isDefined<T>(value: T | undefined | null): value is T {
    return <T>value !== undefined && <T>value !== null
}

const DEFAULT_BLOCKCHAIN_INFO: { [chainId: number]: BlockchainInfo } = {
    1: { chainId: 1, isEtherNative: true, isEthereumNetwork: true },
    11155111: { chainId: 11155111, isEtherNative: true, isEthereumNetwork: true },
    137: { chainId: 137, isEtherNative: false, isEthereumNetwork: false },
    42161: { chainId: 42161, isEtherNative: true, isEthereumNetwork: false },
    10: { chainId: 10, isEtherNative: true, isEthereumNetwork: false },
    8453: { chainId: 8453, isEtherNative: true, isEthereumNetwork: false },
    84532: { chainId: 84532, isEtherNative: true, isEthereumNetwork: false },
    31337: { chainId: 31337, isEtherNative: true, isEthereumNetwork: false },
    31338: { chainId: 31338, isEtherNative: true, isEthereumNetwork: false },
    100: { chainId: 100, isEtherNative: false, isEthereumNetwork: false },
    10200: { chainId: 10200, isEtherNative: false, isEthereumNetwork: false },
}

export function getDefaultXChainIds(baseChainId: number): number[] {
    const ids = [...DEFAULT_XCHAIN_IDs]
    if (baseChainId !== BASE_MAINNET) {
        ids.push(BASE_SEPOLIA, 11155111)
    }
    return ids
}

const validateLog = dlogger('csb:validateAndParseXChainConfig')

export const validateAndParseXChainConfig = (input: string): ParsedObject => {
    const obj: ParsedObject = {}
    const urlPattern: RegExp = /^(http|https):\/\/[^\s/$.?#].[^\s]*$/
    const pairs: string[] = input.split(',')

    for (const pair of pairs) {
        const colonIndex = pair.indexOf(':')
        if (colonIndex === -1) {
            validateLog.warn(
                `Invalid XChain config pair: "${pair}". Each pair must be in the format key:url.`,
            )
            continue
        }
        const key = pair.substring(0, colonIndex)
        const value = pair.substring(colonIndex + 1)

        if (!key || !value) {
            validateLog.warn(
                `Invalid XChain config pair: "${pair}". Each pair must be in the format key:url.`,
            )
            continue
        }

        const keyNumber = Number(key)

        if (isNaN(keyNumber)) {
            validateLog.warn(`Invalid XChain config key: "${key}". Key must be a number.`)
            continue
        }

        if (!urlPattern.test(value)) {
            validateLog.warn(`Invalid XChain config URL: "${value}". Value must be a valid URL.`)
            continue
        }

        obj[keyNumber] = value
    }

    return obj
}

function marshallXChainConfig(
    supportedXChainIds: number[],
    supportedXChainRpcMapping: { [chainId: number]: string },
    chainInfo = DEFAULT_BLOCKCHAIN_INFO,
    options: XchainConfigOptions = {},
): XchainConfig {
    const filteredByRiverSupported = Object.entries(supportedXChainRpcMapping ?? {}).filter(
        ([_chainId, rpcUrl]) => isDefined(rpcUrl) && supportedXChainIds.includes(+_chainId),
    )

    if (supportedXChainIds.length !== filteredByRiverSupported.length) {
        log.warn('Some xchain rpc urls are missing from the supported xchains list')
    }

    const supportedRpcUrls = filteredByRiverSupported.reduce<{ [id: number]: string }>(
        (acc, kvpair) => {
            return {
                ...acc,
                [+kvpair[0]]: kvpair[1],
            }
        },
        {},
    )

    const etherNativeNetworkIds: number[] = Object.keys(supportedRpcUrls)
        .filter((key) => (+key) in chainInfo && chainInfo[+key].isEtherNative)
        .reduce<number[]>((acc, key) => [...acc, +key], [])

    const ethereumNetworkIds: number[] = Object.keys(supportedRpcUrls)
        .filter((key) => (+key) in chainInfo && chainInfo[+key].isEthereumNetwork)
        .reduce<number[]>((acc, key) => [...acc, +key], [])

    return {
        supportedRpcUrls,
        etherNativeNetworkIds,
        ethereumNetworkIds,
        skipFetchSetup: options.skipFetchSetup,
    }
}

export function getXchainConfig(
    baseChainId: number,
    supportedXChainRpcMapping: { [chainId: number]: string },
    options: XchainConfigOptions = {},
): XchainConfig {
    const xChainIds = getDefaultXChainIds(baseChainId)
    return marshallXChainConfig(
        xChainIds,
        supportedXChainRpcMapping,
        DEFAULT_BLOCKCHAIN_INFO,
        options,
    )
}
