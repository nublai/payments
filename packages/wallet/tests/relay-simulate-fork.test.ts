import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { simulateRelayQuote } from '../src/lib/relay-simulate'

const ANVIL = `${process.env.HOME}/.foundry/bin/anvil`
const FORGE = `${process.env.HOME}/.foundry/bin/forge`
const USER = '0x1111111111111111111111111111111111111111' as Address
const ATTACKER = '0x2222222222222222222222222222222222222222' as Address
const RELAYER_SIGNER = '0x277b7440CE050d9e9e428d1f349E51D468c7eB7E' as Address
const STAND_IN_ORIGIN = '0x9999999999999999999999999999999999999999' as Address
const ROOT = new URL('./fixtures/sim-path/', import.meta.url).pathname

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const payload = (await response.json()) as { result?: unknown; error?: { message?: string } }
    if (payload.error) {
        throw new Error(payload.error.message ?? method)
    }
    return payload.result
}

async function deploy(url: string, bytecode: Hex): Promise<Address> {
    const hash = (await rpc(url, 'eth_sendTransaction', [
        {
            from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            data: bytecode,
            gas: '0x1c9c380',
        },
    ])) as string
    let tx: { contractAddress?: string; status?: string } | null = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
        tx = (await rpc(url, 'eth_getTransactionReceipt', [hash])) as typeof tx
        if (tx) break
        await sleep(50)
    }
    if (!tx?.contractAddress) {
        throw new Error(`deploy failed: ${JSON.stringify(tx)} hash ${hash}`)
    }
    return getAddress(tx.contractAddress)
}

test(
    'unstubbed anvil simulation uses the orchestrator and a non-user origin',
    async () => {
        const build = spawn(FORGE, ['build', '--root', ROOT], { stdio: 'pipe' })
        const built = await new Promise<number>((resolve) => {
            build.on('exit', (code) => resolve(code ?? 1))
        })
        expect(built).toBe(0)

        const bytecode = (name: string): Hex => {
            const artifact = JSON.parse(
                readFileSync(`${ROOT}out/SimPath.sol/${name}.json`, 'utf8'),
            ) as { bytecode: { object: string } }
            return artifact.bytecode.object as Hex
        }

        const port = 18547
        const url = `http://127.0.0.1:${port}`
        const anvil = spawn(
            ANVIL,
            ['--port', String(port), '--chain-id', '8453', '--hardfork', 'prague', '--silent'],
            { stdio: 'ignore' },
        )
        try {
            for (let attempt = 0; attempt < 50; attempt += 1) {
                try {
                    await rpc(url, 'eth_chainId', [])
                    break
                } catch {
                    if (attempt === 49) throw new Error('anvil did not start')
                    await sleep(100)
                }
            }
            await rpc(url, 'anvil_impersonateAccount', [
                '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            ])

            const input = await deploy(url, bytecode('Mintable'))
            const output = await deploy(url, bytecode('Mintable'))
            const forwarder = await deploy(url, bytecode('ForwardAccount'))
            const orchestrator = await deploy(url, bytecode('HarnessOrchestrator'))
            const routerCode = bytecode('OriginRouter')
            const routerArgs = encodeAbiParameters([{ type: 'address' }], [RELAYER_SIGNER])
            const router = await deploy(url, `${routerCode}${routerArgs.slice(2)}` as Hex)

            const mint = encodeFunctionData({
                abi: [
                    {
                        name: 'mint',
                        type: 'function',
                        inputs: [
                            { name: 'to', type: 'address' },
                            { name: 'amount', type: 'uint256' },
                        ],
                    },
                ],
                functionName: 'mint',
                args: [USER, 100n],
            })
            await rpc(url, 'eth_sendTransaction', [
                {
                    from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                    to: input,
                    data: mint,
                    gas: '0x100000',
                },
            ])

            const transfer = encodeFunctionData({
                abi: [
                    {
                        name: 'transfer',
                        type: 'function',
                        inputs: [
                            { name: 'to', type: 'address' },
                            { name: 'amount', type: 'uint256' },
                        ],
                    },
                ],
                functionName: 'transfer',
                args: [router, 5n],
            })
            const pay = (alwaysUser: boolean) =>
                encodeFunctionData({
                    abi: [
                        {
                            name: 'pay',
                            type: 'function',
                            inputs: [
                                { name: 'output', type: 'address' },
                                { name: 'user', type: 'address' },
                                { name: 'attacker', type: 'address' },
                                { name: 'amount', type: 'uint256' },
                                { name: 'alwaysUser', type: 'bool' },
                            ],
                        },
                    ],
                    functionName: 'pay',
                    args: [output, USER, ATTACKER, 1000n, alwaysUser],
                })

            const executionFor = (origin: Address) => ({
                orchestrator,
                delegation: forwarder,
                origin,
                keyHash: `0x${'ab'.repeat(32)}` as Hex,
                nonce: 0n,
            })
            const watches = [
                { kind: 'erc20' as const, token: input, role: 'origin' as const },
                { kind: 'erc20' as const, token: output, role: 'output' as const },
            ]
            await simulateRelayQuote({
                rpcUrl: url,
                chainId: 8453,
                user: USER,
                calls: [
                    { to: input, data: transfer, value: 0n },
                    { to: router, data: pay(true), value: 0n },
                ],
                watches,
                cap: 5n,
                sameChain: true,
                minimumOutput: 1000n,
                execution: executionFor(RELAYER_SIGNER),
            })

            await expect(
                simulateRelayQuote({
                    rpcUrl: url,
                    chainId: 8453,
                    user: USER,
                    calls: [
                        { to: input, data: transfer, value: 0n },
                        { to: router, data: pay(false), value: 0n },
                    ],
                    watches,
                    cap: 5n,
                    sameChain: true,
                    minimumOutput: 1000n,
                    execution: executionFor(RELAYER_SIGNER),
                }),
            ).rejects.toThrow(/below the quoted minimum of 1000/)

            // A stand-in origin is paid. That is the hole a constant origin misses.
            await simulateRelayQuote({
                rpcUrl: url,
                chainId: 8453,
                user: USER,
                calls: [
                    { to: input, data: transfer, value: 0n },
                    { to: router, data: pay(false), value: 0n },
                ],
                watches,
                cap: 5n,
                sameChain: true,
                minimumOutput: 1000n,
                execution: executionFor(STAND_IN_ORIGIN),
            })
        } finally {
            anvil.kill('SIGKILL')
        }
    },
    { timeout: 120_000 },
)
