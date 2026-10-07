import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, mock, test } from 'bun:test'
import {
    decodeAbiParameters,
    decodeFunctionData,
    parseAbiParameters,
    type Address,
    type Hex,
} from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import { computeKeyHash, encodeSecp256k1Key, type Permission } from '@nubl/relayer-client'
import { getDefaultSessionPermissions } from '../src/lib/account-create'
import {
    authorizeCalldataIsNormal,
    bareSessionAuthorizeKey,
    buildBareUpgrade,
    fullSessionAuthorizeKey,
    missingPermissionCalls,
    PAID_UPGRADE_GAS_HOLD,
    paidUpgradeMarkerPath,
    paidUpgradeRefusalUsesSponsoredPath,
    permissionsPendingMessage,
    quotedGasWithinHold,
    runFirstUpgrade,
    usdcBalanceTakesPaidPath,
    type InstalledPermission,
} from '../src/lib/first-upgrade'
import { computeSessionKeyHash } from '../src/lib/session-common'
import type { CliNetworkConfig } from '../src/lib/network-config'

const SESSION = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const ROOT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

const network: CliNetworkConfig = {
    env: 'prod',
    relayerUrl: 'http://127.0.0.1:8787',
    rpcUrl: 'http://127.0.0.1:8545',
    chainId: 8453,
}

function permissions(): Permission[] {
    return getDefaultSessionPermissions(8453, { env: 'prod' })
}

function keyHash(): Hex {
    return computeSessionKeyHash(SESSION)
}

test('the default session key is not authorized as admin or super-admin', () => {
    const key = bareSessionAuthorizeKey(SESSION)
    const built = buildBareUpgrade(ACCOUNT, SESSION)
    expect(key.role).toBe('normal')
    expect(key.expiry).toBe('0')
    expect(key.permissions).toEqual([])
    expect(built.calls).toHaveLength(1)
    expect(authorizeCalldataIsNormal(built.calls[0]!.data)).toBe(true)

    const decoded = decodeFunctionData({
        abi: accountAbi,
        data: built.calls[0]!.data,
    })
    expect(decoded.functionName).toBe('authorize')
    const args = decoded.args[0] as {
        isSuperAdmin: boolean
        expiry: number
        keyType: number
    }
    expect(args.isSuperAdmin).toBe(false)
    expect(args.expiry).toBe(0)
    expect(args.keyType).toBe(0)

    const hash = computeKeyHash('secp256k1', encodeSecp256k1Key(SESSION))
    expect(hash).not.toBe(`0x${'00'.repeat(32)}`)
    expect(keyHash()).toBe(hash)

    const admin = decodeFunctionData({
        abi: accountAbi,
        data: built.calls[0]!.data,
    })
    expect((admin.args[0] as { isSuperAdmin: boolean }).isSuperAdmin).toBe(false)
})

test('a paid first upgrade carries exactly one authorize and stays inside the 500k hold', () => {
    const built = buildBareUpgrade(ACCOUNT, SESSION)
    const decoded = decodeAbiParameters(
        parseAbiParameters('(address to, uint256 value, bytes data)[]'),
        built.executionData,
    )[0]
    expect(decoded).toHaveLength(1)
    const names = decoded.map(
        (call) => decodeFunctionData({ abi: accountAbi, data: call.data }).functionName,
    )
    expect(names).toEqual(['authorize'])
    expect(quotedGasWithinHold(464_630n)).toBe(true)
    expect(quotedGasWithinHold(PAID_UPGRADE_GAS_HOLD)).toBe(true)
    expect(quotedGasWithinHold(500_001n)).toBe(false)
    expect(quotedGasWithinHold(547_082n)).toBe(false)
    expect(quotedGasWithinHold(880_306n)).toBe(false)
    expect(quotedGasWithinHold(0n)).toBe(false)
})

