import type { Address, Hex, PublicClient } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { encodeAbiParameters } from 'viem'
import type { RelayerActions } from '@towns-labs/relayer-client'
import { makeSignerContextFromViem, type SignerContext } from './signerContext'
import { makeStreamRpcClient } from './makeStreamRpcClient'
import { RiverDbManager } from './riverDbManager'
import { makeAppPrivateData } from './id'
import { townsEnv, type TownsConfig } from './townsEnv'
import { Client } from './client'
import { AppRegistryService } from './appRegistryService'
import { bin_fromHexString, bin_toBase64, bin_toHexString } from '@towns-labs/utils'
import type { AppMetadata, PlainMessage } from '@towns-labs/proto'
export interface CreateAppParams {
    /** Owner signer context for app registry authentication */
    owner: SignerContext
    /** App metadata for registration in the app registry */
    metadata: Pick<PlainMessage<AppMetadata>, 'username' | 'displayName' | 'description'> &
        Partial<PlainMessage<AppMetadata>>
    /** Relayer client to create the app account */
    relayerClient: PublicClient & RelayerActions
    /** Contract address for the account proxy (delegation target) Can be obtained from contract deployments: `getAddresses(env, chainId)?.accountProxy` */
    accountProxy: Address
    /** Towns environment configuration Can be created with `townsEnv().makeTownsConfig()` or provided directly */
    townsConfig?: TownsConfig
    /** Optional private key for the bot account If not provided, a new random key will be generated */
    botPrivateKey?: Hex
}

export interface CreateAppResult {
    /** The app address (smart account address) for the app */
    appAddress: Address
    /** The private key for the app account Store this securely if you didn't provide your own */
    appPrivateKey: Hex
    /** The encoded app private data string Use this with `makeTownsApp()` from `@towns-labs/app-framework` */
    appPrivateData: string
    /** HS256 shared secret (base64-encoded) for webhook JWT verification */
    jwtSecretBase64: string
}

export async function createApp(params: CreateAppParams): Promise<CreateAppResult> {
    const {
        owner,
        metadata,
        relayerClient,
        accountProxy,
        botPrivateKey: providedPrivateKey,
    } = params
    const townsConfig = params.townsConfig ?? townsEnv().makeTownsConfig()

    const appOwnerAddress: Address = `0x${bin_toHexString(owner.creatorAddress)}`
    const appPrivateKey = providedPrivateKey ?? generatePrivateKey()
    const appAccount = privateKeyToAccount(appPrivateKey)

    const encodedSuperAdminKey = encodeAbiParameters([{ type: 'address' }], [appOwnerAddress])
    const { accountAddress, txHash, success, error } = await relayerClient.upgradeAccount({
        accountAddress: appAccount.address,
        signerKey: appPrivateKey,
        delegation: accountProxy,
        authorizeKeys: [
            {
                expiry: '0', // No expiry
                type: 'secp256k1',
                role: 'admin',
                publicKey: encodedSuperAdminKey,
                permissions: [],
            },
        ],
    })

    if (!success || !accountAddress) {
        throw new Error(`Failed to create bot account: ${error ?? 'Unknown error'}`)
    }

    if (txHash) {
        const receipt = await relayerClient.waitForTransactionReceipt({ hash: txHash })
        if (receipt.status !== 'success') {
            throw new Error(`Delegation transaction reverted: ${txHash}`)
        }
    }

    const delegatePrivateKey = generatePrivateKey()
    const signerContext = await makeSignerContextFromViem(appAccount, delegatePrivateKey)

    const rpcClient = makeStreamRpcClient(townsConfig.services.node.url)
    const cryptoStore = RiverDbManager.getCryptoDb(accountAddress)
    const botClient = new Client(signerContext, accountAddress, rpcClient, cryptoStore)
    try {
        await botClient.initializeUser({
            appOwnerAddress,
            skipSync: true,
        })
        await botClient.uploadDeviceKeys()
        const exportedDevice = await botClient.cryptoBackend?.exportDevice()
        if (!exportedDevice) {
            throw new Error('Failed to export encryption device')
        }
        const appRegistryUrl = townsConfig.services.appRegistry.url
        const { appRegistryRpcClient } = await AppRegistryService.authenticate(
            owner,
            appRegistryUrl,
        )
        const streamMetadataUrl = townsConfig.services.streamMetadata.url
        const defaultImageUrl = `${streamMetadataUrl}/user/${accountAddress}/image`
        const imageUrl = metadata.imageUrl ?? defaultImageUrl

        const { hs256SharedSecret } = await appRegistryRpcClient.register({
            appId: bin_fromHexString(accountAddress),
            appOwnerId: bin_fromHexString(appOwnerAddress),
            metadata: {
                username: metadata.username,
                displayName: metadata.displayName,
                description: metadata.description,
                imageUrl,
                slashCommands: metadata.slashCommands ?? [],
            },
        })
        const jwtSecretBase64 = bin_toBase64(hs256SharedSecret)

        const appPrivateData = makeAppPrivateData(
            appPrivateKey,
            exportedDevice,
            townsConfig.environmentId,
            accountAddress,
            hs256SharedSecret,
        )

        return {
            appAddress: accountAddress,
            appPrivateKey,
            appPrivateData,
            jwtSecretBase64,
        }
    } finally {
        await botClient.stop()
    }
}
