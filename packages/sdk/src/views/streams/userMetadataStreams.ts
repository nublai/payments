import { ObservableRecord } from '../../observable/observableRecord'

export interface UserMetadataStreamModel {
    streamId: string
    initialized: boolean
    appAddress?: string
}

export const DEFAULT_USER_METADATA_STREAM_MODEL = (
    userMetadataStreamId: string,
): UserMetadataStreamModel => ({
    streamId: userMetadataStreamId,
    initialized: false,
    appAddress: undefined,
})

/// stream metadata gets requested from the river.delivery server - at time of writing this is only for completeness
export class UserMetadataStreamsView extends ObservableRecord<string, UserMetadataStreamModel> {
    constructor() {
        super({
            makeDefault: DEFAULT_USER_METADATA_STREAM_MODEL,
        })
    }

    setAppAddress(userMetadataStreamId: string, appAddress: string | undefined) {
        this.set((prev) => {
            const prevStream = prev[userMetadataStreamId] ?? this.makeDefault(userMetadataStreamId)
            return {
                ...prev,
                [userMetadataStreamId]: {
                    ...prevStream,
                    appAddress,
                },
            }
        })
    }
    setIsInitialized(userMetadataStreamId: string, initialized: boolean) {
        this.set((prev) => {
            const prevStream = prev[userMetadataStreamId] ?? this.makeDefault(userMetadataStreamId)
            return {
                ...prev,
                [userMetadataStreamId]: { ...prevStream, initialized },
            }
        })
    }
}
