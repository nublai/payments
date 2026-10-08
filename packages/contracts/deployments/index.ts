import deployments from './addresses.json'
import { type Address } from 'viem'

export type ChainDeployment = {
  chainId: number
  addresses: Record<string, Address>
}

export type ContextDeployments = Record<number, ChainDeployment>

export type Deployments = Record<string, ContextDeployments>

export interface ContractAddresses {
  orchestrator: Address
  simpleFunder: Address
  simulator: Address
  account: Address
  accountProxy: Address
  simpleSettler: Address
  escrow: Address
  multiSigSigner: Address
}

const requiredAddressKeys = [
  'orchestrator',
  'simpleFunder',
  'simulator',
  'account',
  'accountProxy',
  'simpleSettler',
  'escrow',
  'multiSigSigner',
] as const

type RequiredAddressKey = (typeof requiredAddressKeys)[number]

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function isDeployedAddress(value: string | undefined): value is Address {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()

  // Reject only empty and zero sentinels. Callers such as the relayer
  // capabilities mock use non-address placeholders (for example "0xAccount"),
  // and Boolean(value) used to accept those.
  if (normalized.length === 0 || normalized === '0x' || normalized === '0x0') return false

  return normalized !== ZERO_ADDRESS
}

function hasRequiredAddresses(
  addresses: Record<string, Address | undefined>
): addresses is Record<RequiredAddressKey, Address> {
  return requiredAddressKeys.every((key) => isDeployedAddress(addresses[key]))
}

// Re-export raw JSON
export { deployments }

// Type-safe accessor
export function getDeployment(
  context: string,
  chainId: number
): ChainDeployment | undefined {
  return (deployments as unknown as Deployments)[context]?.[chainId]
}

// Get address with type safety
export function getAddress(
  context: string,
  chainId: number,
  contract: string
): Address | undefined {
  return getDeployment(context, chainId)?.addresses[contract] as Address | undefined
}

// Get all addresses for a context/chain
export function getAddresses(
  context: string,
  chainId: number
): ContractAddresses | undefined {
  const deployment = getDeployment(context, chainId)

  if (!deployment) {
    return undefined
  }

  const addresses = deployment.addresses as Record<string, Address | undefined>

  if (!hasRequiredAddresses(addresses)) {
    return undefined
  }

  return {
    orchestrator: addresses.orchestrator,
    simpleFunder: addresses.simpleFunder,
    simulator: addresses.simulator,
    account: addresses.account,
    accountProxy: addresses.accountProxy,
    simpleSettler: addresses.simpleSettler,
    escrow: addresses.escrow,
    multiSigSigner: addresses.multiSigSigner,
  }
}

// List available contexts
export function getContexts(): string[] {
  return Object.keys(deployments)
}

// List chain IDs for a context
export function getChainIds(context: string): number[] {
  const ctx = (deployments as unknown as Deployments)[context]

  return ctx ? Object.keys(ctx).map(Number) : []
}

export function hasDeployment(context: string, chainId: number): boolean {
  return getAddresses(context, chainId) !== undefined
}

// Env var keys (matches output from make-config.js)
const envKeys = {
  orchestrator: 'ORCHESTRATOR',
  simpleFunder: 'SIMPLE_FUNDER',
  simpleSettler: 'SIMPLE_SETTLER',
  simulator: 'SIMULATOR',
  account: 'ACCOUNT',
  accountProxy: 'ACCOUNT_PROXY',
  escrow: 'ESCROW',
  multiSigSigner: 'MULTI_SIG_SIGNER',
}

export interface EnvOpts {
  keyPrefix?: string // e.g., 'VITE_' for Vite apps
  env?: Record<string, string | undefined> // defaults to process.env
}

// Get addresses from env vars using chain-specific suffix (e.g., ORCHESTRATOR_31337)
export function getAddressesFromEnvForChain(
  chainId: number,
  opts?: EnvOpts
): ContractAddresses | undefined {
  const prefix = opts?.keyPrefix ?? ''
  const envObj = opts?.env ?? (typeof process !== 'undefined' ? process.env : {})

  const get = (key: string): Address | undefined =>
    envObj[`${prefix}${key}_${chainId}`] as Address | undefined

  const addresses = {
    orchestrator: get(envKeys.orchestrator),
    simpleFunder: get(envKeys.simpleFunder),
    simulator: get(envKeys.simulator),
    account: get(envKeys.account),
    accountProxy: get(envKeys.accountProxy),
    simpleSettler: get(envKeys.simpleSettler),
    escrow: get(envKeys.escrow),
    multiSigSigner: get(envKeys.multiSigSigner),
  }

  if (!hasRequiredAddresses(addresses)) {
    return undefined
  }

  return addresses
}

// Get addresses from env vars (for local dev)
export function getAddressesFromEnv(opts?: EnvOpts): ContractAddresses | undefined {
  const prefix = opts?.keyPrefix ?? ''
  const envObj = opts?.env ?? (typeof process !== 'undefined' ? process.env : {})

  const get = (key: string): Address | undefined =>
    envObj[`${prefix}${key}`] as Address | undefined

  const addresses = {
    orchestrator: get(envKeys.orchestrator),
    simpleFunder: get(envKeys.simpleFunder),
    simulator: get(envKeys.simulator),
    account: get(envKeys.account),
    accountProxy: get(envKeys.accountProxy),
    simpleSettler: get(envKeys.simpleSettler),
    escrow: get(envKeys.escrow),
    multiSigSigner: get(envKeys.multiSigSigner),
  }

  if (!hasRequiredAddresses(addresses)) {
    return undefined
  }

  return addresses
}

export function isLocalDeployment(context: string, chainId: number): boolean {
  return context.startsWith('local') || chainId === 31337 || chainId === 41337
}

// JSON is the only source for dev, stage, and prod: a zero or missing address
// there means not deployed, whatever the env holds. Env vars (written by
// make-config to envs/local/.env) apply to local contexts and Anvil chains only.
export function getAddressesWithFallback(
  context: string,
  chainId: number,
  opts?: EnvOpts
): ContractAddresses | undefined {
  const fromJson = getAddresses(context, chainId)

  if (fromJson) return fromJson

  if (!isLocalDeployment(context, chainId)) return undefined

  return getAddressesFromEnvForChain(chainId, opts) ?? getAddressesFromEnv(opts)
}

// Same lookup as getAddressesWithFallback, but throws naming the first
// contract without an address.
export function requireAddresses(
  context: string,
  chainId: number,
  opts?: EnvOpts
): ContractAddresses {
  const addresses = getAddressesWithFallback(context, chainId, opts)

  if (addresses) return addresses

  const fromJson = getDeployment(context, chainId)?.addresses

  const missing =
    requiredAddressKeys.find((key) => !isDeployedAddress(fromJson?.[key])) ?? requiredAddressKeys[0]

  const source = isLocalDeployment(context, chainId)
    ? `addresses.json or ${envKeys[missing]}_${chainId}`
    : 'addresses.json (zero or missing)'

  throw new Error(`${missing} is not deployed for ${context}/${chainId}: no address in ${source}`)
}

export function getChainIdForDeployment(context: string): number {
  switch (context) {
    case 'local':
    case 'local_dev':
      return 31337
    case 'stage':
      return 84532
    case 'prod':
      return 8453
  }

  throw new Error(`[getChainIdForDeployment] Invalid env: ${context}`)
}
