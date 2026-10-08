import { expect, mock, test } from 'bun:test'
import { withKeystoreLock } from '../src/lib/keystore'

test('withKeystoreLock preserves the action error when release also fails', async () => {
    const release = mock(async () => {
        throw new Error('release failed')
    })

    const lock = mock(async () => release)

    await expect(
        withKeystoreLock(
            '/tmp/default.keystore.json',
            async () => {
                throw new Error('action failed')
            },
            lock,
        ),
    ).rejects.toThrow('action failed')

    expect(lock).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})

test('withKeystoreLock surfaces the release error when action succeeds', async () => {
    const release = mock(async () => {
        throw new Error('release failed')
    })

    const lock = mock(async () => release)

    await expect(
        withKeystoreLock('/tmp/default.keystore.json', async () => undefined, lock),
    ).rejects.toThrow('release failed')

    expect(lock).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})
