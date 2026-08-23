import { channel } from "node:diagnostics_channel"
import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"

export const RequestLifecyclePhase = Object.freeze({
  RequestStarted: "request.started",
  AuthStarted: "auth.started",
  CredentialReadStarted: "auth.credential_read.started",
  CredentialReadCompleted: "auth.credential_read.completed",
  AuthLockWait: "auth.lock.wait",
  AuthLockAcquired: "auth.lock.acquired",
  AuthLockReleased: "auth.lock.released",
  OAuthRefreshStarted: "auth.oauth_refresh.started",
  OAuthRefreshCompleted: "auth.oauth_refresh.completed",
  OAuthRefreshFailed: "auth.oauth_refresh.failed",
  AuthCompleted: "auth.completed",
  AuthFailed: "auth.failed",
  PayloadStarted: "provider.payload.started",
  AdmissionStarted: "provider.admission.started",
  AdmissionCompleted: "provider.admission.completed",
  TransportStarted: "provider.transport.started",
  ResponseStarted: "provider.response.started",
  RequestCompleted: "request.completed",
  RequestFailed: "request.failed",
  RequestAborted: "request.aborted",
})

const lifecycleChannel = channel("pi.request.lifecycle")
const lifecycleStorage = new AsyncLocalStorage()

const signalForPhase = phase => {
  if (phase.startsWith("auth.")) return "pi.auth.phase"
  if (phase.startsWith("provider.")) return "pi.provider.phase"
  if (
    phase === RequestLifecyclePhase.RequestCompleted ||
    phase === RequestLifecyclePhase.RequestFailed ||
    phase === RequestLifecyclePhase.RequestAborted
  )
    return "pi.request.outcome"
  return "pi.request.phase"
}

export const createRequestLifecycle = model => ({
  requestId: randomUUID(),
  startedAt: Date.now(),
  provider: model.provider,
  model: model.id,
})

export const currentRequestLifecycle = () => lifecycleStorage.getStore()

export const withRequestLifecycle = (model, operation) => {
  const lifecycle = createRequestLifecycle(model)
  return lifecycleStorage.run(lifecycle, () => operation(lifecycle))
}

export const classifyRequestFailure = (error, signal) => {
  if (signal?.aborted) return "abort"
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "timeout"
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined
  if (code === "ELOCKED") return "lock"
  if (code === "auth" || code === "oauth") return "auth"
  if (code === "provider" || code === "stream") return "provider"
  return "unknown"
}

export const publishRequestLifecycle = (
  lifecycle,
  phase,
  { outcome, failureClass } = {},
) => {
  if (!lifecycle || !Object.values(RequestLifecyclePhase).includes(phase)) return
  const timestamp = Date.now()
  lifecycleChannel.publish({
    schemaVersion: 1,
    signal: signalForPhase(phase),
    phase,
    requestId: lifecycle.requestId,
    timestamp,
    elapsedMs: Math.max(0, timestamp - lifecycle.startedAt),
    pid: process.pid,
    project: basename(process.cwd()),
    provider: lifecycle.provider,
    model: lifecycle.model,
    ...(outcome === undefined ? {} : { outcome }),
    ...(failureClass === undefined ? {} : { failureClass }),
  })
}
