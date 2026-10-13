type JsonValue =
    | string
    | number
    | boolean
    | bigint
    | null
    | undefined
    | JsonValue[]
    | { [key: string]: JsonValue }

export function isRecord(value: unknown): value is { [key: string]: JsonValue } {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
