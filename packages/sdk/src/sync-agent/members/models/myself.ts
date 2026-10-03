import type { RiverConnection } from '../../river-connection/riverConnection'
import { Member } from './member'

export class Myself {
    constructor(
        public member: Member,
        protected streamId: string,
        protected riverConnection: RiverConnection,
    ) {}

    get userId() {
        return this.member.value.userId
    }
}
