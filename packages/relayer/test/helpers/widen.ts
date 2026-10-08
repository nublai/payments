/** Keep a union so a later `as T` overlaps without an `as unknown as` chain. */
export function widen<T, S>(value: S): T | S {
    return value
}
