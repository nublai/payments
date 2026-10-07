import {
    parseKeyId,
    verifyRequest,
    type VerifyFailReason,
    type VerifyMessageArgs,
    type VerifyResult,
} from '@slicekit/erc8128'
import { verifyMessage as verifyPersonalMessage, type Address } from 'viem'

import { getChainClient } from '../../lib/multi-chain-client'
import { hasCode } from '../../lib/viem-utils'
import type { Env } from '../../types/env'
import { bindingFromRpcBody, decideErc8128Signer } from './signer-policy'

export interface NonceStore {
    consumeNonce(replayKey: string, ttlSeconds: number): Promise<boolean>
}

export interface Erc8128Config {
    maxValiditySeconds: number
    clockSkewSeconds: number
    requireRequestBound: boolean
    requireNonReplayable: boolean
    nonceStore: NonceStore
}

export interface Erc8128VerificationContext {
    env: Partial<Env>
    request: Request
    nowSeconds: number
}

export interface ParsedKeyId {
    raw: string
    namespace: 'erc8128'
    chainId: number
    address: Address
}

export interface Erc8128VerifyResult {
    ok: true
    keyId: ParsedKeyId
    signerType: 'EOA' | 'SCA'
    nonceKey: string
}

export type Erc8128VerifyFailureCode =
    | 'MISSING_HEADERS'
    | 'BAD_FORMAT'
    | 'BAD_KEYID'
    | 'SIGNER_NOT_ALLOWED'
    | 'UNSUPPORTED_CHAIN'
    | 'INVALID_TIME'
    | 'INVALID_COVERAGE'
    | 'MISSING_NONCE'
    | 'REPLAYED_NONCE'
    | 'BAD_CONTENT_DIGEST'
    | 'BAD_SIGNATURE'

export interface Erc8128VerifyFailure {
    ok: false
    code: Erc8128VerifyFailureCode
    message: string
}

export async function verifyErc8128Request(
    ctx: Erc8128VerificationContext,
    cfg: Erc8128Config,
): Promise<Erc8128VerifyResult | Erc8128VerifyFailure> {
    // verifyRequest reads the body. Keep a clone for the signer-binding check.
    const bodyRequest = ctx.request.clone()
    const keyIds = parseKeyIdsFromHeader(ctx.request.headers.get('signature-input'))

    if (keyIds.length === 0) {
        return failure('BAD_KEYID', 'Invalid or missing keyid in Signature-Input')
    }

    const supportedKeyIds = keyIds.filter((keyId) => isSupportedChain(keyId.chainId, ctx.env))
    if (supportedKeyIds.length === 0) {
        return failure('UNSUPPORTED_CHAIN', `Unsupported chain ID: ${keyIds[0].chainId}`)
    }

    const keyIdByAddress = new Map<string, ParsedKeyId>()
    for (const keyId of supportedKeyIds) {
        keyIdByAddress.set(keyId.address.toLowerCase(), keyId)
    }

    const verifyMessage = async (args: VerifyMessageArgs): Promise<boolean> => {
        const keyId = keyIdByAddress.get(args.address.toLowerCase())
        if (!keyId) {
            return false
        }

        let client: ReturnType<typeof getChainClient> | null = null
        try {
            client = getChainClient(keyId.chainId, ctx.env)
            const code = await client.getCode({ address: keyId.address })

            // Smart contract accounts (including delegated EOAs) should use chain verification.
            if (hasCode(code)) {
                try {
                    return await client.verifyMessage({
                        address: keyId.address,
                        message: args.message,
                        signature: args.signature,
                    })
                } catch {
                    // Fall through to local EOA check on transient RPC issues.
                }
            }
        } catch {
            // Fall through to local EOA check on transient RPC issues.
        }

        // Fast local path for EOAs (no RPC required).
        let isEoaValid = false
        try {
            isEoaValid = await verifyPersonalMessage({
                address: keyId.address,
                message: args.message,
                signature: args.signature,
            })
        } catch {
            // Treat malformed signatures and verifier errors as non-valid signatures.
            isEoaValid = false
        }
        if (isEoaValid) {
            return true
        }

        // Fallback chain verification path (if RPC is available).
        if (!client) {
            try {
                client = getChainClient(keyId.chainId, ctx.env)
            } catch {
                return false
            }
        }

        try {
            return await client.verifyMessage({
                address: keyId.address,
                message: args.message,
                signature: args.signature,
            })
        } catch {
            return false
        }
    }

    const result = await verifyRequest(
        ctx.request,
        verifyMessage,
        {
            consume: async (replayKey: string, ttlSeconds: number) =>
                cfg.nonceStore.consumeNonce(replayKey, Math.max(0, ttlSeconds)),
        },
        {
            label: 'eth',
            strictLabel: false,
            replayable: !cfg.requireNonReplayable,
            now: () => ctx.nowSeconds,
            clockSkewSec: cfg.clockSkewSeconds,
            maxValiditySec: cfg.maxValiditySeconds,
            additionalRequestBoundComponents: cfg.requireRequestBound ? [] : undefined,
        },
    )

    if (!result.ok) {
        return mapFailure(result)
    }

    const parsed = parseKeyId(result.params.keyid)
    if (!parsed) {
        return failure('BAD_KEYID', 'Invalid keyid format')
    }

    if (!isSupportedChain(parsed.chainId, ctx.env)) {
        return failure('UNSUPPORTED_CHAIN', `Unsupported chain ID: ${parsed.chainId}`)
    }

    const binding = await readBinding(bodyRequest)
    const decision = decideErc8128Signer({
        env: ctx.env,
        signer: parsed.address,
        binding,
    })
    if (!decision.ok) {
        return failure('SIGNER_NOT_ALLOWED', decision.message)
    }

    let signerType: 'EOA' | 'SCA' = 'EOA'
    try {
        const client = getChainClient(parsed.chainId, ctx.env)
        const code = await client.getCode({ address: parsed.address })
        if (hasCode(code)) {
            signerType = 'SCA'
        }
    } catch {
        // Keep conservative default; signature validity was already checked.
        signerType = 'EOA'
    }

    return {
        ok: true,
        keyId: {
            raw: result.params.keyid,
            namespace: 'erc8128',
            chainId: parsed.chainId,
            address: parsed.address,
        },
        signerType,
        nonceKey: result.params.nonce
            ? `${result.params.keyid}:${result.params.nonce}`
            : result.params.keyid,
    }
}

