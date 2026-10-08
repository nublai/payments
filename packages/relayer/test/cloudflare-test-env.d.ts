import type { Env } from '../src/types/env'

// vitest-pool-workers ships `env` as an empty ProvidedEnv; the pool runs with the worker's bindings.
declare module 'cloudflare:test' {
    interface ProvidedEnv extends Env {}
}
