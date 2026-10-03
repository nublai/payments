import { RiverConnection } from '../river-connection/riverConnection'
import { UserMetadata } from './models/userMetadata'
import { UserInbox } from './models/userInbox'
import { UserMemberships } from './models/userMemberships'
import { UserSettings } from './models/userSettings'

export class User {
    id: string
    memberships: UserMemberships
    inbox: UserInbox
    deviceKeys: UserMetadata
    settings: UserSettings

    constructor(id: string, riverConnection: RiverConnection) {
        this.id = id
        this.memberships = new UserMemberships(id, riverConnection)
        this.inbox = new UserInbox(id, riverConnection)
        this.deviceKeys = new UserMetadata(id, riverConnection)
        this.settings = new UserSettings(id, riverConnection)
    }
}
