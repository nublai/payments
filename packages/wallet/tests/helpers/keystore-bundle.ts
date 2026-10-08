import type {
    EncryptedSecret,
    KeystoreBundle,
    RelayerRootKeystoreV2,
    RelayerSessionKeystoreV2,
} from '../../src/lib/keystore'

const PLACEHOLDER_SECRET: EncryptedSecret = {
    nonce: '00',
    ciphertext: '00',
    tag: '00',
}

const PLACEHOLDER_KDF: RelayerRootKeystoreV2['kdf'] = {
    name: 'argon2id',
    params: {
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
        hashLength: 32,
        salt: '00',
    },
}

export function testNetwork(chainId = 8453, env = 'prod'): RelayerRootKeystoreV2['network'] {
    return {
        env,
        relayerUrl: 'http://127.0.0.1:8787',
        rpcUrl: chainId === 8453 ? 'https://mainnet.base.org' : 'http://127.0.0.1:8545',
        chainId,
    }
}

/** Complete keystore bundle. Tests that only read addresses/network can ignore the rest. */
export function testKeystoreBundle(
    root = '0x1111111111111111111111111111111111111111',
    session = '0x3333333333333333333333333333333333333333',
    chainId = 8453,
    env = 'prod',
): KeystoreBundle {
    const delegated = root
    const network = testNetwork(chainId, env)

    const rootStore: RelayerRootKeystoreV2 = {
        version: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        checkpoint: 'complete',
        network,
        addresses: { root, delegated },
        sessionRef: { active: 'default', dir: '/tmp/sessions' },
        kdf: PLACEHOLDER_KDF,
        crypto: { algorithm: 'aes-256-gcm' },
        secrets: { rootPrivateKey: PLACEHOLDER_SECRET },
    }

    const sessionStore: RelayerSessionKeystoreV2 = {
        version: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        name: 'default',
        checkpoint: 'complete',
        network,
        kdf: PLACEHOLDER_KDF,
        crypto: { algorithm: 'aes-256-gcm' },
        addresses: { session, delegated },
        secrets: { sessionPrivateKey: PLACEHOLDER_SECRET },
    }

    return {
        rootPath: '/tmp/alice.json',
        sessionPath: '/tmp/sessions/default.json',
        root: rootStore,
        session: sessionStore,
    }
}
