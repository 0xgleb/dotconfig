import { Data, Either } from "effect"

export const OWNER_ALLOWANCE_MS = 30 * 60 * 1_000
export const OWNER_ALLOWANCE_ENTRY = "pi.owner-work-allowance.v1"
// Non-secret absolute deadline inherited by managed Pi child processes.
export const OWNER_PARENT_DEADLINE_ENV = "PI_OWNER_WORK_DEADLINE_MS"

export interface OwnerWindow {
  readonly version: 1
  readonly lastOwnerAt: number
  readonly deadlineAt: number
  readonly status: "active" | "expired"
}

export class OwnerAllowanceError extends Data.TaggedError(
  "OwnerAllowanceError",
)<{
  readonly code:
    | "missing"
    | "malformed"
    | "invalid-clock"
    | "expired"
    | "closed"
    | "runtime-failure"
  readonly message: string
}> {}

export interface OwnerAllowanceRuntime<T> {
  readonly inheritedDeadline?: unknown
  readonly now: () => number
  readonly schedule: (callback: () => void, delay: number) => T
  readonly clear: (handle: T) => void
  readonly persist: (window: OwnerWindow) => void
  readonly cancel: (error: OwnerAllowanceError) => void
  readonly onExpired?: (window: OwnerWindow) => void
}

export interface OwnerAllowance {
  readonly restore: (snapshot: unknown) => void
  readonly ownerInput: (
    receivedAt: unknown,
  ) => Either.Either<OwnerWindow, OwnerAllowanceError>
  readonly admit: () => Either.Either<OwnerWindow, OwnerAllowanceError>
  readonly dispose: () => void
  readonly track: (cancel: () => void) => () => void
}

const time = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const error = (code: OwnerAllowanceError["code"]) =>
  new OwnerAllowanceError({
    code,
    message:
      code === "expired"
        ? "The 30-minute owner allowance expired. Work is stopped until a new authenticated owner message."
        : `Owner allowance is ${code}; no execution is admitted without valid owner deadline evidence.`,
  })

export const createOwnerAllowance = <T>(
  runtime: OwnerAllowanceRuntime<T>,
): OwnerAllowance => {
  const inherited = runtime.inheritedDeadline
  const ceiling =
    typeof inherited === "string" &&
    /^[0-9]+$/.test(inherited) &&
    time(Number(inherited)) &&
    Number(inherited) >= OWNER_ALLOWANCE_MS
      ? Number(inherited)
      : undefined
  const invalidInheritance = inherited !== undefined && ceiling === undefined
  const constrain = (candidate: OwnerWindow): OwnerWindow =>
    ceiling !== undefined && candidate.deadlineAt > ceiling
      ? {
          ...candidate,
          deadlineAt: ceiling,
          lastOwnerAt: ceiling - OWNER_ALLOWANCE_MS,
        }
      : candidate
  const processes = new Set<() => void>()
  let window: OwnerWindow | undefined
  let stopped: OwnerAllowanceError | undefined
  let notified = false
  let timer: { readonly handle: T; readonly token: object } | undefined
  const invoke = (action: () => unknown) => {
    const result = Either.try({
      try: action,
      catch: () => error("runtime-failure"),
    })
    if (Either.isLeft(result)) stopped = result.left
    else if (result.right instanceof OwnerAllowanceError) stopped = result.right
    return result
  }
  const clear = () => {
    const previous = timer
    timer = undefined
    if (previous) invoke(() => runtime.clear(previous.handle))
  }
  const stop = (reason: OwnerAllowanceError) => {
    stopped = reason
    clear()
    const persistExpiry =
      window && reason.code === "expired" && window.status !== "expired"
    if (persistExpiry && window) window = { ...window, status: "expired" }
    if (!notified) {
      notified = true
      const pending = [...processes]
      processes.clear()
      for (const cancel of pending) invoke(cancel)
      invoke(() => runtime.cancel(reason))
    }
    if (persistExpiry && window) {
      const expiredWindow = window
      invoke(() => runtime.persist(expiredWindow))
      invoke(() => runtime.onExpired?.(expiredWindow))
    }
    return Either.left(reason)
  }
  const admit: OwnerAllowance["admit"] = () => {
    if (stopped) return stop(stopped)
    if (invalidInheritance) return stop(error("malformed"))
    if (!window) return stop(error("missing"))
    const now = runtime.now()
    if (!time(now) || now < window.lastOwnerAt)
      return stop(error("invalid-clock"))
    if (window.status === "expired" || now >= window.deadlineAt)
      return stop(error("expired"))
    return Either.right(window)
  }
  const arm = () => {
    clear()
    const admitted = admit()
    if (Either.isLeft(admitted)) return
    const token = {}
    const handle = runtime.schedule(() => {
      if (timer?.token !== token) return
      stop(error("expired"))
    }, admitted.right.deadlineAt - runtime.now())
    timer = { handle, token }
  }
  return {
    admit,
    dispose: () => {
      stop(error("closed"))
    },
    track: cancel => {
      if (Either.isLeft(admit())) {
        invoke(cancel)
        return () => {}
      }
      processes.add(cancel)
      return () => {
        processes.delete(cancel)
      }
    },
    restore: snapshot => {
      clear()
      window = undefined
      stopped = undefined
      notified = false
      if (snapshot === undefined) {
        stop(error("missing"))
        return
      }
      if (
        !record(snapshot) ||
        snapshot.version !== 1 ||
        !time(snapshot.lastOwnerAt) ||
        !time(snapshot.deadlineAt) ||
        !time(snapshot.lastOwnerAt + OWNER_ALLOWANCE_MS) ||
        snapshot.deadlineAt !== snapshot.lastOwnerAt + OWNER_ALLOWANCE_MS ||
        (snapshot.status !== "active" && snapshot.status !== "expired")
      ) {
        stop(error("malformed"))
        return
      }
      window = constrain({
        version: 1,
        lastOwnerAt: snapshot.lastOwnerAt,
        deadlineAt: snapshot.deadlineAt,
        status: snapshot.status,
      })
      arm()
    },
    ownerInput: receivedAt => {
      if (invalidInheritance) return stop(error("malformed"))
      const now = runtime.now()
      if (
        !time(now) ||
        !time(receivedAt) ||
        receivedAt > now ||
        !time(receivedAt + OWNER_ALLOWANCE_MS)
      )
        return Either.left(error("invalid-clock"))
      if (window && receivedAt <= window.lastOwnerAt) return admit()
      window = constrain({
        version: 1,
        lastOwnerAt: receivedAt,
        deadlineAt: receivedAt + OWNER_ALLOWANCE_MS,
        status: "active",
      })
      stopped = undefined
      notified = false
      const granted = window
      const persisted = invoke(() => runtime.persist(granted))
      if (Either.isLeft(persisted)) return stop(persisted.left)
      arm()
      return admit()
    },
  }
}
