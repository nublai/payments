/**
 * Stub Methods
 *
 * Placeholder implementations for methods not yet implemented.
 * These return a "method not implemented" error.
 */

import type { JsonRpcParams, RpcContext } from '../types'
import { RpcError, METHOD_NOT_IMPLEMENTED } from '../errors'

/**
 * wallet_getAssets - Gets all assets (native + ERC20) for an account
 *
 * Not yet implemented.
 */
export async function handleGetAssets(_params: JsonRpcParams | undefined, _ctx: RpcContext): Promise<never> {
    throw new RpcError(METHOD_NOT_IMPLEMENTED, 'wallet_getAssets not implemented')
}
