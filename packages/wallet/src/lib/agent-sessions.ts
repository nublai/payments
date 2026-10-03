import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { ExportedDeviceSchema, type ExportedDevice } from '@towns-labs/proto'
import {
    type AnySessionKeystore,
    decryptBufferSecret,
    deriveKeystoreKey,
    encryptBufferSecret,
    type AgentSessionKeystoreV2,
} from './keystore'

export type AgentNamedChannelRecord = NonNullable<AgentSessionKeystoreV2['namedChannels']>[string]

export async function decryptAgentDevice(
    keystore: AgentSessionKeystoreV2,
    password: string,
): Promise<ExportedDevice> {
    const key = await deriveKeystoreKey(password, keystore.kdf.params)
    try {
        const binary = decryptBufferSecret(keystore.secrets.encryptionDevice, key)
        return fromBinary(ExportedDeviceSchema, binary)
    } finally {
        key.fill(0)
    }
}

export async function finalizeAgentSessionKeystore(input: {
    baseKeystore: AnySessionKeystore
    password: string
    exportedDevice: ExportedDevice
    namedChannels?: Record<string, AgentNamedChannelRecord>
}): Promise<AgentSessionKeystoreV2> {
    const key = await deriveKeystoreKey(input.password, input.baseKeystore.kdf.params)
    try {
        const encryptionDevice = encryptBufferSecret(
            toBinary(ExportedDeviceSchema, input.exportedDevice),
            key,
        )
        return {
            ...input.baseKeystore,
            kind: 'agent',
            checkpoint: 'complete',
            secrets: {
                ...input.baseKeystore.secrets,
                encryptionDevice,
            },
            namedChannels: input.namedChannels,
        }
    } finally {
        key.fill(0)
    }
}
