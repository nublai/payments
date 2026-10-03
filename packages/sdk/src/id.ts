import { utils } from 'ethers'
import { nanoid, customAlphabet } from 'nanoid'
import {
    bin_fromBase64,
    bin_fromHexString,
    bin_toBase64,
    bin_toHexString,
    check,
} from '@towns-labs/utils'
import {
    ethereumAddressAsBytes,
    ethereumAddressAsString,
    ethereumAddressFromBytes,
    ethereumAddressToBytes,
    isEthereumAddress,
} from './utils'
import { AppPrivateDataSchema, ExportedDevice } from '@towns-labs/proto'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import type { Address } from '@towns-labs/web3'

export const STREAM_ID_BYTES_LENGTH = 32
export const STREAM_ID_STRING_LENGTH = STREAM_ID_BYTES_LENGTH * 2

export const userIdFromAddress = (address: Uint8Array): Address =>
    utils.getAddress(bin_toHexString(address)) as Address

// Assuming `userId` is an Ethereum address in string format
export const userIdToAddress = (userId: string): Uint8Array => addressFromUserId(userId)

// Assuming `userId` is an Ethereum address in string format
export const addressFromUserId = (userId: string): Uint8Array => {
    // Validate and normalize the address to ensure it's properly checksummed.
    const normalizedAddress = utils.getAddress(userId)

    // Remove the '0x' prefix and convert the hex string to a Uint8Array
    const addressAsBytes = utils.arrayify(normalizedAddress)

    return addressAsBytes
}

export const addressToUserId = (address: Uint8Array): string => userIdFromAddress(address)

// User id is an Ethereum address.
export const streamIdToBytes = ethereumAddressToBytes
export const streamIdFromBytes = ethereumAddressFromBytes
export const streamIdAsString = ethereumAddressAsString
export const streamIdAsBytes = ethereumAddressAsBytes
export const isUserId = isEthereumAddress

// reason about data in logs, tests, etc.
export enum StreamPrefix {
    GDM = '77',
    Media = 'ff',
    User = 'a8',
    UserMetadata = 'ad',
    UserInbox = 'a1',
    UserSettings = 'a5',
}

const allowedStreamPrefixesVar = Object.values(StreamPrefix)
const TWENTY_TWO_ZEROS = '0000000000000000000000'

export const allowedStreamPrefixes = (): string[] => allowedStreamPrefixesVar

const expectedIdentityLenByPrefix: { [key in StreamPrefix]: number } = {
    [StreamPrefix.User]: 40,
    [StreamPrefix.UserMetadata]: 40,
    [StreamPrefix.UserSettings]: 40,
    [StreamPrefix.UserInbox]: 40,
    [StreamPrefix.Media]: 62,
    [StreamPrefix.GDM]: 62,
}

export const makeStreamId = (prefix: StreamPrefix, identity: string): string => {
    identity = identity.toLowerCase()
    if (identity.startsWith('0x')) {
        identity = identity.slice(2)
    }
    check(
        areValidStreamIdParts(prefix, identity),
        'Invalid stream id parts: ' + prefix + ' ' + identity,
    )
    return (prefix + identity).padEnd(STREAM_ID_STRING_LENGTH, '0')
}

export const makeUserStreamId = (userId: string | Uint8Array): string => {
    check(isUserId(userId), 'Invalid user id: ' + userId.toString())
    return makeStreamId(
        StreamPrefix.User,
        userId instanceof Uint8Array ? userIdFromAddress(userId) : userId,
    )
}

export const makeUserSettingsStreamId = (userId: string | Uint8Array): string => {
    check(isUserId(userId), 'Invalid user id: ' + userId.toString())
    return makeStreamId(
        StreamPrefix.UserSettings,
        userId instanceof Uint8Array ? userIdFromAddress(userId) : userId,
    )
}

export const makeUserMetadataStreamId = (userId: string | Uint8Array): string => {
    check(isUserId(userId), 'Invalid user id: ' + userId.toString())
    return makeStreamId(
        StreamPrefix.UserMetadata,
        userId instanceof Uint8Array ? userIdFromAddress(userId) : userId,
    )
}

export const makeUserInboxStreamId = (userId: string | Uint8Array): string => {
    check(isUserId(userId), 'Invalid user id: ' + userId.toString())
    return makeStreamId(
        StreamPrefix.UserInbox,
        userId instanceof Uint8Array ? userIdFromAddress(userId) : userId,
    )
}

export const makeUniqueGDMChannelStreamId = (): string => makeStreamId(StreamPrefix.GDM, genId())
export const makeUniqueMediaStreamId = (): string => makeStreamId(StreamPrefix.Media, genId())

export const isUserStreamId = (streamId: string | Uint8Array): boolean =>
    streamIdAsString(streamId).startsWith(StreamPrefix.User)
export const isUserDeviceStreamId = (streamId: string | Uint8Array): boolean =>
    streamIdAsString(streamId).startsWith(StreamPrefix.UserMetadata)
