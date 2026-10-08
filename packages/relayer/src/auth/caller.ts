import type { RpcCaller } from '../rpc/types'

export type { RpcCaller }

const callers = new WeakMap<Request, RpcCaller>()

export function setRpcCaller(request: Request, caller: RpcCaller): void {
    callers.set(request, caller)
}

export function getRpcCaller(request: Request | undefined): RpcCaller | undefined {
    if (!request) return undefined

    return callers.get(request)
}
