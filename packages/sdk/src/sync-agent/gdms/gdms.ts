import { Identifiable } from '../../store/store'
import { UserMemberships } from '../user/models/userMemberships'
import { MembershipOp } from '@towns-labs/proto'
import { isGDMChannelStreamId } from '../../id'
import { RiverConnection } from '../river-connection/riverConnection'
import { check } from '@towns-labs/utils'
import type { Client } from '../../client'
import { Gdm } from './models/gdm'
import { isDefined } from '../../check'
import { Observable } from '../../observable/observable'
import { UserStreamModel } from '../../views/streams/userStreamsView'

export interface GdmsModel extends Identifiable {
    streamIds: string[] // joined gdms
    initialized: boolean
}

export class Gdms extends Observable<GdmsModel> {
    private gdms: Record<string, Gdm> = {}

    constructor(
        private riverConnection: RiverConnection,
        private userMemberships: UserMemberships,
    ) {
        super({ id: '0', streamIds: [], initialized: false })

        this.userMemberships.subscribe(
            (value) => {
                this.onUserMembershipsChanged(value)
            },
            { fireImediately: true },
        )
    }

    getGdm(streamId: string): Gdm {
        check(isGDMChannelStreamId(streamId), 'Invalid streamId: ' + streamId)
        if (!this.gdms[streamId]) {
            this.gdms[streamId] = new Gdm(streamId, this.riverConnection)
        }
        return this.gdms[streamId]
    }

    private onUserMembershipsChanged(value: UserStreamModel) {
        const streamIds = Object.entries(value.streamMemberships)
            .filter(
                ([key, m]) =>
                    isDefined(m) && isGDMChannelStreamId(key) && m.op === MembershipOp.SO_JOIN,
            )
            .map(([key]) => key)

        this.setValue({ ...this.value, streamIds, initialized: value.initialized })

        for (const streamId of streamIds) {
            if (!this.gdms[streamId]) {
                this.gdms[streamId] = new Gdm(streamId, this.riverConnection)
            }
        }
    }

    async createGDM(...args: Parameters<Client['createGDMChannel']>) {
        return this.riverConnection.call((client) => client.createGDMChannel(...args))
    }
}
