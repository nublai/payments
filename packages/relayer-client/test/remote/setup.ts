import { beforeAll } from 'vitest'

const REQUIRED_ENV = ['RELAYER_URL', 'RPC_URL', 'REMOTE_ACCOUNT_PROXY', 'TEST_CHAIN_ID'] as const

beforeAll(async () => {
    const missing = REQUIRED_ENV.filter((key) => !process.env[key])
    if (missing.length > 0) {
        console.warn(`Skipping remote tests; missing env vars: ${missing.join(', ')}`)
    }
})
