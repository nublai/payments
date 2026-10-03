/**
 * Constants for permission setup
 *
 * These constants are used when configuring CallPermission entries for session keys.
 */

import type { Address, Hex } from 'viem'

/**
 * Special target address that matches any contract address.
 * Use in CallPermission.to to allow calls to any target.
 *
 * @example
 * ```typescript
 * const permission: CallPermission = {
 *   type: 'call',
 *   to: ANY_TARGET,
 *   selector: '0xa9059cbb' // ERC20 transfer
 * }
 * ```
 */
export const ANY_TARGET: Address = '0x3232323232323232323232323232323232323232'

/**
 * Special function selector that matches any function selector.
 * Use in CallPermission.selector to allow calls to any function.
 *
 * @example
 * ```typescript
 * const permission: CallPermission = {
 *   type: 'call',
 *   to: ANY_TARGET,
 *   selector: ANY_FUNCTION_SELECTOR
 * }
 * ```
 */
export const ANY_FUNCTION_SELECTOR: Hex = '0x32323232'

/**
 * Special function selector for calls with empty calldata (ETH transfers).
 * Use in CallPermission.selector to allow native ETH transfers.
 *
 * @example
 * ```typescript
 * // Allow sending ETH to any address
 * const permission: CallPermission = {
 *   type: 'call',
 *   to: ANY_TARGET,
 *   selector: EMPTY_CALLDATA_SELECTOR
 * }
 * ```
 */
export const EMPTY_CALLDATA_SELECTOR: Hex = '0xe0e0e0e0'

/**
 * Common ERC20 function selectors
 */
export const ERC20_SELECTORS = {
    /** transfer(address,uint256) */
    TRANSFER: '0xa9059cbb' as Hex,
    /** approve(address,uint256) */
    APPROVE: '0x095ea7b3' as Hex,
    /** transferFrom(address,address,uint256) */
    TRANSFER_FROM: '0x23b872dd' as Hex,
} as const
