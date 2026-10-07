import { env } from 'cloudflare:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { getAddress, type Address, type Hex } from 'viem'

import { runWithAuthIdentity } from '../../src/auth/identity'
import { walletBindPersonalMessage } from '../../src/auth/wallet-bind'
import { bindAccount } from '../../src/rpc/methods/bindAccount'
import { issueBindNonce } from '../../src/rpc/methods/issueBindNonce'
import { RpcError, INVALID_SIGNATURE, NONCE_ERROR, INVALID_PARAMS } from '../../src/rpc/errors'
import type { Env } from '../../src/types/env'

const ISSUER = 'https://bind-rpc.example'
const SUBJECT = 'bind-user'
const NOW = 1_700_000_000

function testEnv(): Env {
    const base = env as unknown as Env
    return {
        ...base,
        CHAIN_IDS: '31337',
        CONTEXT: 'local',
        RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
        WALLET_BINDING: base.WALLET_BINDING,
    }
}

describe('wallet bind RPC', () => {
    it('issues a nonce and accepts an EIP-712 signature from that wallet', async () => {
        const account = privateKeyToAccount(generatePrivateKey())
        const issued = await runWithAuthIdentity(
            { provider: 'oidc', userId: SUBJECT, issuer: ISSUER },
            () =>
                issueBindNonce(
                    { address: account.address, chainId: '0x7a69' },
                    testEnv(),
                    NOW,
                ),
        )

        expect(issued.sub).toBe(SUBJECT)
        expect(issued.message.startsWith(`Bind address ${account.address} to sub ${SUBJECT}`)).toBe(
            true,
        )
        expect(issued.typedData.domain).toMatchObject({ name: 'Towns Relayer', chainId: 31337 })

        const signature = await account.signTypedData({
            domain: issued.typedData.domain,
            types: issued.typedData.types,
            primaryType: 'WalletBind',
            message: {
                account: account.address,
                issuer: ISSUER,
                sub: SUBJECT,
                nonce: issued.nonce,
                expiry: BigInt(issued.expiry),
            },
        })

        const bound = await runWithAuthIdentity(
            { provider: 'oidc', userId: SUBJECT, issuer: ISSUER },
            () =>
                bindAccount(
                    {
                        address: account.address,
                        chainId: '0x7a69',
                        nonce: issued.nonce,
                        expiry: issued.expiry,
                        signature,
                    },
                    testEnv(),
                    NOW,
                ),
        )
        expect(bound).toEqual({ address: getAddress(account.address), issuer: ISSUER, sub: SUBJECT })
    })

    it('accepts an EIP-191 signature and refuses a bad signature without burning the nonce', async () => {
        const account = privateKeyToAccount(generatePrivateKey())
        const other = privateKeyToAccount(generatePrivateKey())
        const issued = await runWithAuthIdentity(
            { provider: 'oidc', userId: `${SUBJECT}-191`, issuer: ISSUER },
            () =>
                issueBindNonce(
                    { address: account.address, chainId: '0x7a69' },
                    testEnv(),
                    NOW,
                ),
        )

        const bad = await other.signMessage({ message: issued.message })
        await expect(
            runWithAuthIdentity({ provider: 'oidc', userId: `${SUBJECT}-191`, issuer: ISSUER }, () =>
                bindAccount(
                    {
                        address: account.address,
                        chainId: '0x7a69',
                        nonce: issued.nonce,
                        expiry: issued.expiry,
                        signature: bad,
                        scheme: 'eip191',
                    },
                    testEnv(),
                    NOW,
                ),
            ),
        ).rejects.toMatchObject({ code: INVALID_SIGNATURE })

        const signature = await account.signMessage({
            message: walletBindPersonalMessage({
                account: account.address,
                issuer: ISSUER,
                sub: `${SUBJECT}-191`,
                nonce: issued.nonce,
                chainId: 31337,
                expiry: issued.expiry,
            }),
        })
        const bound = await runWithAuthIdentity(
            { provider: 'oidc', userId: `${SUBJECT}-191`, issuer: ISSUER },
            () =>
                bindAccount(
                    {
                        address: account.address,
                        chainId: '0x7a69',
                        nonce: issued.nonce,
                        expiry: issued.expiry,
                        signature,
                        scheme: 'eip191',
                    },
                    testEnv(),
                    NOW,
                ),
        )
        expect(bound.address).toBe(getAddress(account.address))
        expect(issued.message).toBe(
            walletBindPersonalMessage({
                account: account.address,
                issuer: ISSUER,
                sub: `${SUBJECT}-191`,
                nonce: issued.nonce,
                chainId: 31337,
                expiry: issued.expiry,
            }),
        )
    })

    it('refuses a second sub and an expired nonce at the RPC boundary', async () => {
        const account = privateKeyToAccount(generatePrivateKey())
        const owner = { provider: 'oidc', userId: `${SUBJECT}-owner`, issuer: ISSUER }
        const other = { provider: 'oidc', userId: `${SUBJECT}-other`, issuer: ISSUER }
        const issued = await runWithAuthIdentity(owner, () =>
            issueBindNonce({ address: account.address, chainId: '0x7a69' }, testEnv(), NOW),
        )
        const signature = await signBind(account, issued.nonce, issued.expiry, owner.userId)
        await runWithAuthIdentity(owner, () =>
            bindAccount(
                {
                    address: account.address,
                    chainId: '0x7a69',
                    nonce: issued.nonce,
                    expiry: issued.expiry,
                    signature,
                },
                testEnv(),
                NOW,
            ),
        )

        await expect(
            runWithAuthIdentity(other, () =>
                issueBindNonce({ address: account.address, chainId: '0x7a69' }, testEnv(), NOW),
            ),
        ).rejects.toMatchObject({ code: INVALID_PARAMS })

        const expiringAccount = privateKeyToAccount(generatePrivateKey())
        const expiring = await runWithAuthIdentity(owner, () =>
            issueBindNonce({ address: expiringAccount.address, chainId: '0x7a69' }, testEnv(), NOW),
        )
        const expiringSignature = await signBind(
            expiringAccount,
            expiring.nonce,
            expiring.expiry,
            owner.userId,
        )
        await expect(
            runWithAuthIdentity(owner, () =>
                bindAccount(
                    {
                        address: expiringAccount.address,
                        chainId: '0x7a69',
                        nonce: expiring.nonce,
                        expiry: expiring.expiry,
                        signature: expiringSignature,
                    },
                    testEnv(),
                    expiring.expiry,
                ),
            ),
        ).rejects.toMatchObject({ code: NONCE_ERROR })
    })

    it('refuses a caller that is not an OIDC identity', async () => {
        const account = privateKeyToAccount(generatePrivateKey())
        await expect(
            runWithAuthIdentity({ provider: 'privy', userId: 'did:privy:abc' }, () =>
                issueBindNonce({ address: account.address, chainId: '0x7a69' }, testEnv(), NOW),
            ),
        ).rejects.toBeInstanceOf(RpcError)
    })
})

async function signBind(
    account: ReturnType<typeof privateKeyToAccount>,
    nonce: string,
    expiry: number,
    sub: string,
): Promise<Hex> {
    return account.signTypedData({
        domain: { name: 'Towns Relayer', version: '1', chainId: 31337 },
        types: {
            WalletBind: [
                { name: 'account', type: 'address' },
                { name: 'issuer', type: 'string' },
                { name: 'sub', type: 'string' },
                { name: 'nonce', type: 'string' },
                { name: 'expiry', type: 'uint256' },
            ],
        },
        primaryType: 'WalletBind',
        message: {
            account: account.address as Address,
            issuer: ISSUER,
            sub,
            nonce,
            expiry: BigInt(expiry),
        },
    })
}
