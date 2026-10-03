import { expect, test } from 'bun:test'
import { resolveAgentSendInput } from '../src/lib/agent-send-input'

test('resolveAgentSendInput treats the positional argument as the full message when channel is set', () => {
    expect(
        resolveAgentSendInput({
            channel: 'art',
            targetOrMessage: 'hello',
        }),
    ).toEqual({
        message: 'hello',
    })
})

test('resolveAgentSendInput joins all message parts when channel is set', () => {
    expect(
        resolveAgentSendInput({
            channel: 'art',
            targetOrMessage: 'hello',
            messageParts: ['from', 'alice'],
        }),
    ).toEqual({
        message: 'hello from alice',
    })
})

test('resolveAgentSendInput requires a message body when channel is not set', () => {
    expect(() =>
        resolveAgentSendInput({
            targetOrMessage: '77stream',
        }),
    ).toThrow('Message body is required.')
})

test('resolveAgentSendInput preserves stream id semantics when channel is not set', () => {
    expect(
        resolveAgentSendInput({
            targetOrMessage: '77stream',
            messageParts: ['hello', 'world'],
        }),
    ).toEqual({
        streamId: '77stream',
        message: 'hello world',
    })
})
