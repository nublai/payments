import TypedEmitter from 'typed-emitter'
import { ConfirmedTimelineEvent, RemoteTimelineEvent } from './types'
import { StreamEncryptionEvents, StreamStateEvents } from './streamEvents'

export interface Nft {
    chainId: number
    tokenId: string
    contractAddress: string
}

export type UserInfo = {
    appAddress?: string
}

export class StreamStateView_MemberMetadata {
    readonly appAddresses = new Map<string, string>()
    readonly currentUserId: string
    constructor(streamId: string, currentUserId: string) {
        this.currentUserId = currentUserId
    }

    applySnapshot(appAddresses: { userId: string; appAddress: string }[]) {
        for (const item of appAddresses) {
            if (item.appAddress) {
                this.appAddresses.set(item.userId, item.appAddress)
            }
        }
    }

    onConfirmedEvent(
        _confirmedEvent: ConfirmedTimelineEvent,
        _stateEmitter: TypedEmitter<StreamStateEvents> | undefined,
    ): void {
        // pass
    }

    prependEvent(
        _event: RemoteTimelineEvent,
        _cleartext: Uint8Array | string | undefined,
        _encryptionEmitter: TypedEmitter<StreamEncryptionEvents> | undefined,
        _stateEmitter: TypedEmitter<StreamStateEvents> | undefined,
    ): void {
        // usernames were conveyed in the snapshot
    }

    userInfo(userId: string): UserInfo {
        const appAddress = this.appAddresses.get(userId)
        return {
            appAddress,
        }
    }

    setAppAddress(userId: string, appAddress: string): void {
        this.appAddresses.set(userId, appAddress)
    }

    removeAppAddress(userId: string): void {
        this.appAddresses.delete(userId)
    }
}
