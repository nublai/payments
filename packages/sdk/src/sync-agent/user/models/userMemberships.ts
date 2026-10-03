import { MembershipOp, UserPayload_UserMembership } from '@towns-labs/proto'
import { dlogger } from '@towns-labs/utils'
import { RiverConnection } from '../../river-connection/riverConnection'
import { Client } from '../../../client'
import { EMPTY_USER_STEAM_MODEL, UserStreamModel } from '../../../views/streams/userStreamsView'
import { Observable } from '../../../observable/observable'
import { makeUserStreamId } from '../../../id'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const logger = dlogger('csb:userMemberships')

export class UserMemberships extends Observable<UserStreamModel> {
    private riverConnection: RiverConnection

    constructor(id: string, riverConnection: RiverConnection) {
        const streamId = makeUserStreamId(id)
        super(EMPTY_USER_STEAM_MODEL(streamId))

        this.riverConnection = riverConnection
        this.riverConnection.registerView((client: Client) => {
            const unsubFn = client.streamsView.userStreams.subscribe((x) =>
                this.setValue(x[streamId] ?? this.value),
            )
            return () => {
                unsubFn()
            }
        })
    }

    getMembership(streamId: string): UserPayload_UserMembership | undefined {
        return this.value.streamMemberships[streamId]
    }

    isMember(streamId: string, membership: MembershipOp): boolean {
        return this.getMembership(streamId)?.op === membership
    }

    isJoined(streamId: string): boolean {
        return this.isMember(streamId, MembershipOp.SO_JOIN)
    }
}