test('USDC balance eligibility mirrors the relayer paid gate', () => {
    expect(usdcBalanceTakesPaidPath(0n)).toBe(false)
    expect(usdcBalanceTakesPaidPath(1n)).toBe(true)
    expect(paidUpgradeRefusalUsesSponsoredPath(new Error('Insufficient USDC balance'))).toBe(true)
    expect(
        paidUpgradeRefusalUsesSponsoredPath(
            new Error('Paid upgrade fee must be greater than zero'),
        ),
    ).toBe(true)
    expect(
        paidUpgradeRefusalUsesSponsoredPath(
            new Error('Paid upgrade gas limit exceeds the reserved hold'),
        ),
    ).toBe(true)
    expect(
        paidUpgradeRefusalUsesSponsoredPath(new Error('Paid upgrade paymentMaxAmount exceeds cap')),
    ).toBe(true)
    expect(paidUpgradeRefusalUsesSponsoredPath(new Error('Simulation failed'))).toBe(false)
})

test('permission install sends only the calls that are not on chain', () => {
    const hash = keyHash()
    const wanted = permissions()
    const none = missingPermissionCalls({
        account: ACCOUNT,
        keyHash: hash,
        permissions: wanted,
        installed: [],
    })
    expect(none).toHaveLength(7)
    const names = none.map(
        (call) => decodeFunctionData({ abi: accountAbi, data: call.data }).functionName,
    )
    expect(names.filter((name) => name === 'authorize')).toEqual([])
    expect(names.filter((name) => name === 'setCanExecute')).toHaveLength(6)
    expect(names.filter((name) => name === 'setSpendLimit')).toHaveLength(1)

    const installed: InstalledPermission[] = wanted
        .filter((permission) => permission.type === 'call')
        .slice(0, 2)
        .map((permission) =>
            permission.type === 'call'
                ? {
                      type: 'call' as const,
                      to: permission.to,
                      selector: permission.selector,
                  }
                : permission,
        )
    const partial = missingPermissionCalls({
        account: ACCOUNT,
        keyHash: hash,
        permissions: wanted,
        installed,
    })
    const partialNames = partial.map(
        (call) => decodeFunctionData({ abi: accountAbi, data: call.data }).functionName,
    )
    expect(partialNames.filter((name) => name === 'setCanExecute')).toHaveLength(4)
    expect(partialNames.filter((name) => name === 'setSpendLimit')).toHaveLength(1)

    const spendInstalled: InstalledPermission[] = [
        ...installed,
        {
            type: 'spend',
            token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            limit: '10000000',
            period: 'day',
        },
    ]
    const afterSpend = missingPermissionCalls({
        account: ACCOUNT,
        keyHash: hash,
        permissions: wanted,
        installed: spendInstalled,
    })
    expect(
        afterSpend.map(
            (call) => decodeFunctionData({ abi: accountAbi, data: call.data }).functionName,
        ),
    ).not.toContain('setSpendLimit')

    const complete = missingPermissionCalls({
        account: ACCOUNT,
        keyHash: hash,
        permissions: wanted,
        installed: wanted.map((permission) =>
            permission.type === 'call'
                ? {
                      type: 'call' as const,
                      to: permission.to,
                      selector: permission.selector,
                  }
                : {
                      type: 'spend' as const,
                      token: permission.token,
                      limit: permission.limit,
                      period: permission.period,
                  },
        ),
    })
    expect(complete).toEqual([])
})

