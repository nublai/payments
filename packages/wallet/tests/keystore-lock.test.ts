import { expect, mock, test } from 'bun:test'

test('withKeystoreLock preserves the action error when release also fails', async () => {
    const release = mock(async () => {
        throw new Error('release failed')
    })
    const lock = mock(async () => release)

    mock.module('proper-lockfile', () => ({
        default: { lock },
    }))

    const { withKeystoreLock } = await import(`../src/lib/keystore?lock-action-${Date.now()}`)

    await expect(
        withKeystoreLock('/tmp/default.keystore.json', async () => {
            throw new Error('action failed')
        }),
    ).rejects.toThrow('action failed')

    expect(lock).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})

test('withKeystoreLock surfaces the release error when action succeeds', async () => {
    const release = mock(async () => {
        throw new Error('release failed')
    })
    const lock = mock(async () => release)

    mock.module('proper-lockfile', () => ({
        default: { lock },
    }))

    const { withKeystoreLock } = await import(`../src/lib/keystore?lock-release-${Date.now()}`)

    await expect(
        withKeystoreLock('/tmp/default.keystore.json', async () => undefined),
    ).rejects.toThrow('release failed')

    expect(lock).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
})
