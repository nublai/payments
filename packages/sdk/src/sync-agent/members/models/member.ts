import { check } from '@towns-labs/utils'
import { isDefined } from '../../../check'
import type { RiverConnection } from '../../river-connection/riverConnection'
import { MembershipOp } from '@towns-labs/proto'
import { Observable } from '../../../observable/observable'

export type MemberModel = {
    /** The id of the user. */
    userId: string
    /** The id of the stream where the data belongs to. */
    streamId: string
    /** Whether the SyncAgent has loaded this data. */
    initialized: boolean
    /**
     * {@link NftModel} of the member.
     * Should not be trusted, as it can be spoofed.
     * You should be validating it.
     */
    /** {@link MembershipOp} of the member. */
    membership?: MembershipOp
    /** The app address of the member. */
    appAddress?: string
}

/// note this is an observable for future compatibility, but is not wired up to updates
export class Member extends Observable<MemberModel> {
    constructor(
        private userId: string,
        streamId: string,
        protected riverConnection: RiverConnection,
    ) {
        super({
            userId,
            streamId,
            initialized: false,
            membership: undefined,
            appAddress: undefined,
        })
        this.riverConnection.registerViewOnce((client) => {
            const streamView = client.stream(streamId)?.view
            // the expectation is that in order to get the member, you needed the member list from the members view.
            // if this is not the case, fine to revisit
            check(isDefined(streamView), 'streamView is not defined')
            const membership = streamView.getMembers().info(this.userId)
            const appAddress = streamView.getMembers().joined.get(this.userId)?.appAddress
            this.setValue({
                userId,
                streamId,
                initialized: true,
                membership,
                appAddress,
            })
        })
    }
}
