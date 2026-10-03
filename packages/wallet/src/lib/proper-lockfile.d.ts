declare module 'proper-lockfile' {
    export type LockRelease = () => Promise<void>
    export type LockOptions = {
        lockfilePath?: string
        stale?: number
        retries?:
            | number
            | {
                  retries?: number
                  minTimeout?: number
              }
    }

    const properLockfile: {
        lock(path: string, options?: LockOptions): Promise<LockRelease>
    }

    export default properLockfile
}
