import { expect, test } from 'bun:test'
import {
    parseDaemonRequest,
    parseDaemonResponse,
    serializeDaemonRequest,
    type DaemonRequest,
} from '../src/lib/session-daemon-protocol'

test('protocol BigInt serialization is scoped to typedData only', () => {
    const request: DaemonRequest = {
        id: 'req-1',
        method: 'sign',
        params: {
            sessionName: '$bigint:42',
            typedData: {
                domain: {
                    name: 'demo',
                },
                types: {
                    EIP712Domain: [{ name: 'name', type: 'string' }],
                    Intent: [{ name: 'nonce', type: 'uint256' }],
                },
                primaryType: 'Intent',
                message: {
                    nonce: 42n,
                    label: '$bigint:not-a-number',
                },
            },
        },
    }

    const serialized = serializeDaemonRequest(request)
    expect(serialized).toContain('"$bigint:42"')
    expect(serialized).toContain('"$bigint:not-a-number"')

    const parsed = parseDaemonRequest(serialized)
    expect(parsed.method).toBe('sign')
    if (parsed.method !== 'sign') {
        throw new Error('Expected sign method')
    }

    expect(parsed.params.sessionName).toBe('$bigint:42')
    expect(parsed.params.typedData.message.nonce).toBe(42n)
    expect(parsed.params.typedData.message.label).toBe('$bigint:not-a-number')
})

test('protocol parses success and error responses', () => {
    const ok = parseDaemonResponse('{"id":"a","result":{"ok":true}}')
    expect('result' in ok).toBe(true)

    const err = parseDaemonResponse(
        '{"id":"b","error":{"code":"SESSION_NOT_FOUND","message":"missing"}}',
    )
    expect('error' in err).toBe(true)
    if ('error' in err) {
        expect(err.error.code).toBe('SESSION_NOT_FOUND')
    }
})

test('protocol rejects invalid request and response payloads', () => {
    expect(() => parseDaemonRequest('{"id":"a","method":"unknown","params":{}}')).toThrow(
        'Unknown daemon method',
    )
    expect(() => parseDaemonRequest('{"id":1,"method":"ping","params":{}}')).toThrow(
        'Invalid daemon request id',
    )
    expect(() =>
        parseDaemonResponse('{"id":"a","error":{"code":"NOT_REAL","message":"x"}}'),
    ).toThrow('Unknown daemon response error code')
})

test('protocol rejects sign request with missing or invalid typedData', () => {
    expect(() =>
        parseDaemonRequest('{"id":"a","method":"sign","params":{"sessionName":"s1"}}'),
    ).toThrow('Invalid sign params.typedData')
    expect(() =>
        parseDaemonRequest(
            '{"id":"a","method":"sign","params":{"sessionName":"s1","typedData":null}}',
        ),
    ).toThrow('Invalid sign params.typedData')
    expect(() =>
        parseDaemonRequest(
            '{"id":"a","method":"sign","params":{"sessionName":"s1","typedData":"not-an-object"}}',
        ),
    ).toThrow('Invalid sign params.typedData')
})

test('protocol parses loadKey optional agent fields and getSessionSecrets', () => {
    const load = parseDaemonRequest(
        JSON.stringify({
            id: 'load-1',
            method: 'loadKey',
            params: {
                name: 'agent-alice',
                privateKey: '0x' + '11'.repeat(32),
                address: '0x' + '22'.repeat(20),
                durationSeconds: 60,
                kind: 'agent',
                encryptionDevice: '0x1234',
            },
        }),
    )
    expect(load.method).toBe('loadKey')
    if (load.method === 'loadKey') {
        expect(load.params.kind).toBe('agent')
        expect(load.params.encryptionDevice).toBe('0x1234')
    }

    const getSecrets = parseDaemonRequest(
        '{"id":"sec-1","method":"getSessionSecrets","params":{"sessionName":"agent-alice"}}',
    )
    expect(getSecrets).toEqual({
        id: 'sec-1',
        method: 'getSessionSecrets',
        params: { sessionName: 'agent-alice' },
    })
})
