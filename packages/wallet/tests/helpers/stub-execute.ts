import { executeAccountCreate as executeAccountCreateImpl } from '../../src/lib/account-create'
import { executeAccountDelegate as executeAccountDelegateImpl } from '../../src/lib/account-delegate'
import { executeAccountExport as executeAccountExportImpl } from '../../src/lib/account-export'
import { executeAccountSend as executeAccountSendImpl } from '../../src/lib/account-send'
import { executeAccountSwap as executeAccountSwapImpl } from '../../src/lib/account-swap'
import { executeSignedCalls as executeSignedCallsImpl } from '../../src/lib/execute-calls'
import { executePermissionsGrant as executePermissionsGrantImpl } from '../../src/lib/permissions-grant'
import { executePermissionsList as executePermissionsListImpl } from '../../src/lib/permissions-list'
import { executePermissionsRevoke as executePermissionsRevokeImpl } from '../../src/lib/permissions-revoke'
import { executePermissionsShow as executePermissionsShowImpl } from '../../src/lib/permissions-show'
import { executeAccountUpdatePassword as executeAccountUpdatePasswordImpl } from '../../src/lib/account-update-password'
import { executeSessionCreate as executeSessionCreateImpl } from '../../src/lib/session-create'
import { executeSessionList as executeSessionListImpl } from '../../src/lib/session-list'
import { executeSessionRevoke as executeSessionRevokeImpl } from '../../src/lib/session-revoke'
import { executeSessionRotate as executeSessionRotateImpl } from '../../src/lib/session-rotate'
import { stubDeps } from './typed-mock'

function withPartialDeps<I, D, R, E>(
    fn: (input: I, deps?: D) => R,
    input: I,
    deps: E | undefined,
): R {
    return fn(input, deps === undefined ? undefined : stubDeps<D, E>(deps))
}

export function executeSessionRotate<E>(
    options: Parameters<typeof executeSessionRotateImpl>[0],
    deps?: E,
): ReturnType<typeof executeSessionRotateImpl> {
    return withPartialDeps(executeSessionRotateImpl, options, deps)
}

export function executeAccountSwap<E>(
    options: Parameters<typeof executeAccountSwapImpl>[0],
    deps?: E,
): ReturnType<typeof executeAccountSwapImpl> {
    return withPartialDeps(executeAccountSwapImpl, options, deps)
}

export function executeAccountSend<E>(
    options: Parameters<typeof executeAccountSendImpl>[0],
    deps?: E,
): ReturnType<typeof executeAccountSendImpl> {
    return withPartialDeps(executeAccountSendImpl, options, deps)
}

export function executeAccountCreate<E>(
    options: Parameters<typeof executeAccountCreateImpl>[0],
    deps?: E,
): ReturnType<typeof executeAccountCreateImpl> {
    return withPartialDeps(executeAccountCreateImpl, options, deps)
}

export function executeAccountDelegate<E>(
    options: Parameters<typeof executeAccountDelegateImpl>[0],
    deps?: E,
): ReturnType<typeof executeAccountDelegateImpl> {
    return withPartialDeps(executeAccountDelegateImpl, options, deps)
}

export function executeAccountExport<E>(
    options: Parameters<typeof executeAccountExportImpl>[0],
    deps?: E,
): ReturnType<typeof executeAccountExportImpl> {
    return withPartialDeps(executeAccountExportImpl, options, deps)
}

export function executePermissionsGrant<E>(
    options: Parameters<typeof executePermissionsGrantImpl>[0],
    deps?: E,
): ReturnType<typeof executePermissionsGrantImpl> {
    return withPartialDeps(executePermissionsGrantImpl, options, deps)
}

export function executePermissionsList<E>(
    options: Parameters<typeof executePermissionsListImpl>[0],
    deps?: E,
): ReturnType<typeof executePermissionsListImpl> {
    return withPartialDeps(executePermissionsListImpl, options, deps)
}

export function executePermissionsRevoke<E>(
    options: Parameters<typeof executePermissionsRevokeImpl>[0],
    deps?: E,
): ReturnType<typeof executePermissionsRevokeImpl> {
    return withPartialDeps(executePermissionsRevokeImpl, options, deps)
}

export function executePermissionsShow<E>(
    options: Parameters<typeof executePermissionsShowImpl>[0],
    deps?: E,
): ReturnType<typeof executePermissionsShowImpl> {
    return withPartialDeps(executePermissionsShowImpl, options, deps)
}

export function executeSessionList<E>(
    options: Parameters<typeof executeSessionListImpl>[0],
    deps?: E,
): ReturnType<typeof executeSessionListImpl> {
    return withPartialDeps(executeSessionListImpl, options, deps)
}

export function executeSessionRevoke<E>(
    options: Parameters<typeof executeSessionRevokeImpl>[0],
    deps?: E,
): ReturnType<typeof executeSessionRevokeImpl> {
    return withPartialDeps(executeSessionRevokeImpl, options, deps)
}

export function executeAccountUpdatePassword<E>(
    options: Parameters<typeof executeAccountUpdatePasswordImpl>[0],
    deps?: E,
): ReturnType<typeof executeAccountUpdatePasswordImpl> {
    return withPartialDeps(executeAccountUpdatePasswordImpl, options, deps)
}

export function executeSessionCreate<E>(
    options: Parameters<typeof executeSessionCreateImpl>[0],
    deps?: E,
): ReturnType<typeof executeSessionCreateImpl> {
    return withPartialDeps(executeSessionCreateImpl, options, deps)
}

export function executeSignedCalls<E, P>(
    deps: E,
    params: P,
): ReturnType<typeof executeSignedCallsImpl> {
    return executeSignedCallsImpl(
        stubDeps<Parameters<typeof executeSignedCallsImpl>[0], E>(deps),
        stubDeps<Parameters<typeof executeSignedCallsImpl>[1], P>(params),
    )
}
