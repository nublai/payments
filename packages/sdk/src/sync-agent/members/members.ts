import { check } from '@towns-labs/utils'
import type { RiverConnection } from '../river-connection/riverConnection'
import { Member } from './models/member'
import { isUserId } from '../../id'
import { Myself } from './models/myself'
import { Observable } from '../../observable/observable'

export type MembersModel = {
    /** The id of the stream. */
    streamId: string
    /** Whether the SyncAgent has loaded this data. */
    initialized: boolean
    /** The ids of the users in the stream. */
    userIds: string[]
}

export class Members extends Observable<MembersModel> {
    // putting these in a weak ref for now, so that they can be garbage collected when not needed
    // aellis, not sure how this is going to play out, will need to revisit if any dynamic data is added to the member on the node
    private members: Record<string, WeakRef<Member>> = {}
    constructor(
        streamId: string,
        private riverConnection: RiverConnection,
    ) {
        super({ streamId, initialized: false, userIds: [] })
        this.riverConnection.registerView((client) => {
            const unsub = client.streamsView.streamMemberIds.subscribe(
                (value) => {
                    this.setValue({
                        streamId,
                        initialized: value[streamId] !== undefined,
                        userIds: value[streamId] ?? [],
                    })
                },
                { fireImediately: true },
            )
            return () => {
                unsub()
            }
        })
    }

    get myself() {
        const member = this.get(this.riverConnection.userId)
        return new Myself(member, this.value.streamId, this.riverConnection)
    }

    get(userId: string): Member {
        check(isUserId(userId), 'invalid user id')
        if (this.members[userId]) {
            const member = this.members[userId].deref()
            if (member) {
                return member
            }
        }
        const member = new Member(userId, this.value.streamId, this.riverConnection)
        this.members[userId] = new WeakRef(member)
        return member
    }
}