export const isUserSettingsStreamId = (streamId: string | Uint8Array): boolean =>
    streamIdAsString(streamId).startsWith(StreamPrefix.UserSettings)
export const isMediaStreamId = (streamId: string | Uint8Array): boolean =>
    streamIdAsString(streamId).startsWith(StreamPrefix.Media)
export const isGDMChannelStreamId = (streamId: string | Uint8Array): boolean =>
    streamIdAsString(streamId).startsWith(StreamPrefix.GDM)
export const isUserInboxStreamId = (streamId: string | Uint8Array): boolean =>
    streamIdAsString(streamId).startsWith(StreamPrefix.UserInbox)

export const getUserAddressFromStreamId = (streamId: string): Uint8Array => {
    const prefix = streamId.slice(0, 2) as StreamPrefix
    if (
        prefix !== StreamPrefix.User &&
        prefix !== StreamPrefix.UserMetadata &&
        prefix !== StreamPrefix.UserSettings &&
        prefix !== StreamPrefix.UserInbox
    ) {
        throw new Error('Invalid stream id: ' + streamId)
    }
    if (streamId.length != STREAM_ID_STRING_LENGTH || !isLowercaseHex(streamId)) {
        throw new Error('Invalid stream id format: ' + streamId)
    }
    const addressPart = streamId.slice(2, 42)
    const paddingPart = streamId.slice(42)
    if (paddingPart !== TWENTY_TWO_ZEROS) {
        throw new Error('Invalid stream id padding: ' + streamId)
    }
    return addressFromUserId('0x' + addressPart)
}

export const getUserIdFromStreamId = (streamId: string): string => {
    return userIdFromAddress(getUserAddressFromStreamId(streamId))
}

const areValidStreamIdParts = (prefix: StreamPrefix, identity: string): boolean => {
    if (!allowedStreamPrefixesVar.includes(prefix)) {
        return false
    }
    if (!/^[0-9a-f]*$/.test(identity)) {
        return false
    }
    if (identity.length != expectedIdentityLenByPrefix[prefix]) {
        // if we're not at expected length, we should have padding
        if (identity.length != 62) {
            return false
        }
        for (let i = expectedIdentityLenByPrefix[prefix]; i < identity.length; i++) {
            if (identity[i] !== '0') {
                return false
            }
        }
    }

    return true
}

export const isValidStreamId = (streamId: string): boolean => {
    return areValidStreamIdParts(streamId.slice(0, 2) as StreamPrefix, streamId.slice(2))
}

export const checkStreamId = (streamId: string): void => {
    check(isValidStreamId(streamId), 'Invalid stream id: ' + streamId)
}

const hexNanoId = customAlphabet('0123456789abcdef', 62)

export const genId = (size?: number): string => {
    return hexNanoId(size)
}

export const genShortId = (): string => {
    return nanoid(12)
}

export const genLocalId = (): string => {
    return '~' + nanoid(11)
}

export const genIdBlob = (): Uint8Array => bin_fromHexString(hexNanoId(32))

export const isLowercaseHex = (input: string): boolean => /^[0-9a-f]*$/.test(input)

const APP_PRIVATE_DATA_PREFIX = 'towns-app-'

export const makeAppPrivateData = (
    /** evm private key */
    privateKey: string,
    /** exported encryption device */
    exportedDevice: ExportedDevice,
    /** local_dev, stage, prod */
    env: string,
    /** app address: simple app or custom app contract address */
    appAddress: Address,
    /** jwt secret created at app registration time */
    jwtSecret?: Uint8Array,
) => {
    const appPrivateData = create(AppPrivateDataSchema, {
        privateKey,
        encryptionDevice: exportedDevice,
        env,
        appAddress: bin_fromHexString(appAddress),
        ...(jwtSecret && { jwtSecret }),
    })
    return `${APP_PRIVATE_DATA_PREFIX}${bin_toBase64(toBinary(AppPrivateDataSchema, appPrivateData))}`
}

export const parseAppPrivateData = (encoded: string) => {
    let appPrivateData = null
    const isNewFormat = encoded.startsWith(APP_PRIVATE_DATA_PREFIX)
    if (isNewFormat) {
        const [_, content] = encoded.split(APP_PRIVATE_DATA_PREFIX)
        appPrivateData = bin_fromBase64(content)
    } else {
        // Older format where the private key was base64 encoded without a prefix
        appPrivateData = bin_fromBase64(encoded)
    }
    const raw = fromBinary(AppPrivateDataSchema, appPrivateData)
    const hex_appAddress = bin_toHexString(raw.appAddress)
    return {
        ...raw,
        appAddress: hex_appAddress ? (utils.getAddress(hex_appAddress) as Address) : undefined,
        jwtSecret: raw.jwtSecret ? bin_toBase64(raw.jwtSecret) : undefined,
    }
}
