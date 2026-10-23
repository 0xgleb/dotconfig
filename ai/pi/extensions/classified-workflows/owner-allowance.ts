import { Data, Either } from "effect"

export const OWNER_ALLOWANCE_MS = 60 * 60 * 1_000
export const SUPERVISED_OWNER_ALLOWANCE_MS = 4 * OWNER_ALLOWANCE_MS
export const OWNER_PROGRESS_CHECK_IN_MS = 30 * 60 * 1_000
const LEGACY_OWNER_ALLOWANCE_MS = 30 * 60 * 1_000
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

export interface OwnerProgressCheckIn {
  readonly window: OwnerWindow
  readonly sequence: number
  readonly scheduledAt: number
}

export interface OwnerAllowanceRuntime<T> {
  readonly inheritedDeadline?: unknown
  readonly now: () => number
  readonly schedule: (callback: () => void, delay: number) => T
  readonly clear: (handle: T) => void
  readonly persist: (window: OwnerWindow) => void
  readonly cancel: (error: OwnerAllowanceError) => void
  readonly onExpired?: (window: OwnerWindow) => void
  /** Requests supervision; acknowledgement is not proof of a completed review. */
  readonly onProgressCheckIn?: (
    request: OwnerProgressCheckIn,
  ) => Either.Either<void, OwnerAllowanceError>
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

export const createOwnerAllowance = <T>(
  runtime: OwnerAllowanceRuntime<T>,
): OwnerAllowance => {
  const checkIn = runtime.onProgressCheckIn
  const allowanceMs =
    checkIn === undefined ? OWNER_ALLOWANCE_MS : SUPERVISED_OWNER_ALLOWANCE_MS
  const error = (code: OwnerAllowanceError["code"]) =>
    Object.freeze(
      new OwnerAllowanceError({
        code,
        message:
          code === "expired"
            ? `The ${checkIn === undefined ? "one-hour" : "four-hour"} owner allowance expired. Work is stopped until a new authenticated owner message.`
            : `Owner allowance is ${code}; no execution is admitted without valid owner deadline evidence.`,
      }),
    )
  const snapshotWindow = (value: OwnerWindow): OwnerWindow =>
    Object.freeze({ ...value })
  const copyCallbackError = (
    cause: OwnerAllowanceError,
  ): OwnerAllowanceError => {
    const code = cause.code
    const message = cause.message
    if (
      ![
        "missing",
        "malformed",
        "invalid-clock",
        "expired",
        "closed",
        "runtime-failure",
      ].some(known => known === code) ||
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > 4096
    )
      return error("malformed")
    return Object.freeze(new OwnerAllowanceError({ code, message }))
  }
  const inherited = runtime.inheritedDeadline
  const ceiling =
    typeof inherited === "string" &&
    /^[0-9]+$/.test(inherited) &&
    time(Number(inherited))
      ? Number(inherited)
      : undefined
  const invalidInheritance = inherited !== undefined && ceiling === undefined
  const constrain = (candidate: OwnerWindow): OwnerWindow =>
    ceiling !== undefined && candidate.deadlineAt > ceiling
      ? {
          ...candidate,
          deadlineAt: ceiling,
        }
      : candidate
  const processes = new Set<() => void>()
  let window: OwnerWindow | undefined
  let stopped: OwnerAllowanceError | undefined
  let notified = false
  let generation = {}
  const readClock = () =>
    Either.flatMap(
      Either.try({
        try: () => runtime.now(),
        catch: () => error("runtime-failure"),
      }),
      value =>
        time(value) ? Either.right(value) : Either.left(error("invalid-clock")),
    )
  let timer: { readonly handle: T; readonly token: object } | undefined
  let checkInTimer: { readonly handle: T; readonly token: object } | undefined
  const invoke = (action: () => unknown, expectedGeneration = generation) => {
    const result = Either.try({
      try: () => {
        const value = action()
        return value instanceof OwnerAllowanceError
          ? copyCallbackError(value)
          : undefined
      },
      catch: () => error("runtime-failure"),
    })
    if (generation === expectedGeneration) {
      if (Either.isLeft(result)) stopped = result.left
      else if (result.right !== undefined) stopped = result.right
    }
    return result
  }
  const clearCheckIn = () => {
    const previous = checkInTimer
    checkInTimer = undefined
    if (previous) invoke(() => runtime.clear(previous.handle))
  }
  const clear = (expectedGeneration = generation) => {
    const previous = timer
    const previousCheckIn = checkInTimer
    timer = undefined
    checkInTimer = undefined
    if (previousCheckIn)
      invoke(() => runtime.clear(previousCheckIn.handle), expectedGeneration)
    if (previous)
      invoke(() => runtime.clear(previous.handle), expectedGeneration)
  }
  const stop = (reason: OwnerAllowanceError) => {
    const expectedGeneration = generation
    const shouldNotify = !notified
    const pending = shouldNotify ? [...processes] : []
    if (shouldNotify) {
      notified = true
      processes.clear()
    }
    const expiredWindow: OwnerWindow | undefined =
      window && reason.code === "expired" && window.status !== "expired"
        ? { ...window, status: "expired" }
        : undefined
    if (expiredWindow) window = expiredWindow
    stopped = reason
    clear(expectedGeneration)
    if (generation === expectedGeneration && expiredWindow)
      invoke(
        () => runtime.persist(snapshotWindow(expiredWindow)),
        expectedGeneration,
      )
    for (const cancel of pending) invoke(cancel, expectedGeneration)
    if (generation === expectedGeneration && shouldNotify)
      invoke(() => runtime.cancel(reason), expectedGeneration)
    if (generation === expectedGeneration && expiredWindow)
      invoke(
        () => runtime.onExpired?.(snapshotWindow(expiredWindow)),
        expectedGeneration,
      )
    return Either.left(reason)
  }
  const admit: OwnerAllowance["admit"] = () => {
    if (stopped) return stop(stopped)
    if (
      invalidInheritance ||
      (checkIn !== undefined && typeof checkIn !== "function")
    )
      return stop(error("malformed"))
    if (!window) return stop(error("missing"))
    const current = window
    const expectedGeneration = generation
    const clock = readClock()
    if (generation !== expectedGeneration || window !== current || stopped)
      return Either.left(stopped ?? error("closed"))
    if (Either.isLeft(clock)) return stop(clock.left)
    const now = clock.right
    if (now < current.lastOwnerAt) return stop(error("invalid-clock"))
    if (current.status === "expired" || now >= current.deadlineAt)
      return stop(error("expired"))
    return Either.right(current)
  }
  const admitSnapshot = () => Either.map(admit(), snapshotWindow)
  const scheduleCheckIn = (minimumSequence: number) => {
    if (checkIn === undefined) return
    const admitted = admit()
    if (Either.isLeft(admitted)) return
    const current = admitted.right
    const expectedGeneration = generation
    const clock = readClock()
    if (generation !== expectedGeneration || window !== current || stopped)
      return
    if (Either.isLeft(clock)) {
      stop(clock.left)
      return
    }
    const now = clock.right
    if (now < current.lastOwnerAt) {
      stop(error("invalid-clock"))
      return
    }
    if (now >= current.deadlineAt) {
      stop(error("expired"))
      return
    }
    const sequence = Math.max(
      minimumSequence,
      Math.floor((now - current.lastOwnerAt) / OWNER_PROGRESS_CHECK_IN_MS),
    )
    const scheduledAt =
      current.lastOwnerAt + sequence * OWNER_PROGRESS_CHECK_IN_MS
    if (scheduledAt >= current.deadlineAt) return
    const token = {}
    const scheduled = Either.try({
      try: () =>
        runtime.schedule(
          () => {
            if (checkInTimer?.token !== token) return
            clearCheckIn()
            const allowed = admit()
            if (Either.isLeft(allowed) || allowed.right !== current) return
            const firedClock = readClock()
            if (
              generation !== expectedGeneration ||
              window !== current ||
              stopped
            )
              return
            if (Either.isLeft(firedClock)) {
              stop(firedClock.left)
              return
            }
            const firedAt = firedClock.right
            if (firedAt < current.lastOwnerAt) {
              stop(error("invalid-clock"))
              return
            }
            if (firedAt >= current.deadlineAt) {
              stop(error("expired"))
              return
            }
            if (firedAt < scheduledAt) {
              scheduleCheckIn(sequence)
              return
            }
            const dueSequence = Math.max(
              sequence,
              Math.floor(
                (firedAt - current.lastOwnerAt) / OWNER_PROGRESS_CHECK_IN_MS,
              ),
            )
            const requested = Either.try({
              try: () => {
                const acknowledgement = checkIn({
                  window: { ...current },
                  sequence: dueSequence,
                  scheduledAt:
                    current.lastOwnerAt +
                    dueSequence * OWNER_PROGRESS_CHECK_IN_MS,
                })
                if (!Either.isEither(acknowledgement))
                  return Either.left(error("malformed"))
                if (Either.isLeft(acknowledgement)) {
                  const cause = acknowledgement.left
                  if (!(cause instanceof OwnerAllowanceError))
                    return Either.left(error("malformed"))
                  return Either.left(copyCallbackError(cause))
                }
                return acknowledgement.right === undefined
                  ? Either.right(undefined)
                  : Either.left(error("malformed"))
              },
              catch: () => error("runtime-failure"),
            })
            if (stopped || window !== current) return
            if (Either.isLeft(requested)) {
              stop(requested.left)
              return
            }
            if (Either.isLeft(requested.right)) {
              stop(requested.right.left)
              return
            }
            scheduleCheckIn(dueSequence + 1)
          },
          Math.max(0, scheduledAt - now),
        ),
      catch: () => error("runtime-failure"),
    })
    if (generation !== expectedGeneration) {
      if (Either.isRight(scheduled))
        invoke(() => runtime.clear(scheduled.right), expectedGeneration)
      return
    }
    if (Either.isLeft(scheduled)) stop(scheduled.left)
    else checkInTimer = { handle: scheduled.right, token }
  }
  const arm = (expectedGeneration = generation) => {
    clear(expectedGeneration)
    if (generation !== expectedGeneration) return
    const admitted = admit()
    if (Either.isLeft(admitted)) return
    const clock = readClock()
    if (
      generation !== expectedGeneration ||
      window !== admitted.right ||
      stopped
    )
      return
    if (Either.isLeft(clock)) {
      stop(clock.left)
      return
    }
    if (clock.right >= admitted.right.deadlineAt) {
      stop(error("expired"))
      return
    }
    const token = {}
    const scheduled = Either.try({
      try: () =>
        runtime.schedule(() => {
          if (timer?.token !== token || generation !== expectedGeneration)
            return
          stop(error("expired"))
        }, admitted.right.deadlineAt - clock.right),
      catch: () => error("runtime-failure"),
    })
    if (generation !== expectedGeneration) {
      if (Either.isRight(scheduled))
        invoke(() => runtime.clear(scheduled.right), expectedGeneration)
      return
    }
    if (Either.isLeft(scheduled)) {
      stop(scheduled.left)
      return
    }
    timer = { handle: scheduled.right, token }
    scheduleCheckIn(1)
  }
  return {
    admit: admitSnapshot,
    dispose: () => {
      generation = {}
      stop(error("closed"))
    },
    track: cancel => {
      const expectedGeneration = generation
      if (Either.isLeft(admit())) {
        invoke(cancel, expectedGeneration)
        return () => {}
      }
      processes.add(cancel)
      return () => {
        processes.delete(cancel)
      }
    },
    restore: snapshot => {
      const previousGeneration = generation
      const decoded = Either.try({
        try: () => {
          if (snapshot === undefined) return Either.left(error("missing"))
          if (!record(snapshot)) return Either.left(error("malformed"))
          const { version, lastOwnerAt, deadlineAt, status } = snapshot
          if (
            version !== 1 ||
            !time(lastOwnerAt) ||
            !time(deadlineAt) ||
            !time(lastOwnerAt + allowanceMs) ||
            deadlineAt <= lastOwnerAt ||
            deadlineAt > lastOwnerAt + allowanceMs ||
            (status !== "active" && status !== "expired")
          )
            return Either.left(error("malformed"))
          return Either.right<OwnerWindow>({
            version: 1,
            lastOwnerAt,
            deadlineAt,
            status,
          })
        },
        catch: () => error("malformed"),
      })
      if (generation !== previousGeneration) return
      if (Either.isLeft(decoded)) {
        stop(decoded.left)
        return
      }
      if (Either.isLeft(decoded.right)) {
        stop(decoded.right.left)
        return
      }
      const value = decoded.right.right
      const clock = readClock()
      if (generation !== previousGeneration) return
      if (Either.isLeft(clock)) {
        stop(clock.left)
        return
      }
      if (ceiling !== undefined && ceiling <= value.lastOwnerAt) {
        stop(error("expired"))
        return
      }
      const previousStop = stopped
      clear(previousGeneration)
      if (generation !== previousGeneration) return
      if (stopped !== previousStop && stopped) {
        stop(stopped)
        return
      }
      const expectedGeneration = {}
      generation = expectedGeneration
      stopped = undefined
      notified = false
      const upgradedDeadline = value.lastOwnerAt + allowanceMs
      const legacyDuration = value.deadlineAt - value.lastOwnerAt
      const upgrade =
        (legacyDuration === LEGACY_OWNER_ALLOWANCE_MS ||
          (checkIn !== undefined && legacyDuration === OWNER_ALLOWANCE_MS)) &&
        value.status === "active" &&
        clock.right < value.deadlineAt &&
        (ceiling === undefined || upgradedDeadline <= ceiling)
      window = constrain({
        ...value,
        deadlineAt: upgrade ? upgradedDeadline : value.deadlineAt,
      })
      if (upgrade) {
        const upgraded = window
        const persisted = invoke(
          () => runtime.persist(snapshotWindow(upgraded)),
          expectedGeneration,
        )
        if (generation !== expectedGeneration) return
        if (Either.isLeft(persisted)) {
          stop(persisted.left)
          return
        }
      }
      arm(expectedGeneration)
    },
    ownerInput: receivedAt => {
      if (
        invalidInheritance ||
        (checkIn !== undefined && typeof checkIn !== "function")
      )
        return stop(error("malformed"))
      const previousGeneration = generation
      const clock = readClock()
      if (generation !== previousGeneration)
        return Either.left(stopped ?? error("closed"))
      if (Either.isLeft(clock)) return stop(clock.left)
      const now = clock.right
      if (
        !time(receivedAt) ||
        receivedAt > now ||
        !time(receivedAt + allowanceMs)
      )
        return Either.left(error("invalid-clock"))
      if (window && receivedAt <= window.lastOwnerAt) return admitSnapshot()
      if (ceiling !== undefined && now >= ceiling) return stop(error("expired"))
      const expectedGeneration = {}
      generation = expectedGeneration
      window = constrain({
        version: 1,
        lastOwnerAt: receivedAt,
        deadlineAt: receivedAt + allowanceMs,
        status: "active",
      })
      stopped = undefined
      notified = false
      const granted = window
      const persisted = invoke(
        () => runtime.persist(snapshotWindow(granted)),
        expectedGeneration,
      )
      if (generation !== expectedGeneration) return admitSnapshot()
      if (Either.isLeft(persisted)) return stop(persisted.left)
      arm(expectedGeneration)
      return admitSnapshot()
    },
  }
}
