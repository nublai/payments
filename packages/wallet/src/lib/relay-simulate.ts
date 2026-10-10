import {
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    isAddress,
    keccak256,
    toHex,
    zeroAddress,
    type Address,
    type Hex,
} from 'viem'
import { wrapSignature } from '@nubl/relayer-client'

/**
 * Simulate the quote as the relayer's EIP-7702 execution: Orchestrator
 * `simulateExecute` calls the account, whose code is overridden to the
 * 7702 designator `0xef0100 || accountProxy`. `from` is a non-user origin
 * so `tx.origin` is not the user.
 *
 * This is defense in depth. A router that branches on one specific relayer
 * signer, or an RPC that lies about both logs and balances, is not fully
 * excluded here. The per-quote spend limit is what caps the loss.
 *
 * `from` / `tx.origin` is a signer from `wallet_getCapabilities`
 * (`pool.signers[].address`). The relayer does not publish a separate
 * signer-address endpoint.
 *
 * Base `https://mainnet.base.org` and Polygon `https://polygon.drpc.org`
 * both answer `eth_simulateV1`. There is no anvil fallback.
 */

const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'))

const SIM_GAS = 12_000_000n

const COMBINED_GAS = 5_000_000n

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address

const BALANCE_OF = '0x70a08231'

export class RelaySimulationRejected extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RelaySimulationRejected'
    }
}

export type SimulatedCall = {
    to: Address
    data: Hex
    value: bigint
}

export type SimulatedWatch =
    | { kind: 'native'; role: 'origin' | 'output' | 'other' }
    | { kind: 'erc20'; token: Address; role: 'origin' | 'output' | 'other' }

export type RelayExecutionContext = {
    orchestrator: Address
    /** Account proxy the 7702 designator points at. */
    delegation: Address
    /**
     * Transaction origin. Not the user. Omit to use a signer from
     * `wallet_getCapabilities` on `relayerUrl`.
     */
    origin?: Address
    keyHash: Hex
    nonce: bigint
}

export type SimulateRelayQuoteInput = {
    rpcUrl: string
    chainId: number
    user: Address
    calls: SimulatedCall[]
    watches: SimulatedWatch[]
    cap: bigint
    sameChain: boolean
    minimumOutput?: bigint
    execution: RelayExecutionContext
    /** Relayer JSON-RPC URL. Required when `execution.origin` is omitted. */
    relayerUrl?: string
    request?: (method: string, params: unknown[]) => Promise<unknown>
}

type BalanceBook = {
    native: bigint
    tokens: Map<string, bigint>
}

function padAddress(address: Address): string {
    return address.toLowerCase().slice(2).padStart(64, '0')
}

function balanceOfData(token: Address, user: Address): Hex {
    return `${BALANCE_OF}${padAddress(user)}` as Hex
}

function getEthBalanceData(user: Address): Hex {
    return encodeFunctionData({
        abi: [
            {
                name: 'getEthBalance',
                type: 'function',
                stateMutability: 'view',
                inputs: [{ name: 'addr', type: 'address' }],
                outputs: [{ type: 'uint256' }],
            },
        ],
        functionName: 'getEthBalance',
        args: [user],
    })
}

function decodeWord(data: unknown): bigint {
    if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    const body = data.slice(2)

    if (body.length === 0) return 0n

    if (body.length > 64) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    return BigInt(data)
}

