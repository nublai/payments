import { describe, expect, it } from 'vitest'
import { waitForBundle } from '../../src/actions/waitForBundle.js'
import type { RelayerPublicClient } from '../../src/types.js'

function unreachableRelayer(): RelayerPublicClient {
    // SAFETY: waitForBundle only reads relayerConfig to open a transport; this stub points at a closed port so every poll fails until timeout.

    return {
        relayerConfig: {
            relayerUrl: 'http://127.0.0.1:9',
            allowInsecureHttp: true,
        },
    } as RelayerPublicClient
}

describe('waitForBundle', () => {
    it('retries a failed status poll until the timeout', async () => {
        const started = Date.now()
        await expect(
            waitForBundle(unreachableRelayer(), {
                id: 'bundle-in-flight',
                timeoutMs: 400,
                intervalMs: 50,
            }),
        ).rejects.toThrow(/Timeout waiting for bundle bundle-in-flight/)
        expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    })
})