describe('runFirstUpgrade', () => {
    test('a USDC holder takes the paid path and a non-holder stays on the sponsored upgrade', async () => {
        const wanted = permissions()
        const paid = await runWith({ balance: 2_000_000n, gas: 464_630n })
        expect(paid.sponsored).toHaveBeenCalledTimes(0)
        expect(paid.prepare).toHaveBeenCalledTimes(1)
        expect(paid.send).toHaveBeenCalledTimes(1)
        expect(paid.sentGas).toBe(464_630n)
        expect(paid.sentGas).toBeLessThanOrEqual(PAID_UPGRADE_GAS_HOLD)
        expect(paid.upgradeCalls).toHaveLength(1)
        expect(authorizeCalldataIsNormal(paid.upgradeCalls[0]!.data)).toBe(true)
        expect(paid.installCalls).toHaveLength(7)
        expect(paid.result.path).toBe('paid')

        const empty = await runWith({ balance: 0n, gas: 464_630n })
        expect(empty.prepare).toHaveBeenCalledTimes(0)
        expect(empty.send).toHaveBeenCalledTimes(0)
        expect(empty.sponsored).toHaveBeenCalledTimes(1)
        const sponsoredKey = empty.sponsored.mock.calls[0]?.[0].authorizeKey
        expect(sponsoredKey).toEqual(fullSessionAuthorizeKey(SESSION, wanted))
        expect(sponsoredKey.role).toBe('normal')
        expect(sponsoredKey.permissions).toEqual(wanted)
        expect(empty.result.path).toBe('sponsored')
    })

    test('a paid quote over the 500k hold falls back to the sponsored full pre-call', async () => {
        const refused = await runWith({ balance: 2_000_000n, gas: 547_082n })
        expect(refused.send).toHaveBeenCalledTimes(0)
        expect(refused.sponsored).toHaveBeenCalledTimes(1)
        expect(refused.sponsored.mock.calls[0]?.[0].authorizeKey.permissions).toEqual(permissions())
        expect(refused.result.path).toBe('sponsored')
    })

    test('an unrelated paid-prepare failure is not turned into a sponsored upgrade', async () => {
        const failed = await runWith({
            balance: 2_000_000n,
            prepareError: new Error('Simulation failed'),
        })
        expect(failed.error?.message).toMatch(/Simulation failed/)
        expect(failed.sponsored).toHaveBeenCalledTimes(0)
        expect(failed.send).toHaveBeenCalledTimes(0)
    })

    test('a failed permission install says the key is authorized and resume finishes only what is missing', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'paid-upgrade-'))
        const keystorePath = join(dir, 'account.json')
        try {
            const first = await runWith({
                balance: 2_000_000n,
                gas: 464_630n,
                keystorePath,
                installError: new Error('bundle reverted'),
            })
            expect(first.error?.message).toContain('authorized')
            expect(first.error?.message).toContain('permissions are not installed')
            expect(first.error?.message).toContain('tw account create --resume')
            expect(first.error?.message).toContain(
                permissionsPendingMessage(keystorePath).slice(0, 40),
            )
            const marker = JSON.parse(
                await readFile(paidUpgradeMarkerPath(keystorePath, 'sessions', 8453), 'utf8'),
            ) as { status: string }
            expect(marker.status).toBe('key_authorized')
            expect(first.prepare).toHaveBeenCalledTimes(1)
            expect(first.install).toHaveBeenCalledTimes(1)

            const second = await runWith({
                balance: 2_000_000n,
                gas: 464_630n,
                keystorePath,
                delegated: true,
                installed: [],
            })
            expect(second.prepare).toHaveBeenCalledTimes(0)
            expect(second.send).toHaveBeenCalledTimes(0)
            expect(second.sponsored).toHaveBeenCalledTimes(0)
            expect(second.install).toHaveBeenCalledTimes(1)
            expect(second.installCalls).toHaveLength(7)
            expect(
                second.installCalls.map(
                    (call) => decodeFunctionData({ abi: accountAbi, data: call.data }).functionName,
                ),
            ).not.toContain('authorize')
            expect(second.result.path).toBe('paid')

            const third = await runWith({
                balance: 2_000_000n,
                gas: 464_630n,
                keystorePath,
                delegated: true,
                installed: permissions(),
            })
            expect(third.prepare).toHaveBeenCalledTimes(0)
            expect(third.install).toHaveBeenCalledTimes(0)
            expect(third.sponsored).toHaveBeenCalledTimes(0)
            expect(third.result.noop).toBe(true)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    test('resume after a successful permission install is a no-op', async () => {
        const done = await runWith({
            balance: 2_000_000n,
            gas: 464_630n,
            delegated: true,
            installed: permissions(),
        })
        expect(done.result.noop).toBe(true)
        expect(done.prepare).toHaveBeenCalledTimes(0)
        expect(done.install).toHaveBeenCalledTimes(0)
        expect(done.sponsored).toHaveBeenCalledTimes(0)
    })

    test('an admin session key is refused before any permission call', async () => {
        const admin = await runWith({
            balance: 2_000_000n,
            gas: 464_630n,
            delegated: true,
            role: 'admin',
            installed: [],
        })
        expect(admin.error?.message).toMatch(/admin/)
        expect(admin.install).toHaveBeenCalledTimes(0)
        expect(admin.prepare).toHaveBeenCalledTimes(0)
    })
})

