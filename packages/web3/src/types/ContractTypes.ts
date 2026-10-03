export const Permission = {
    /** No permission required. */
    Undefined: 'Undefined',
    /** Read event permission. */
    Read: 'Read',
    /** Write event permission. */
    Write: 'Write',
    /** Invite user permission. */
    Invite: 'Invite',
    /** Join space permission. */
    JoinSpace: 'JoinSpace',
    /** Redact events permission. */
    Redact: 'Redact',
    /** Modify or ban user permission. */
    ModifyBanning: 'ModifyBanning',
    /** Pin/unpin events permission. */
    PinMessage: 'PinMessage',
    /** Add or remove channels permission. */
    AddRemoveChannels: 'AddRemoveChannels',
    /** Modify space settings permission. */
    ModifySpaceSettings: 'ModifySpaceSettings',
    /** React to a message permission. */
    React: 'React',
} as const

export type Permission = (typeof Permission)[keyof typeof Permission]

export interface BasicRoleInfo {
    roleId: number
    name: string
}

export function isPermission(permission: string): permission is Permission {
    return Object.values(Permission).includes(permission as Permission)
}

export function isStringArray(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any,
): args is string[] {
    return Array.isArray(args) && args.length > 0 && args.every((arg) => typeof arg === 'string')
}

export type Address = `0x${string}`

export interface TransactionOpts {
    retryCount?: number
}

export type SendTipMemberParams = {
    tokenId: string
    spaceId: string
    receiver: Address
    currency: Address
    amount: bigint
    // Used for nodes to validate tip event
    messageId: string
    channelId: string
}

export type SendTipBotParams = {
    appId: string
    spaceId?: string
    receiver: Address
    currency: Address
    amount: bigint
    // Used for nodes to validate tip event
    messageId: string
    channelId: string
}

export type SendTipAnyParams = {
    receiver: Address
    currency: Address
    amount: bigint
    /** Sender address override (for smart account userops where msg.sender differs from signer) */
    sender?: Address
    // Used for nodes to validate tip event
    messageId: string
    channelId: string
}

export type SendTipParams =
    | ({ type: 'member' } & SendTipMemberParams)
    | ({ type: 'bot' } & SendTipBotParams)
    | ({ type: 'any' } & SendTipAnyParams)
