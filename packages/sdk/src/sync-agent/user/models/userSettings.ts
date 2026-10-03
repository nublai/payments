import { dlogger } from '@towns-labs/utils'
import { Identifiable } from '../../../store/store'
import { RiverConnection } from '../../river-connection/riverConnection'
import { makeUserSettingsStreamId } from '../../../id'
import {
    DEFAULT_USER_SETTINGS_STREAM_MODEL,
    UserSettingsStreamModel,
} from '../../../views/streams/userSettingsStreams'
import { Observable } from '../../../observable/observable'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const logger = dlogger('csb:userSettings')

export interface UserSettingsModel extends Identifiable {
    id: string
    streamId: string
    initialized: boolean
}

export class UserSettings extends Observable<UserSettingsStreamModel> {
    constructor(
        id: string,
        private riverConnection: RiverConnection,
    ) {
        const streamId = makeUserSettingsStreamId(id)
        super(DEFAULT_USER_SETTINGS_STREAM_MODEL(streamId))

        this.riverConnection.registerView((client) => {
            const unsub = client.streamsView.userSettingsStreams.subscribe((x) =>
                this.setValue(x[streamId] ?? this.value),
            )
            return () => {
                unsub()
            }
        })
    }
}
