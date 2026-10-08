import {
    executeAccountCreate as executeAccountCreateImpl,
    type AccountCreateDeps,
} from '../../src/lib/account-create'
import {
    executeAccountDelegate as executeAccountDelegateImpl,
    type AccountDelegateDeps,
} from '../../src/lib/account-delegate'
import {
    executeAccountExport as executeAccountExportImpl,
    type AccountExportDeps,
} from '../../src/lib/account-export'
import {
    executeAccountSend as executeAccountSendImpl,
    type AccountSendDeps,
} from '../../src/lib/account-send'
import {
    executeAccountSwap as executeAccountSwapImpl,
    type AccountSwapDeps,
} from '../../src/lib/account-swap'
import {
    executeSignedCalls as executeSignedCallsImpl,
    type ExecuteSignedCallsDeps,
    type ExecuteSignedCallsParams,
} from '../../src/lib/execute-calls'
import {
    executePermissionsGrant as executePermissionsGrantImpl,
    type PermissionsGrantDeps,
} from '../../src/lib/permissions-grant'
import {
    executePermissionsList as executePermissionsListImpl,
    type PermissionsListDeps,
} from '../../src/lib/permissions-list'
import {
    executePermissionsRevoke as executePermissionsRevokeImpl,
    type PermissionsRevokeDeps,
} from '../../src/lib/permissions-revoke'
import {
    executePermissionsShow as executePermissionsShowImpl,
    type PermissionsShowDeps,
} from '../../src/lib/permissions-show'
import {
    executeAccountUpdatePassword as executeAccountUpdatePasswordImpl,
    type AccountUpdatePasswordDeps,
} from '../../src/lib/account-update-password'
import {
    executeSessionCreate as executeSessionCreateImpl,
    type SessionCreateDeps,
} from '../../src/lib/session-create'
import {
    executeSessionList as executeSessionListImpl,
    type SessionListDeps,
} from '../../src/lib/session-list'
import {
    executeSessionRevoke as executeSessionRevokeImpl,
    type SessionRevokeDeps,
} from '../../src/lib/session-revoke'
import {
    executeSessionRotate as executeSessionRotateImpl,
    type SessionRotateDeps,
} from '../../src/lib/session-rotate'
import { stubDeps } from './typed-mock'

/** Partial of a Deps bag. Function slots accept bun mocks whose inferred impl is slightly narrower. */
type PartialDeps<T> = {
    [K in keyof T]?: T[K] extends (...args: infer _A) => infer _R ? T[K] | CallableFunction : T[K]
}

function withPartialDeps<I, D, R>(
    fn: (input: I, deps?: Partial<D>) => R,
    input: I,
    deps: PartialDeps<D> | undefined,
): R {
    if (deps === undefined) return fn(input, undefined)

    // SAFETY: each installed function is the dep method this test calls; bun mocks are that callable at runtime.
    return fn(input, stubDeps<Partial<D>, PartialDeps<D>>(deps))

}

export function executeSessionRotate(
    options: Parameters<typeof executeSessionRotateImpl>[0],
    deps?: PartialDeps<SessionRotateDeps>,
): ReturnType<typeof executeSessionRotateImpl> {
    return withPartialDeps(executeSessionRotateImpl, options, deps)
}

export function executeAccountSwap(
    options: Parameters<typeof executeAccountSwapImpl>[0],
    deps?: PartialDeps<AccountSwapDeps>,
): ReturnType<typeof executeAccountSwapImpl> {
    return withPartialDeps(executeAccountSwapImpl, options, deps)
}

export function executeAccountSend(
    options: Parameters<typeof executeAccountSendImpl>[0],
    deps?: PartialDeps<AccountSendDeps>,
): ReturnType<typeof executeAccountSendImpl> {
    return withPartialDeps(executeAccountSendImpl, options, deps)
}

export function executeAccountCreate(
    options: Parameters<typeof executeAccountCreateImpl>[0],
    deps?: PartialDeps<AccountCreateDeps>,
): ReturnType<typeof executeAccountCreateImpl> {
    return withPartialDeps(executeAccountCreateImpl, options, deps)
}

export function executeAccountDelegate(
    options: Parameters<typeof executeAccountDelegateImpl>[0],
    deps?: PartialDeps<AccountDelegateDeps>,
): ReturnType<typeof executeAccountDelegateImpl> {
    return withPartialDeps(executeAccountDelegateImpl, options, deps)
}

export function executeAccountExport(
    options: Parameters<typeof executeAccountExportImpl>[0],
    deps?: PartialDeps<AccountExportDeps>,
): ReturnType<typeof executeAccountExportImpl> {
    return withPartialDeps(executeAccountExportImpl, options, deps)
}

export function executePermissionsGrant(
    options: Parameters<typeof executePermissionsGrantImpl>[0],
    deps?: PartialDeps<PermissionsGrantDeps>,
): ReturnType<typeof executePermissionsGrantImpl> {
    return withPartialDeps(executePermissionsGrantImpl, options, deps)
}

export function executePermissionsList(
    options: Parameters<typeof executePermissionsListImpl>[0],
    deps?: PartialDeps<PermissionsListDeps>,
): ReturnType<typeof executePermissionsListImpl> {
    return withPartialDeps(executePermissionsListImpl, options, deps)
}

export function executePermissionsRevoke(
    options: Parameters<typeof executePermissionsRevokeImpl>[0],
    deps?: PartialDeps<PermissionsRevokeDeps>,
): ReturnType<typeof executePermissionsRevokeImpl> {
    return withPartialDeps(executePermissionsRevokeImpl, options, deps)
}

export function executePermissionsShow(
    options: Parameters<typeof executePermissionsShowImpl>[0],
    deps?: PartialDeps<PermissionsShowDeps>,
): ReturnType<typeof executePermissionsShowImpl> {
    return withPartialDeps(executePermissionsShowImpl, options, deps)
}

export function executeSessionList(
    options: Parameters<typeof executeSessionListImpl>[0],
    deps?: PartialDeps<SessionListDeps>,
): ReturnType<typeof executeSessionListImpl> {
    return withPartialDeps(executeSessionListImpl, options, deps)
}

export function executeSessionRevoke(
    options: Parameters<typeof executeSessionRevokeImpl>[0],
    deps?: PartialDeps<SessionRevokeDeps>,
): ReturnType<typeof executeSessionRevokeImpl> {
    return withPartialDeps(executeSessionRevokeImpl, options, deps)
}

export function executeAccountUpdatePassword(
    options: Parameters<typeof executeAccountUpdatePasswordImpl>[0],
    deps?: PartialDeps<AccountUpdatePasswordDeps>,
): ReturnType<typeof executeAccountUpdatePasswordImpl> {
    return withPartialDeps(executeAccountUpdatePasswordImpl, options, deps)
}

export function executeSessionCreate(
    options: Parameters<typeof executeSessionCreateImpl>[0],
    deps?: PartialDeps<SessionCreateDeps>,
): ReturnType<typeof executeSessionCreateImpl> {
    return withPartialDeps(executeSessionCreateImpl, options, deps)
}

export function executeSignedCalls(
    deps: PartialDeps<ExecuteSignedCallsDeps>,
    params: ExecuteSignedCallsParams,
): ReturnType<typeof executeSignedCallsImpl> {
    return executeSignedCallsImpl(stubDeps<ExecuteSignedCallsDeps, PartialDeps<ExecuteSignedCallsDeps>>(deps), params)
}