function runWith(input: {
    balance: bigint
    gas: bigint
    keystorePath?: string
    prepareError?: Error
    installError?: Error
    delegated?: boolean
    installed?: Permission[]
    role?: 'admin' | 'normal'
}) {
    const prepare = mock(async (_args: { upgrade: { calls: Array<{ data: Hex }> } }) => {
        if (input.prepareError) throw input.prepareError
        return {
            gas: input.gas,
            context: { quote: { quotes: [] } },
            typedData: { message: {} },
        }
    })
    const send = mock(async () => ({ id: 'bundle-1', txHash: '0xabc' as Hex }))
    const sponsored = mock(async () => ({
        accountAddress: ACCOUNT,
        txHash: '0xdef' as Hex,
    }))
    const install = mock(async () => {
        if (input.installError) throw input.installError
        return { txHash: '0x111' as Hex }
    })
    const installed: InstalledPermission[] = (input.installed ?? []).map((permission) =>
        permission.type === 'call'
            ? {
                  type: 'call' as const,
                  to: permission.to,
                  selector: permission.selector,
              }
            : {
                  type: 'spend' as const,
                  token: permission.token,
                  limit: permission.limit,
                  period: permission.period,
              },
    )
    const promise = runFirstUpgrade(
        {
            rootPrivateKey: ROOT_KEY,
            sessionAddress: SESSION,
            network,
            permissions: permissions(),
            keystorePath: input.keystorePath,
            sessionsDir: 'sessions',
        },
        {
            readUsdcBalance: async () => input.balance,
            readDelegationCode: async () => (input.delegated ? '0xef010011' : '0x'),
            readSessionKey: async () =>
                input.delegated
                    ? {
                          hash: keyHash(),
                          role: input.role ?? 'normal',
                          permissions: installed,
                      }
                    : null,
            preparePaidUpgrade: prepare,
            signPaidIntent: async () => '0xsig' as Hex,
            sendPaidUpgrade: send,
            waitPaidUpgrade: async () => ({ success: true, txHash: '0xabc' as Hex }),
            installPermissions: install,
            sponsoredUpgrade: sponsored,
            sleep: async () => {},
        },
    )
    return promise.then(
        (result) => ({
            result,
            error: undefined as Error | undefined,
            prepare,
            send,
            sponsored,
            install,
            sentGas: send.mock.calls[0]?.[0].gas as bigint | undefined,
            upgradeCalls: (prepare.mock.calls[0]?.[0].upgrade.calls ?? []) as Array<{
                data: Hex
            }>,
            installCalls: (install.mock.calls[0]?.[0].calls ?? []) as Array<{
                data: Hex
            }>,
        }),
        (error: Error) => ({
            result: undefined as never,
            error,
            prepare,
            send,
            sponsored,
            install,
            sentGas: send.mock.calls[0]?.[0].gas as bigint | undefined,
            upgradeCalls: (prepare.mock.calls[0]?.[0].upgrade.calls ?? []) as Array<{
                data: Hex
            }>,
            installCalls: (install.mock.calls[0]?.[0].calls ?? []) as Array<{
                data: Hex
            }>,
        }),
    )
}
