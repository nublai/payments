import { describe, expect, it } from 'vitest'
import {
    encodeAbiParameters,
    getAddress,
    parseAbiParameters,
    zeroAddress,
    type Address,
    type Hex,
} from 'viem'
import { hex, repeatedHex } from '../helpers/hex.js'
import { hashAuthorization, hashTypedData } from 'viem/utils'
import {
    bindPreparedUpgrade,
    buildUpgradeExecution,
    SIGNED_CALL_TYPES,
    UPGRADE_PRECALL_NONCE,
} from '../../src/helpers/bindPreparedUpgrade.js'
import type { AuthorizeKey } from '../../src/actions/upgradeAccount.js'

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111'

const PROXY: Address = '0x3Be52867f8Dca2911f81076B37921c334dE29551'

const ORCHESTRATOR: Address = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8'

const ATTACKER = getAddress('0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF')

const CHAIN_ID = 8453

const TX_NONCE = 5n

const KEY: AuthorizeKey = {
    expiry: '0',
    type: 'secp256k1',
    role: 'normal',
    publicKey: repeatedHex('ab', 32),
    permissions: [
        {
            type: 'call',
            to: '0x2222222222222222222222222222222222222222',
            selector: '0xa9059cbb' },
        {
            type: 'spend',
            token: '0x3333333333333333333333333333333333333333',
            limit: '10',
            period: 'day' },
    ] }

function expected() {
    return {
        accountAddress: ACCOUNT,
        chainId: CHAIN_ID,
        delegation: PROXY,
        orchestrator: ORCHESTRATOR,
        authorizationNonce: TX_NONCE,
        authorizeKeys: [KEY] }
}

function honestPrepared() {
    const { calls, executionData } = buildUpgradeExecution([KEY], ACCOUNT)

    const authDigest = hashAuthorization({
        chainId: CHAIN_ID,
        contractAddress: PROXY,
        nonce: Number(TX_NONCE) })

    const domain = {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId: CHAIN_ID,
        verifyingContract: ORCHESTRATOR }

    const message = {
        multichain: false,
        eoa: ACCOUNT,
        calls,
        nonce: UPGRADE_PRECALL_NONCE }

    const execDigest = hashTypedData({
        domain,
        types: SIGNED_CALL_TYPES,
        primaryType: 'SignedCall',
        message })

    return {
        digests: { auth: authDigest, exec: execDigest },
        typedData: {
            domain,
            types: SIGNED_CALL_TYPES,
            primaryType: 'SignedCall' as const,
            message: {
                ...message,
                calls: calls.map((call) => ({
                    to: call.to,
                    value: call.value.toString(),
                    data: call.data })),
                nonce: UPGRADE_PRECALL_NONCE.toString() } },
        context: {
            authorization: {
                contractAddress: PROXY,
                chainId: CHAIN_ID,
                nonce: Number(TX_NONCE) },
            preCall: {
                eoa: ACCOUNT,
                executionData,
                nonce: UPGRADE_PRECALL_NONCE.toString() } } }
}

describe('bindPreparedUpgrade', () => {
    it('returns the rebuilt SignedCall when the relayer payload matches', () => {
        const prepared = honestPrepared()
        const bound = bindPreparedUpgrade(prepared, expected())
        expect(bound.authDigest.toLowerCase()).toBe(prepared.digests.auth.toLowerCase())
        expect(bound.typedData.domain).toEqual({
            name: 'Orchestrator',
            version: '0.5.5',
            chainId: CHAIN_ID,
            verifyingContract: ORCHESTRATOR })
        expect(bound.typedData.message.calls).toEqual(buildUpgradeExecution([KEY], ACCOUNT).calls)
        expect(bound.typedData.message.nonce).toBe(UPGRADE_PRECALL_NONCE)
    })

    it('refuses an authorization for a different chain, nonce, or delegation', () => {
        const wrongChain = honestPrepared()
        wrongChain.digests.auth = hashAuthorization({
            chainId: 1,
            contractAddress: ATTACKER,
            nonce: Number(TX_NONCE) })
        wrongChain.context.authorization = {
            contractAddress: ATTACKER,
            chainId: 1,
            nonce: Number(TX_NONCE) }
        expect(() => bindPreparedUpgrade(wrongChain, expected())).toThrow(/authorization digest does not match/)

        const wrongNonce = honestPrepared()
        wrongNonce.digests.auth = hashAuthorization({
            chainId: CHAIN_ID,
            contractAddress: PROXY,
            nonce: 9 })
        wrongNonce.context.authorization.nonce = 9
        expect(() => bindPreparedUpgrade(wrongNonce, expected())).toThrow(/authorization digest does not match/)
    })

    it('refuses an attacker call in the SignedCall', () => {
        const prepared = honestPrepared()

        const calls: Array<{ to: Address; value: bigint; data: Hex }> = [
            { to: ATTACKER, value: 0n, data: hex('0xdeadbeef') },
        ]

        const executionData = encodeAbiParameters(
            parseAbiParameters('(address to, uint256 value, bytes data)[]'),
            [calls],
        )

        prepared.context.preCall.executionData = executionData
        prepared.typedData.message.calls = calls.map((call) => ({
            to: call.to,
            value: call.value.toString(),
            data: call.data }))
        expect(() => bindPreparedUpgrade(prepared, expected())).toThrow(/execution data does not match/)
        expect(prepared.context.authorization.contractAddress).not.toBe(zeroAddress)
    })
})
