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
import { typedMock } from './typed-mock'

function withPartialDeps<I, D, R>(
    fn: (input: I, deps?: Partial<D>) => R,
    input: I,
    deps: Partial<D> | undefined,
): R {
    if (deps === undefined) return fn(input, undefined)

    return fn(input, deps)
}

export function executeSessionRotate(
    options: Parameters<typeof executeSessionRotateImpl>[0],
    deps?: Partial<SessionRotateDeps>,
): ReturnType<typeof executeSessionRotateImpl> {
    return withPartialDeps(executeSessionRotateImpl, options, deps)
}

export function executeAccountSwap(
    options: Parameters<typeof executeAccountSwapImpl>[0],
    deps?: Partial<AccountSwapDeps>,
): ReturnType<typeof executeAccountSwapImpl> {
    return withPartialDeps(executeAccountSwapImpl, options, deps)
}

export function executeAccountSend(
    options: Parameters<typeof executeAccountSendImpl>[0],
    deps?: Partial<AccountSendDeps>,
): ReturnType<typeof executeAccountSendImpl> {
    return withPartialDeps(executeAccountSendImpl, options, deps)
}

export function executeAccountCreate(
    options: Parameters<typeof executeAccountCreateImpl>[0],
    deps?: Partial<AccountCreateDeps>,
): ReturnType<typeof executeAccountCreateImpl> {
    return withPartialDeps(executeAccountCreateImpl, options, deps)
}

export function executeAccountDelegate(
    options: Parameters<typeof executeAccountDelegateImpl>[0],
    deps?: Partial<AccountDelegateDeps>,
): ReturnType<typeof executeAccountDelegateImpl> {
    return withPartialDeps(executeAccountDelegateImpl, options, deps)
}

export function executeAccountExport(
    options: Parameters<typeof executeAccountExportImpl>[0],
    deps?: Partial<AccountExportDeps>,
): ReturnType<typeof executeAccountExportImpl> {
    return withPartialDeps(executeAccountExportImpl, options, deps)
}

export function executePermissionsGrant(
    options: Parameters<typeof executePermissionsGrantImpl>[0],
    deps?: Partial<PermissionsGrantDeps>,
): ReturnType<typeof executePermissionsGrantImpl> {
    return withPartialDeps(executePermissionsGrantImpl, options, deps)
}

export function executePermissionsList(
    options: Parameters<typeof executePermissionsListImpl>[0],
    deps?: Partial<PermissionsListDeps>,
): ReturnType<typeof executePermissionsListImpl> {
    return withPartialDeps(executePermissionsListImpl, options, deps)
}

export function executePermissionsRevoke(
    options: Parameters<typeof executePermissionsRevokeImpl>[0],
    deps?: Partial<PermissionsRevokeDeps>,
): ReturnType<typeof executePermissionsRevokeImpl> {
    return withPartialDeps(executePermissionsRevokeImpl, options, deps)
}

export function executePermissionsShow(
    options: Parameters<typeof executePermissionsShowImpl>[0],
    deps?: Partial<PermissionsShowDeps>,
): ReturnType<typeof executePermissionsShowImpl> {
    return withPartialDeps(executePermissionsShowImpl, options, deps)
}

export function executeSessionList(
    options: Parameters<typeof executeSessionListImpl>[0],
    deps?: Partial<SessionListDeps>,
): ReturnType<typeof executeSessionListImpl> {
    return withPartialDeps(executeSessionListImpl, options, deps)
}

export function executeSessionRevoke(
    options: Parameters<typeof executeSessionRevokeImpl>[0],
    deps?: Partial<SessionRevokeDeps>,
): ReturnType<typeof executeSessionRevokeImpl> {
    return withPartialDeps(executeSessionRevokeImpl, options, deps)
}

export function executeAccountUpdatePassword(
    options: Parameters<typeof executeAccountUpdatePasswordImpl>[0],
    deps?: Partial<AccountUpdatePasswordDeps>,
): ReturnType<typeof executeAccountUpdatePasswordImpl> {
    return withPartialDeps(executeAccountUpdatePasswordImpl, options, deps)
}

export function executeSessionCreate(
    options: Parameters<typeof executeSessionCreateImpl>[0],
    deps?: Partial<SessionCreateDeps>,
): ReturnType<typeof executeSessionCreateImpl> {
    return withPartialDeps(executeSessionCreateImpl, options, deps)
}

function completeSignedCallsDeps(overrides: Partial<ExecuteSignedCallsDeps> = {}): ExecuteSignedCallsDeps {
    return {
        prepareCalls: typedMock<ExecuteSignedCallsDeps['prepareCalls']>(async () => {
            throw new Error('not stubbed')
        }),
        signTypedData: typedMock<ExecuteSignedCallsDeps['signTypedData']>(async () => {
            throw new Error('not stubbed')
        }),
        sendPreparedCalls: typedMock<ExecuteSignedCallsDeps['sendPreparedCalls']>(async () => {
            throw new Error('not stubbed')
        }),
        waitForBundle: typedMock<ExecuteSignedCallsDeps['waitForBundle']>(async () => {
            throw new Error('not stubbed')
        }),
        ...overrides,
    }
}

export function executeSignedCalls(
    deps: Partial<ExecuteSignedCallsDeps>,
    params: ExecuteSignedCallsParams,
): ReturnType<typeof executeSignedCallsImpl> {
    return executeSignedCallsImpl(completeSignedCallsDeps(deps), params)
}
