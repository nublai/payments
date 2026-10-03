import { Membership } from '../models/timelineTypes'

export function spaceIdsTransform(
    _memberships: Record<string, Membership>,
    _prev: Record<string, Membership>,
    prevResult?: string[],
): string[] {
    if (prevResult && prevResult.length === 0) {
        return prevResult
    }
    return []
}
