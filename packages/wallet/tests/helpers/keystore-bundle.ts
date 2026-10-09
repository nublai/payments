import type { Hex } from 'viem'
import {
    createSessionKeystore,
    type EncryptedSecret,
    type KeystoreBundle,
    type LoginSessionKeystoreV2,
    type RelayerRootKeystoreV2,
    type RelayerSessionKeystoreV2,
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

    return {
        rootPath: '/tmp/alice.json',
        sessionPath: '/tmp/sessions/default.json',
        root: testRootKeystore({
            network,
            addresses: { root, delegated },
        }),
        session: testSessionKeystore(session, delegated, { network }),
    }
}

export function testRootKeystore(overrides?: Partial<RelayerRootKeystoreV2>): RelayerRootKeystoreV2 {
    const network = overrides?.network ?? testNetwork()

    const addresses = {
        root: overrides?.addresses?.root ?? '0x1111111111111111111111111111111111111111',
        delegated: overrides?.addresses?.delegated ?? overrides?.addresses?.root ?? '0x1111111111111111111111111111111111111111',
    }

    return {
        version: overrides?.version ?? 2,
        createdAt: overrides?.createdAt ?? '2026-01-01T00:00:00.000Z',
        checkpoint: overrides?.checkpoint ?? 'complete',
        network,
        addresses,
        sessionRef: {
            active: overrides?.sessionRef?.active ?? 'default',
            dir: overrides?.sessionRef?.dir ?? '/tmp/sessions',
        },
        kdf: overrides?.kdf ?? PLACEHOLDER_KDF,
        crypto: overrides?.crypto ?? { algorithm: 'aes-256-gcm' },
        secrets: overrides?.secrets ?? { rootPrivateKey: PLACEHOLDER_SECRET },
    }
}

/** Complete relayer session keystore. Tests that only read addresses/name can ignore the rest. */
export function testSessionKeystore(
    session = '0x3333333333333333333333333333333333333333',
    delegated = '0x1111111111111111111111111111111111111111',
    overrides?: Partial<RelayerSessionKeystoreV2>,
): RelayerSessionKeystoreV2 {
    const network = overrides?.network ?? testNetwork()

    return {
        version: overrides?.version ?? 2,
        createdAt: overrides?.createdAt ?? '2026-01-01T00:00:00.000Z',
        name: overrides?.name ?? 'default',
        checkpoint: overrides?.checkpoint ?? 'complete',
        network,
        kdf: overrides?.kdf ?? PLACEHOLDER_KDF,
        crypto: overrides?.crypto ?? { algorithm: 'aes-256-gcm' },
        addresses: {
            session: overrides?.addresses?.session ?? session,
            delegated: overrides?.addresses?.delegated ?? delegated,
        },
        secrets: overrides?.secrets ?? { sessionPrivateKey: PLACEHOLDER_SECRET },
    }
}

export function testLoginSessionKeystore(
    session = '0x3333333333333333333333333333333333333333',
    delegated = '0x1111111111111111111111111111111111111111',
    overrides?: Partial<Omit<LoginSessionKeystoreV2, 'kind'>>,
): LoginSessionKeystoreV2 {
    const base = testSessionKeystore(session, delegated, overrides)

    const login: LoginSessionKeystoreV2 = {
        ...base,
        kind: 'login',
        secrets: overrides?.secrets ?? { sessionPrivateKey: PLACEHOLDER_SECRET },
    }

    if (overrides?.delegateAuth !== undefined) {
        login.delegateAuth = overrides.delegateAuth
    }

    return login
}

/** Complete keystore bundle with optional root/session overlays. */
export function testKeystoreBundleFrom(
    root: Partial<RelayerRootKeystoreV2> = {},
    session: Partial<RelayerSessionKeystoreV2> = {},
    paths?: { rootPath?: string; sessionPath?: string },
): KeystoreBundle {
    const base = testKeystoreBundle(
        root.addresses?.root ?? '0x1111111111111111111111111111111111111111',
        session.addresses?.session ?? '0x3333333333333333333333333333333333333333',
        root.network?.chainId ?? session.network?.chainId ?? 8453,
        root.network?.env ?? session.network?.env ?? 'prod',
    )

    return {
        rootPath: paths?.rootPath ?? base.rootPath,
        sessionPath: paths?.sessionPath ?? base.sessionPath,
        root: testRootKeystore({ ...base.root, ...root }),
        session: testSessionKeystore(
            session.addresses?.session ?? base.session.addresses.session,
            session.addresses?.delegated ?? base.session.addresses.delegated,
            session,
        ),
    }
}

type RelayerCreateInput = {
    password: string
    sessionPrivateKey: Hex
    network: RelayerSessionKeystoreV2['network']
    delegated: string
    name?: string
    checkpoint?: RelayerSessionKeystoreV2['checkpoint']
    kind?: undefined
}

type LoginCreateInput = {
    password: string
    sessionPrivateKey: Hex
    network: RelayerSessionKeystoreV2['network']
    delegated: string
    name?: string
    checkpoint?: RelayerSessionKeystoreV2['checkpoint']
    kind: 'login'
    delegateAuth?: LoginSessionKeystoreV2['delegateAuth']
    bearerToken?: Hex
}

/**
 * Overloaded createSessionKeystore stand-in. Returns `session` for relayer
 * creates and a login fixture when `kind` is `'login'`.
 */
export function sessionKeystoreFactory(
    session: RelayerSessionKeystoreV2,
): typeof createSessionKeystore {
    async function create(input: RelayerCreateInput): Promise<RelayerSessionKeystoreV2>
    async function create(input: LoginCreateInput): Promise<LoginSessionKeystoreV2>
    async function create(input: RelayerCreateInput | LoginCreateInput): Promise<RelayerSessionKeystoreV2 | LoginSessionKeystoreV2> {
        if (input.kind === 'login') {
            return testLoginSessionKeystore(session.addresses.session, session.addresses.delegated, {
                name: input.name ?? session.name,
                network: input.network,
                checkpoint: input.checkpoint ?? 'initialized',
            })
        }

        return testSessionKeystore(session.addresses.session, session.addresses.delegated, {
            ...session,
            name: input.name ?? session.name,
            network: input.network ?? session.network,
            checkpoint: input.checkpoint ?? session.checkpoint,
        })
    }

    return create
}
