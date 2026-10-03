import { dlogger } from '@towns-labs/utils'
import { makeUserInboxStreamId } from '../../../id'
import { RiverConnection } from '../../river-connection/riverConnection'
import {
    DEFAULT_USER_INBOX_STREAM_MODEL,
    UserInboxStreamModel,
} from '../../../views/streams/userInboxStreams'
import { Observable } from '../../../observable/observable'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const logger = dlogger('csb:userInbox')

export class UserInbox extends Observable<UserInboxStreamModel> {
    constructor(
        id: string,
        private riverConnection: RiverConnection,
    ) {
        const streamId = makeUserInboxStreamId(id)
        super(DEFAULT_USER_INBOX_STREAM_MODEL(streamId))

        this.riverConnection.registerView((client) => {
            const unsub = client.streamsView.userInboxStreams.subscribe(
                (value) => {
                    this.setValue(value[streamId] ?? this.value)
                },
                { fireImediately: true },
            )
            return unsub
        })
    }
}
