export type Json =
    | null
    | boolean
    | number
    | string
    | Json[]
    | { [key: string]: Json }

export function isRecord(value: unknown): value is { [key: string]: Json } {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
