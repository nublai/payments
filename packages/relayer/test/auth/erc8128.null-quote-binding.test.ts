import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'

import { bindingFromRpcBody, decideErc8128Signer } from '../../src/auth/erc8128/signer-policy'

const SIGNER = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')

const PROTECTED = new Set(['wallet_sendPreparedCalls', 'wallet_getKeys'])

const sendWithNullQuote = {
    jsonrpc: '2.0',
    id: 1,
    method: 'wallet_sendPreparedCalls',
    params: { context: { quote: null } },
}

const getKeys = {
    jsonrpc: '2.0',
    id: 2,
    method: 'wallet_getKeys',
    params: {},
}

function prodDecision(binding: ReturnType<typeof bindingFromRpcBody>) {
    return decideErc8128Signer({
        env: { CONTEXT: 'prod', ERC8128_ALLOWED_SIGNERS: '' },
        signer: SIGNER,
        binding,
    })
}

describe('ERC-8128 binding for a null send quote', () => {
    it('returns empty accounts and the unbound-signer refusal', () => {
        const binding = bindingFromRpcBody(sendWithNullQuote, PROTECTED)

        expect(binding).toEqual({ accounts: [], otherProtectedMethods: [] })
        expect(prodDecision(binding)).toEqual({
            ok: false,
            tryOnChain: false,
            message: 'ERC-8128 signer is not allowlisted and is not bound to the intent account',
        })
    })

    it('keeps otherProtectedMethods when batched after another protected method', () => {
        const binding = bindingFromRpcBody([getKeys, sendWithNullQuote], PROTECTED)

        expect(binding).toEqual({
            accounts: [],
            otherProtectedMethods: ['wallet_getKeys'],
        })
        expect(prodDecision(binding)).toEqual({
            ok: false,
            tryOnChain: false,
            message: 'ERC-8128 signer must be allowlisted for this method',
        })
    })
})