async function defaultRequest(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
    let response: Response

    try {
        response = await fetch(rpcUrl, {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
    } catch {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    if (!response.ok) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    const payload = (await response.json()) as { result?: unknown; error?: { code?: number; message?: string } }

    if (payload.error) {
        const code = payload.error.code
        const message = payload.error.message ?? 'rpc error'
        const wrapped = new Error(`${code ?? ''} ${message}`)

        if (code === -32601) throw wrapped
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    return payload.result
}

function dedupedWatches(watches: SimulatedWatch[]): SimulatedWatch[] {
    const seen = new Set<string>()
    const ordered: SimulatedWatch[] = []
    const rank = { origin: 0, output: 1, other: 2 }
    const sorted = [...watches].sort((a, b) => rank[a.role] - rank[b.role])

    for (const watch of sorted) {
        const key = watch.kind === 'native' ? 'native' : watch.token.toLowerCase()

        if (seen.has(key)) continue
        seen.add(key)
        ordered.push(watch)
    }

    return ordered
}

export function assertBalanceDeltas(input: {
    watches: SimulatedWatch[]
    before: BalanceBook
    after: BalanceBook
    cap: bigint
    sameChain: boolean
    minimumOutput?: bigint
}): void {
    let sawOrigin = false
    let sawOutput = false

    for (const watch of dedupedWatches(input.watches)) {
        const before =
            watch.kind === 'native'
                ? input.before.native
                : input.before.tokens.get(watch.token.toLowerCase())

        const after =
            watch.kind === 'native'
                ? input.after.native
                : input.after.tokens.get(watch.token.toLowerCase())

        if (before === undefined || after === undefined) {
            throw new RelaySimulationRejected(
                'relay.link quote could not be simulated. Refusing to sign.',
            )
        }

        const label = watch.kind === 'native' ? 'ETH' : watch.token

        if (watch.role === 'origin') {
            sawOrigin = true

            if (before - after > input.cap) {
                throw new RelaySimulationRejected(
                    `relay.link quote would spend ${before - after} of ${label}, above the quoted input of ${input.cap}.`,
                )
            }

            continue
        }

        if (watch.role === 'output' && input.sameChain) {
            sawOutput = true

            if (input.minimumOutput === undefined || input.minimumOutput <= 0n) {
                throw new RelaySimulationRejected(
                    'relay.link quote did not include an output minimum. Refusing to sign.',
                )
            }

            if (after < before + input.minimumOutput) {
                throw new RelaySimulationRejected(
                    `relay.link quote would deliver ${after - before} of ${label}, below the quoted minimum of ${input.minimumOutput}.`,
                )
            }

            continue
        }

        if (after < before) {
            throw new RelaySimulationRejected(
                `relay.link quote would lower ${label} by ${before - after}, which this quote did not ask to spend.`,
            )
        }
    }

    if (!sawOrigin) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    if (input.sameChain && !sawOutput) {
        throw new RelaySimulationRejected(
            'relay.link quote did not include an output minimum. Refusing to sign.',
        )
    }
}

type RpcCall = { from: Address; to: Address; data: Hex; value: string; gas?: string }

function probeCalls(user: Address, watches: SimulatedWatch[]): RpcCall[] {
    const probes: RpcCall[] = []

    for (const watch of watches) {
        if (watch.kind === 'native') {
            probes.push({
                from: user,
                to: MULTICALL3,
                data: getEthBalanceData(user),
                value: '0x0',
            })
            continue
        }

        probes.push({
            from: user,
            to: getAddress(watch.token),
            data: balanceOfData(watch.token, user),
            value: '0x0',
        })
    }

    return probes
}

function readBook(watches: SimulatedWatch[], words: bigint[]): BalanceBook {
    const book: BalanceBook = { native: 0n, tokens: new Map() }
    watches.forEach((watch, index) => {
        const word = words[index]

        if (word === undefined) {
            throw new RelaySimulationRejected(
                'relay.link quote could not be simulated. Refusing to sign.',
            )
        }

        if (watch.kind === 'native') book.native = word
        else book.tokens.set(watch.token.toLowerCase(), word)
    })

    return book
}

async function readBefore(
    input: SimulateRelayQuoteInput,
    watches: SimulatedWatch[],
    request: (method: string, params: unknown[]) => Promise<unknown>,
): Promise<BalanceBook> {
    const words: bigint[] = []

    for (const watch of watches) {
        if (watch.kind === 'native') {
            const result = await request('eth_getBalance', [input.user, 'latest'])
            words.push(decodeWord(result))
            continue
        }

        const result = await request('eth_call', [
            { to: watch.token, data: balanceOfData(watch.token, input.user) },
            'latest',
        ])

        words.push(decodeWord(result))
    }

    return readBook(watches, words)
}

type SimLog = { address?: string; topics?: string[]; data?: string }

function parseSimulateResult(
    result: unknown,
    userCallCount: number,
): { words: bigint[]; logs: SimLog[] | undefined } {
    if (!Array.isArray(result) || !result[0] || typeof result[0] !== 'object') {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    const calls = (result[0] as { calls?: unknown }).calls

    if (!Array.isArray(calls) || calls.length < userCallCount) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    for (const call of calls) {
        const row = call as { status?: string | number; error?: unknown }
        const status = row?.status
        const ok = status === '0x1' || status === '0x01' || status === '1' || status === 1

        if (!ok || row.error) {
            throw new RelaySimulationRejected(
                'relay.link quote simulation reverted. Refusing to sign.',
            )
        }
    }

    const first = calls[0] as { logs?: unknown }
    const logs = Array.isArray(first.logs) ? (first.logs as SimLog[]) : undefined

    return {
        words: calls.slice(userCallCount).map((call) => {
            const row = call as { returnData?: string }

            return decodeWord(row.returnData)
        }),
        logs,
    }
}

function outputLogSum(logs: SimLog[] | undefined, token: Address, user: Address): bigint | undefined {
    if (!logs) return undefined
    const userTopic = `0x${padAddress(user)}`
    let sum = 0n

    for (const log of logs) {
        if (!log?.address || !isAddress(log.address)) continue

        if (getAddress(log.address).toLowerCase() !== token.toLowerCase()) continue

        if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue

        if (log.topics[2]?.toLowerCase() !== userTopic) continue
        sum += decodeWord(log.data)
    }

    return sum
}

export async function readRelayerSignerOrigin(input: {
    relayerUrl: string
    chainId: number
    request?: (method: string, params: unknown[]) => Promise<unknown>
}): Promise<Address> {
    const request =
        input.request ??
        ((method: string, params: unknown[]) => defaultRequest(input.relayerUrl, method, params))

    const hexChain = `0x${input.chainId.toString(16)}`
    let result: unknown

    try {
        result = await request('wallet_getCapabilities', [{ chains: [hexChain] }])
    } catch {
        throw new RelaySimulationRejected(
            'The relayer did not expose a signer address. Refusing to sign.',
        )
    }

    type CapabilitiesChain = { pool?: { signers?: unknown } }

    let table: { [chainId: string]: CapabilitiesChain | undefined } = {}

    if (result && typeof result === 'object') {
        // SAFETY: wallet_getCapabilities is a JSON object keyed by hex chain id.
        table = result as { [chainId: string]: CapabilitiesChain | undefined }
    }

    const chain =
        table[hexChain] ??
        table[hexChain.toLowerCase()] ??
        Object.entries(table).find(([key]) => Number.parseInt(key, 16) === input.chainId)?.[1]

    const pool = chain?.pool

    const signers = Array.isArray(pool?.signers) ? pool.signers : []

    for (const signer of signers) {
        if (!signer || typeof signer !== 'object') continue
        const row = signer as { address?: unknown; paused?: unknown }

        if (row.paused === true) continue

        if (typeof row.address === 'string' && isAddress(row.address)) {
            return getAddress(row.address)
        }
    }

    throw new RelaySimulationRejected(
        'The relayer did not expose a signer address. Refusing to sign.',
    )
}

function assertOutputLogs(input: {
    watches: SimulatedWatch[]
    before: BalanceBook
    after: BalanceBook
    logs: SimLog[] | undefined
    user: Address
}): void {
    for (const watch of dedupedWatches(input.watches)) {
        if (watch.kind !== 'erc20' || watch.role !== 'output') continue
        const logSum = outputLogSum(input.logs, watch.token, input.user)

        if (logSum === undefined) {
            throw new RelaySimulationRejected(
                'relay.link quote simulation did not return output logs. Refusing to sign.',
            )
        }

        const before = input.before.tokens.get(watch.token.toLowerCase())
        const after = input.after.tokens.get(watch.token.toLowerCase())

        if (before === undefined || after === undefined) {
            throw new RelaySimulationRejected(
                'relay.link quote could not be simulated. Refusing to sign.',
            )
        }

        const diff = after - before

        if (logSum !== diff) {
            throw new RelaySimulationRejected(
                `relay.link quote output logs and balance differ for ${watch.token}: logs ${logSum}, balance ${diff}. Refusing to sign.`,
            )
        }
    }
}

const intentTuple = {
    type: 'tuple',
    components: [
        { name: 'eoa', type: 'address' },
        { name: 'executionData', type: 'bytes' },
        { name: 'nonce', type: 'uint256' },
        { name: 'payer', type: 'address' },
        { name: 'paymentToken', type: 'address' },
        { name: 'paymentMaxAmount', type: 'uint256' },
        { name: 'combinedGas', type: 'uint256' },
        { name: 'encodedPreCalls', type: 'bytes[]' },
        { name: 'encodedFundTransfers', type: 'bytes[]' },
        { name: 'settler', type: 'address' },
        { name: 'expiry', type: 'uint256' },
        { name: 'isMultichain', type: 'bool' },
        { name: 'funder', type: 'address' },
        { name: 'funderSignature', type: 'bytes' },
        { name: 'settlerContext', type: 'bytes' },
        { name: 'paymentAmount', type: 'uint256' },
        { name: 'paymentRecipient', type: 'address' },
        { name: 'signature', type: 'bytes' },
        { name: 'paymentSignature', type: 'bytes' },
        { name: 'supportedAccountImplementation', type: 'address' },
    ],
} as const

const callTuple = {
    type: 'tuple[]',
    components: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
    ],
} as const

function delegationCode(target: Address): Hex {
    return `0xef0100${target.slice(2).toLowerCase()}` as Hex
}

function encodeOrchestratorCall(input: SimulateRelayQuoteInput): Hex {
    const executionData = encodeAbiParameters([callTuple], [
        input.calls.map((call) => ({
            to: call.to,
            value: call.value,
            data: call.data,
        })),
    ])

    // 65-byte placeholder. simulateExecute forces validity and still reads keyHash.
    const inner = `0x${'11'.repeat(64)}1b` as Hex
    const signature = wrapSignature(inner, input.execution.keyHash, false)

    const encodedIntent = encodeAbiParameters([intentTuple], [
        {
            eoa: input.user,
            executionData,
            nonce: input.execution.nonce,
            payer: zeroAddress,
            paymentToken: zeroAddress,
            paymentMaxAmount: 0n,
            combinedGas: COMBINED_GAS,
            encodedPreCalls: [],
            encodedFundTransfers: [],
            settler: zeroAddress,
            expiry: 0n,
            isMultichain: false,
            funder: zeroAddress,
            funderSignature: '0x',
            settlerContext: '0x',
            paymentAmount: 0n,
            paymentRecipient: zeroAddress,
            signature,
            paymentSignature: '0x',
            supportedAccountImplementation: zeroAddress,
        },
    ])

    return encodeFunctionData({
        abi: [
            {
                name: 'simulateExecute',
                type: 'function',
                stateMutability: 'payable',
                inputs: [
                    { name: 'isStateOverride', type: 'bool' },
                    { name: 'combinedGasOverride', type: 'uint256' },
                    { name: 'encodedIntent', type: 'bytes' },
                ],
                outputs: [{ type: 'uint256' }],
            },
        ],
        functionName: 'simulateExecute',
        args: [true, COMBINED_GAS, encodedIntent],
    })
}

async function simulateOnce(
    input: SimulateRelayQuoteInput,
    watches: SimulatedWatch[],
    request: (method: string, params: unknown[]) => Promise<unknown>,
): Promise<{ book: BalanceBook; logs: SimLog[] | undefined }> {
    if (!input.execution.origin) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    const origin = getAddress(input.execution.origin)

    if (origin.toLowerCase() === input.user.toLowerCase()) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    const probes = probeCalls(input.user, watches)

    const orchestratorCall: RpcCall = {
        from: origin,
        to: getAddress(input.execution.orchestrator),
        data: encodeOrchestratorCall(input),
        value: '0x0',
        gas: `0x${SIM_GAS.toString(16)}`,
    }

    const userCode = delegationCode(getAddress(input.execution.delegation))

    const result = await request('eth_simulateV1', [
        {
            blockStateCalls: [
                {
                    calls: [orchestratorCall, ...probes],
                    stateOverrides: {
                        [input.user]: { code: userCode },
                        [origin]: { balance: `0x${(1n << 192n).toString(16)}` },
                    },
                },
            ],
            validation: false,
        },
        'latest',
    ])

    const parsed = parseSimulateResult(result, 1)

    if (parsed.words.length !== watches.length) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    return { book: readBook(watches, parsed.words), logs: parsed.logs }
}

export async function simulateRelayQuote(input: SimulateRelayQuoteInput): Promise<void> {
    if (!input.execution?.orchestrator || !input.execution.delegation || !input.execution.keyHash) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    if (input.sameChain && (input.minimumOutput === undefined || input.minimumOutput <= 0n)) {
        throw new RelaySimulationRejected(
            'relay.link quote did not include an output minimum. Refusing to sign.',
        )
    }

    const watches = dedupedWatches(input.watches)

    if (!watches.some((watch) => watch.role === 'origin')) {
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    const request = input.request ?? ((method: string, params: unknown[]) => defaultRequest(input.rpcUrl, method, params))
    let origin: Address

    if (input.execution.origin) {
        origin = getAddress(input.execution.origin)
    } else if (!input.relayerUrl) {
        throw new RelaySimulationRejected(
            'The relayer did not expose a signer address. Refusing to sign.',
        )
    } else {
        origin = await readRelayerSignerOrigin({
            relayerUrl: input.relayerUrl,
            chainId: input.chainId,
        })
    }

    const simulating: SimulateRelayQuoteInput = {
        ...input,
        execution: { ...input.execution, origin },
    }

    let before: BalanceBook

    try {
        before = await readBefore(simulating, watches, request)
    } catch (error) {
        if (error instanceof RelaySimulationRejected) throw error
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    let after: BalanceBook
    let logs: SimLog[] | undefined

    try {
        const simulated = await simulateOnce(simulating, watches, request)
        after = simulated.book
        logs = simulated.logs
    } catch (error) {
        if (error instanceof RelaySimulationRejected) throw error
        throw new RelaySimulationRejected(
            'relay.link quote could not be simulated. Refusing to sign.',
        )
    }

    assertBalanceDeltas({
        watches,
        before,
        after,
        cap: input.cap,
        sameChain: input.sameChain,
        minimumOutput: input.minimumOutput,
    })
    assertOutputLogs({ watches, before, after, logs, user: input.user })
}
