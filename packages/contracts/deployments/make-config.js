import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const artifactsDir = path.join(__dirname, 'envs') // Raw build envs from Solidity scripts

// Walk envs/{context}/{chainId}/*.json and build structure per context
function getDeploymentsByContext() {
  const byContext = {}

  if (!fs.existsSync(artifactsDir)) {
    console.log(`No ${artifactsDir}/ directory found`)

    return byContext
  }

  const contexts = fs
    .readdirSync(artifactsDir)
    .filter((f) => fs.statSync(path.join(artifactsDir, f)).isDirectory())

  for (const context of contexts) {
    byContext[context] = {}
    const contextPath = path.join(artifactsDir, context)

    const chains = fs
      .readdirSync(contextPath)
      .filter((f) => fs.statSync(path.join(contextPath, f)).isDirectory())

    for (const chainIdStr of chains) {
      const chainId = parseInt(chainIdStr, 10)
      const chainDir = path.join(contextPath, chainIdStr)

      const contractFiles = fs
        .readdirSync(chainDir)
        .filter((f) => f.endsWith('.json'))

      // Build addresses from individual contract files
      const addresses = {}

      for (const file of contractFiles) {
        const contractName = path.basename(file, '.json')
        const contractData = JSON.parse(fs.readFileSync(path.join(chainDir, file), 'utf8'))
        addresses[contractName] = contractData.address
      }

      byContext[context][chainId] = {
        addresses,
      }
    }
  }

  return byContext
}

function addressMustBeString(value, label) {
  if (value === undefined || value === null || Array.isArray(value) || value !== `${value}`) {
    const got =
      value === undefined ? 'undefined' : value === null ? 'null' : Array.isArray(value) ? 'array' : 'non-string'

    throw new Error(`make-config: ${label} must be a string address (got ${got})`)
  }
}

// Convert camelCase to UPPER_SNAKE_CASE
function keyToEnvKey(key) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toUpperCase()
}

// Convert context data to .env format
function convertToEnv(contextData, context) {
  let envContent = ``
  const chainIds = Object.keys(contextData).sort((a, b) => Number(a) - Number(b))
  const isLocal = context.startsWith('local')
  const shouldSuffixByChain = isLocal || chainIds.length > 1

  for (const chainId of chainIds) {
    const chainData = contextData[chainId]

    if (shouldSuffixByChain) {
      envContent += `# chain ${chainId}\n`
    }

    // Add addresses with {CONTRACT}_{chainId} suffix when context has multiple chains.
    const addresses = chainData.addresses || {}

    for (const key of Object.keys(addresses).sort()) {
      const value = addresses[key]
      addressMustBeString(value, `${context}/${chainId} "${key}"`)

      const baseKey = keyToEnvKey(key)
      const envKey = shouldSuffixByChain ? `${baseKey}_${chainId}` : baseKey
      envContent += `${envKey}=${value}\n`
    }
  }

  return envContent
}

// Write .env files for a context inside envs/{context}/
function writeEnvFiles(context, contextData) {
  const contextPath = path.join(artifactsDir, context)
  fs.mkdirSync(contextPath, { recursive: true })

  const envContent = convertToEnv(contextData, context)

  // Write .env
  fs.writeFileSync(path.join(contextPath, '.env'), envContent)

  // Write .env.vite (prefix all keys with VITE_)
  const viteEnvContent = envContent
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()

      if (!trimmed) return line

      if (trimmed.startsWith('#')) return line

      return `VITE_${line}`
    })
    .join('\n')

  fs.writeFileSync(path.join(contextPath, '.env.vite'), viteEnvContent)

  return contextPath
}

// Sort object keys recursively to ensure deterministic JSON output
function sortObjectKeys(obj) {
  if (obj === undefined || obj === null || Array.isArray(obj)) {
    const got = obj === undefined ? 'undefined' : obj === null ? 'null' : 'array'

    throw new Error(`make-config: address values must be strings (got ${got})`)
  }

  if (obj === `${obj}`) {
    return obj
  }

  if (Object.getPrototypeOf(obj) !== Object.prototype) {
    throw new Error('make-config: address values must be strings (got non-string)')
  }

  const sorted = {}

  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key])
  }

  return sorted
}

// Main
const byContext = getDeploymentsByContext()

if (Object.keys(byContext).length === 0) {
  console.log('No deployments found to process')
  process.exit(0)
}

// Generate .env files per context inside deployments/{context}/
// (do this first so local env files are created before we remove local from output)
for (const context of Object.keys(byContext).sort()) {
  const contextPath = writeEnvFiles(context, byContext[context])
  console.log(`Wrote .env files at ${contextPath}/`)
}

// Always delete local environments from addresses.json
// (addresses.json is checked in, so we don't want local dev addresses committed)
for (const key of Object.keys(byContext)) {
  if (key.startsWith('local')) {
    delete byContext[key]
  }
}

// Write addresses.json to deployments/ (after removing local)
// Sort keys to ensure deterministic output regardless of fs.readdirSync order
const deploymentsFile = path.join(__dirname, 'addresses.json')

fs.writeFileSync(deploymentsFile, JSON.stringify(sortObjectKeys(byContext), null, 2))

console.log(`Wrote ${deploymentsFile}`)
