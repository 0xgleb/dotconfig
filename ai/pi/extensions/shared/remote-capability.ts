export const REMOTE_CAPABILITY_HANDSHAKE_EVENT =
  "pi:remote-capability-handshake"
export const REMOTE_CAPABILITY_MESSAGE = "remote-control.capability-handshake"
export const REMOTE_TASK_CONTINUATION_MESSAGE =
  "remote-control.task-continuation"

export interface RemoteCapabilityHandshake {
  readonly status: "restored" | "recovered" | "failed"
  readonly recoveryAttempts: 0 | 1
  readonly expectedTools: readonly string[]
  readonly activeTools: readonly string[]
}

export const remoteCapabilityMessage = (
  handshake: RemoteCapabilityHandshake,
): string =>
  handshake.status === "failed"
    ? `Source-fixed remote capability handshake: the communication-only turn ended, but local tools were not restored after one managed recovery attempt. Suppress automatic task continuations until a normal local capability set is observed.`
    : `Source-fixed remote capability handshake: the communication-only turn ended and ${handshake.activeTools.length} local tools were ${handshake.status === "recovered" ? "restored after one managed recovery attempt" : "restored"}. Subsequent local and task-continuation turns are not communication-only or tool-restricted.`
