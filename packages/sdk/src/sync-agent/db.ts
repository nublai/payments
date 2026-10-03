import { Members } from './members/members'
import { RiverConnection } from './river-connection/riverConnection'
import { UserMetadata } from './user/models/userMetadata'
import { UserInbox } from './user/models/userInbox'
import { UserMemberships } from './user/models/userMemberships'
import { UserSettings } from './user/models/userSettings'
import { User } from './user/user'
import { Gdms } from './gdms/gdms'
import { Gdm } from './gdms/models/gdm'
import { Member } from './members/models/member'

export const DB_VERSION = 1
export const DB_MODELS = [
    RiverConnection,
    User,
    UserMetadata,
    UserInbox,
    UserMemberships,
    UserSettings,
    Members,
    Member,
    Gdms,
    Gdm,
]
