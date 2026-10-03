import { dlogger } from '@towns-labs/utils'
import { makeUserMetadataStreamId } from '../../../id'
import { RiverConnection } from '../../river-connection/riverConnection'
import {
    DEFAULT_USER_METADATA_STREAM_MODEL,
    UserMetadataStreamModel,
} from '../../../views/streams/userMetadataStreams'
import { Observable } from '../../../observable/observable'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const logger = dlogger('csb:userMetadata')

export class UserMetadata extends Observable<UserMetadataStreamModel> {
    constructor(
        id: string,
        private riverConnection: RiverConnection,
    ) {
        const streamId = makeUserMetadataStreamId(id)
        super(DEFAULT_USER_METADATA_STREAM_MODEL(streamId))

        this.riverConnection.registerView((client) => {
            const unsub = client.streamsView.userMetadataStreams.subscribe((x) =>
                this.setValue(x[streamId] ?? this.value),
            )
            return () => {
                unsub()
            }
        })
    }
}
