import { afterEach, expect, test } from 'bun:test'
import { resolveCliProcessExitCode, updateCliProcessExitCode } from '../src/cli-runtime'

const originalExitCode = process.exitCode

afterEach(() => {
    // Assigning undefined does not clear Bun's process.exitCode, so a test that
    // sets 130 would fail the suite even though every assertion passed.
    process.exitCode = originalExitCode ?? 0
})

test('updateCliProcessExitCode preserves an existing non-zero exit code when framework reports 0', () => {
    process.exitCode = 130

    updateCliProcessExitCode(0)

    expect(process.exitCode).toBe(130)
})

test('updateCliProcessExitCode accepts a non-zero framework exit code', () => {
    process.exitCode = 0

    updateCliProcessExitCode(1)

    expect(process.exitCode).toBe(1)
})

test('resolveCliProcessExitCode prefers process.exitCode over the fallback', () => {
    process.exitCode = 130

    expect(resolveCliProcessExitCode(0)).toBe(130)
})
