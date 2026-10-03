import { ObservableRecord } from '../../observable/observableRecord'

export interface UserInboxStreamModel {
    streamId: string
    initialized: boolean
    appAddress?: string
}

export const DEFAULT_USER_INBOX_STREAM_MODEL = (
    userInboxStreamId: string,
): UserInboxStreamModel => ({
    streamId: userInboxStreamId,
    appAddress: undefined,
    initialized: false,
})

export class UserInboxStreamsView extends ObservableRecord<string, UserInboxStreamModel> {
    constructor() {
        super({
            makeDefault: DEFAULT_USER_INBOX_STREAM_MODEL,
        })
    }

    setAppAddress(userInboxStreamId: string, appAddress: string | undefined) {
        this.set((prev) => {
            const prevStream = prev[userInboxStreamId] ?? this.makeDefault(userInboxStreamId)
            return {
                ...prev,
                [userInboxStreamId]: {
                    ...prevStream,
                    appAddress,
                },
            }
        })
    }
    setIsInitialized(userInboxStreamId: string, initialized: boolean) {
        this.set((prev) => {
            const prevStream = prev[userInboxStreamId] ?? this.makeDefault(userInboxStreamId)
            return {
                ...prev,
                [userInboxStreamId]: { ...prevStream, initialized },
            }
        })
    }
}
