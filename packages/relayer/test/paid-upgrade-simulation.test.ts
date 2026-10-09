import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RelayerService } from '../src/services/relayer'
import { stubRelayerChainClient } from './helpers/fakes'
import { silentLogger } from './helpers/logger'

const EOA = '0x00000000000000000000000000000000000000aa'

const ACCOUNT_PROXY = '0x2345678901234567890123456789012345678901'

const OTHER = '0x00000000000000000000000000000000000000bb'

const mockGetCode = vi.fn()

const mockCall = vi.fn()

function relayer(): RelayerService {
    return new RelayerService(
        {
            chainId: 8453,
            rpcUrl: 'http://rpc.test/8453',
            contracts: {
                orchestrator: '0x3456789012345678901234567890123456789012',
                simulator: '0x5678901234567890123456789012345678901234',
                accountProxy: ACCOUNT_PROXY,
                account: '0x1234567890123456789012345678901234567890',
                simpleFunder: '0x4567890123456789012345678901234567890123',
                simpleSettler: '0x6789012345678901234567890123456789012345',
                escrow: '0x7890123456789012345678901234567890123456',
                multiSigSigner: '0x8901234567890123456789012345678901234567',
            },
        },
        silentLogger(),
        undefined,
        undefined,
        {
            publicClient: stubRelayerChainClient({
                getCode: mockGetCode,
                call: mockCall,
            }),
        },
    )
}

const calls = [
    {
        to: '0x0000000000000000000000000000000000000002',
        value: '0x0',
        data: '0x',
    },
]

describe('paid upgrade simulation state override', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetCode.mockResolvedValue('0x')
        mockCall.mockResolvedValue({ data: '0x5208' })
    })

    it('returns DELEGATION_PENDING for an undelegated EOA with no authorization', async () => {
        const result = await relayer().simulateIntent({ eoa: EOA, calls })

        expect(result.success).toBe(false)
        expect(result.errorCode).toBe('DELEGATION_PENDING')
        expect(mockCall).not.toHaveBeenCalled()
    })

    it('state-overrides the EOA to the account proxy when the authorization matches', async () => {
        const result = await relayer().simulateIntent({
            eoa: EOA,
            calls,
            delegation: ACCOUNT_PROXY,
        })

        expect(result.success).toBe(true)
        expect(result.gasUsed).toBe('21000')
        expect(mockCall).toHaveBeenCalledOnce()
        const override = mockCall.mock.calls[0][0].stateOverride
        expect(override).toEqual([
            {
                address: EOA,
                code: `0xef0100${ACCOUNT_PROXY.slice(2).toLowerCase()}`,
            },
        ])
    })

    it('refuses a delegation target that is not the account proxy', async () => {
        const result = await relayer().simulateIntent({
            eoa: EOA,
            calls,
            delegation: OTHER,
        })

        expect(result.success).toBe(false)
        expect(result.error).toBe('Delegation target is not the account proxy')
        expect(mockCall).not.toHaveBeenCalled()
    })
})
