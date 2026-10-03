import { runSessionDaemonEntry } from './lib/session-daemon'

const daemon = await runSessionDaemonEntry()
await daemon.untilStopped
