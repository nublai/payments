/** JSON the test just built or the handler under test just returned. */
export function parseJson<T>(text: string): T {
    // SAFETY: callers only parse JSON they constructed or the handler under test just returned.
    return JSON.parse(text) as T
}
