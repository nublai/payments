import { afterEach, expect, test } from 'bun:test'
import { resolveCliProcessExitCode, updateCliProcessExitCode } from '../src/cli-runtime'

const originalExitCode = process.exitCode

afterEach(() => {
    process.exitCode = originalExitCode
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
