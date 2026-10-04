import { getAddress, isHex, parseUnits, padHex, type Address, type Hex } from 'viem'
import { createEscrowCalls, computeEscrowId } from '@nubl/relayer-client'
import { resolveKeystorePath } from './account-create'
import type { ChainName, EnvName } from './network-config'
import type { ExecuteSignedCallsDeps } from './execute-calls'
import { createEscrowPasswordResolver, executeEscrowCallsWithFallback } from './escrow-execute'
import {
    EscrowError,
    type EscrowChainNetworkContractsDeps,
    resolveEscrowChainNetworkContracts,
    toEscrowError,
} from './escrow-common'

export type EscrowCreateDeps = EscrowChainNetworkContractsDeps & {
    executeSignedCallsDeps?: Partial<ExecuteSignedCallsDeps>
}

function getDefaultEscrowCreateDeps(): EscrowChainNetworkContractsDeps {
    return { resolveEscrowChainNetworkContracts }
}

export type EscrowCreateOptions = {
    env: EnvName
    amount: string
    seller: string
    oracle: string
    deadline: string
    chain?: ChainName
    keystorePath?: string
    sessionFile?: string
    sessionName?: string
    name?: string
    password?: string
    resolvePassword?: () => Promise<string>
    salt?: string
}

export type EscrowCreateResult = {
    type: 'escrow_create'
    status: 'complete'
    escrowId: Hex
    orderId: Hex
    chain: ChainName
    buyer: Address
    seller: Address
    oracle: Address
    amount: string
    amountBaseUnits: string
    deadline: string
    deadlineTimestamp: string
    escrowAddress: Address
    bundle: {
        id: string
        status: string
        statusCode: number
    }
    signerMode: 'daemon' | 'direct' | 'fallback_direct'
    txHash?: Hex
}

function parseDeadline(value: string): bigint {
    const trimmed = value.trim()
    // Support relative durations: 1h, 2d, 30m, 1w (no 0m/0h/0d/0w — would be already past)
    const match = trimmed.match(/^(\d+)(m|h|d|w)$/)
    if (match) {
        const durationCount = parseInt(match[1]!, 10)
        if (durationCount < 1) {
            throw new EscrowError(
                'INVALID_ARGUMENT',
                `Invalid deadline: "${value}". Relative duration must be at least 1 (e.g. 1m, 1h, 1d, 1w).`,
            )
        }
        const unit = match[2] as 'm' | 'h' | 'd' | 'w'
        const seconds: Record<'m' | 'h' | 'd' | 'w', number> = {
            m: 60,
            h: 3600,
            d: 86400,
            w: 604800,
        }
        const offset = durationCount * seconds[unit]
        return BigInt(Math.floor(Date.now() / 1000) + offset)
    }

    // Support absolute unix timestamp
    if (/^\d+$/.test(trimmed)) {
        const ts = Number.parseInt(trimmed, 10)
        if (ts > 1_000_000_000) {
            return BigInt(ts)
        }
    }

    throw new EscrowError(
        'INVALID_ARGUMENT',
        `Invalid deadline: "${value}". Use relative (1h, 2d, 30m, 1w) or unix timestamp.`,
    )
}

function parseUsdcAmount(value: string): { normalized: string; baseUnits: bigint } {
    const amount = value.trim()
    if (!/^\d+(\.\d+)?$/.test(amount)) {
        throw new EscrowError('INVALID_AMOUNT', 'Amount must be a positive decimal number.')
    }
    const fractional = amount.split('.')[1] ?? ''
    if (fractional.length > 6) {
        throw new EscrowError(
            'INVALID_AMOUNT',
            'Amount supports at most 6 decimal places for USDC.',
        )
    }
    let parsed: bigint
    try {
        parsed = parseUnits(amount, 6)
    } catch (error) {
        throw new EscrowError('INVALID_AMOUNT', 'Amount is invalid or too large.', { cause: error })
    }
    if (parsed <= 0n) {
        throw new EscrowError('INVALID_AMOUNT', 'Amount must be greater than zero.')
    }
    return { normalized: amount, baseUnits: parsed }
}

/**
 * Create a USDC escrow: lock funds with seller, oracle, and deadline.
 * Resolves contracts from env/chain, loads session (daemon or direct), and submits via relayer.
 * @param depsArg Optional overrides for testing (e.g. resolveEscrowChainNetworkContracts, executeSignedCallsDeps).
 */
export async function executeEscrowCreate(
    options: EscrowCreateOptions,
    depsArg?: Partial<EscrowCreateDeps>,
): Promise<EscrowCreateResult> {
    const deps = { ...getDefaultEscrowCreateDeps(), ...depsArg }
    const { chain, network, contracts } = deps.resolveEscrowChainNetworkContracts(
        options.env,
        options.chain,
    )
    const keystorePath =
        options.sessionFile ??
        resolveKeystorePath({
            env: options.env,
            keystorePath: options.keystorePath,
            name: options.name,
        })

    const resolvePassword = createEscrowPasswordResolver({
        password: options.password,
        resolvePassword: options.resolvePassword,
    })

    try {
        const parsedAmount = parseUsdcAmount(options.amount)
        const seller = getAddress(options.seller)
        const oracle = getAddress(options.oracle)
        const deadline = parseDeadline(options.deadline)

        const orderId = padHex(`0x${Date.now().toString(16)}`, { size: 32, dir: 'right' }) as Hex
        let salt: Hex | undefined
        if (options.salt) {
            if (!isHex(options.salt) || options.salt.length > 26) {
                throw new EscrowError(
                    'INVALID_ARGUMENT',
                    'Salt must be a hex string (up to 12 bytes, 0x + 24 chars).',
                )
            }
            salt = padHex(options.salt as Hex, { size: 12, dir: 'right' }) as Hex
        }

        const escrowParamsBase = {
            seller,
            usdcAmount: parsedAmount.baseUnits,
            deadline,
            orderId,
            oracleAddress: oracle,
            usdcAddress: contracts.usdcAddress,
            escrowAddress: contracts.escrowAddress,
            simpleSettlerAddress: contracts.simpleSettlerAddress,
            chainId: network.chainId,
            salt,
        }

        const result = await executeEscrowCallsWithFallback({
            chain,
            network,
            env: options.env,
            sessionFile: options.sessionFile,
            sessionName: options.sessionName,
            keystorePath,
            name: options.name,
            resolvePassword,
            executeSignedCallsDeps: deps.executeSignedCallsDeps,
            buildCalls: (sender) =>
                createEscrowCalls({
                    ...escrowParamsBase,
                    buyer: sender,
                }),
            failureMessage: 'Escrow creation',
        })

        const escrowId = computeEscrowId({
            ...escrowParamsBase,
            buyer: result.sender,
        })

        return {
            type: 'escrow_create',
            status: 'complete',
            escrowId,
            orderId,
            chain,
            buyer: result.sender,
            seller,
            oracle,
            amount: parsedAmount.normalized,
            amountBaseUnits: parsedAmount.baseUnits.toString(),
            deadline: options.deadline,
            deadlineTimestamp: deadline.toString(),
            escrowAddress: contracts.escrowAddress,
            bundle: {
                id: result.submission.id,
                status: result.finalStatus.status ?? 'unknown',
                statusCode: result.finalStatus.statusCode ?? 0,
            },
            signerMode: result.signerMode,
            txHash: result.finalStatus.receipt?.transactionHash,
        }
    } catch (error) {
        throw toEscrowError(error)
    }
}