function parseKeyIdsFromHeader(header: string | null): ParsedKeyId[] {
    if (!header) {
        return []
    }

    const matches = header.matchAll(/keyid="([^"]+)"/g)
    const parsed: ParsedKeyId[] = []

    for (const match of matches) {
        const raw = match[1]
        const key = parseKeyId(raw)
        if (!key) {
            continue
        }

        parsed.push({
            raw,
            namespace: 'erc8128',
            chainId: key.chainId,
            address: key.address,
        })
    }

    return parsed
}

async function readBinding(request: Request) {
    try {
        return bindingFromRpcBody(await request.json())
    } catch {
        return { accounts: null }
    }
}

function isSupportedChain(chainId: number, env: Partial<Env>): boolean {
    const configured = env.CHAIN_IDS?.split(',')
        .map((id) => Number.parseInt(id.trim(), 10))
        .filter((id) => Number.isFinite(id))

    // An empty list is not "every chain". A worker that forgot CHAIN_IDS must not
    // accept a keyid for an arbitrary network.
    if (!configured || configured.length === 0) {
        return false
    }

    return configured.includes(chainId)
}

function mapFailure(result: Extract<VerifyResult, { ok: false }>): Erc8128VerifyFailure {
    const code = mapFailureCode(result.reason)
    return failure(code, result.detail ?? result.reason)
}

function mapFailureCode(reason: VerifyFailReason): Erc8128VerifyFailureCode {
    switch (reason) {
        case 'missing_headers':
            return 'MISSING_HEADERS'
        case 'bad_signature_input':
        case 'label_not_found':
            return 'BAD_FORMAT'
        case 'bad_keyid':
            return 'BAD_KEYID'
        case 'bad_time':
        case 'not_yet_valid':
        case 'expired':
        case 'validity_too_long':
            return 'INVALID_TIME'
        case 'not_request_bound':
        case 'class_bound_not_allowed':
            return 'INVALID_COVERAGE'
        case 'nonce_required':
        case 'replayable_not_allowed':
            return 'MISSING_NONCE'
        case 'replay':
            return 'REPLAYED_NONCE'
        case 'digest_required':
        case 'digest_mismatch':
            return 'BAD_CONTENT_DIGEST'
        case 'nonce_window_too_long':
        case 'replayable_invalidation_required':
        case 'replayable_not_before':
        case 'replayable_invalidated':
        case 'alg_not_allowed':
        case 'bad_signature_bytes':
        case 'bad_signature_check':
        case 'bad_signature':
            return 'BAD_SIGNATURE'
    }
}

function failure(code: Erc8128VerifyFailureCode, message: string): Erc8128VerifyFailure {
    return {
        ok: false,
        code,
        message,
    }
}
