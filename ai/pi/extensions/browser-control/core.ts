import { Data, Effect, Either, Option } from "effect"

export const BROWSER_ACTIONS = ["status", "open", "text", "fetch"] as const
export const BROWSER_TARGET_ENTRY = "browser-control.active-target"

export class BrowserControlError extends Data.TaggedError(
  "BrowserControlError",
)<{
  readonly code:
    | "cancelled"
    | "invalid_input"
    | "protocol"
    | "response_limit"
    | "timeout"
    | "unavailable"
  readonly message: string
}> {}

const failure = (
  code: BrowserControlError["code"],
  message: string,
): Effect.Effect<never, BrowserControlError> =>
  Effect.fail(new BrowserControlError({ code, message }))

export interface BrowserTargetMarker {
  readonly targetId: string
}

export const parseBrowserTargetMarker = (
  value: unknown,
): BrowserTargetMarker | undefined => {
  if (
    !isRecord(value) ||
    typeof value.targetId !== "string" ||
    value.targetId.length < 1 ||
    value.targetId.length > 512
  )
    return undefined
  return { targetId: value.targetId }
}

export const latestBrowserTargetId = (
  entries: readonly unknown[],
): string | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== BROWSER_TARGET_ENTRY
    )
      continue
    return parseBrowserTargetMarker(entry.data)?.targetId
  }
  return undefined
}

export type BrowserAction = (typeof BROWSER_ACTIONS)[number]
export type BrowserActivity = "active" | "idle"

export const browserActivityLabel: (
  activity: BrowserActivity,
  action?: BrowserAction,
) => string = (activity, action) =>
  activity === "active" && action
    ? `browser:active:${action} · isolated`
    : `browser:${activity} · isolated`

export const createSerialActivityUpdater = (
  update: (active: boolean) => Promise<void>,
): ((active: boolean) => Promise<void>) => {
  let pending = Promise.resolve()
  return active => {
    const next = pending.then(() => update(active))
    pending = next.catch(() => undefined)
    return next
  }
}

export const createSerialExecutor = <
  Arguments extends readonly unknown[],
  Result,
>(
  execute: (...args: Arguments) => Promise<Result>,
): ((...args: Arguments) => Promise<Result>) => {
  let pending = Promise.resolve()
  return (...args) => {
    const next = pending.then(() => execute(...args))
    pending = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

declare const localPageUrlBrand: unique symbol
export type LocalPageUrl = string & { readonly [localPageUrlBrand]: true }

export interface DebugTarget {
  readonly id: string
  readonly title: string
  readonly url: LocalPageUrl
  readonly type: "page"
  readonly webSocketDebuggerUrl: string
}

export interface TargetDiscoveryDependencies {
  readonly listTargets: (
    remainingMs: number,
  ) => Effect.Effect<readonly DebugTarget[], BrowserControlError>
  readonly now: () => number
  readonly sleep: (milliseconds: number) => Effect.Effect<void>
}

export const debugEndpointReadiness = (
  request: Effect.Effect<unknown, BrowserControlError>,
): Effect.Effect<boolean, BrowserControlError> =>
  Effect.matchEffect(request, {
    onFailure: error =>
      error.code === "timeout" || error.code === "unavailable"
        ? Effect.succeed(false)
        : Effect.fail(error),
    onSuccess: () => Effect.succeed(true),
  })

export const discoverOpenedTarget = (
  url: LocalPageUrl,
  previousTargetIds: ReadonlySet<string>,
  timeoutMs: number,
  retryIntervalMs: number,
  dependencies: TargetDiscoveryDependencies,
): Effect.Effect<DebugTarget | undefined, BrowserControlError> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      return yield* failure(
        "invalid_input",
        "Target discovery timeout must be positive.",
      )
    if (!Number.isSafeInteger(retryIntervalMs) || retryIntervalMs < 1)
      return yield* failure(
        "invalid_input",
        "Target discovery retry interval must be positive.",
      )

    const deadline = dependencies.now() + timeoutMs
    while (dependencies.now() < deadline) {
      const remainingBeforeRequestMs = deadline - dependencies.now()
      const targetsResult = yield* Effect.either(
        dependencies.listTargets(remainingBeforeRequestMs),
      )
      if (Either.isLeft(targetsResult)) {
        const error = targetsResult.left
        if (error.code !== "timeout" && error.code !== "unavailable")
          return yield* Effect.fail(error)
      } else if (dependencies.now() < deadline) {
        const freshTarget = targetsResult.right.find(
          target => target.url === url && !previousTargetIds.has(target.id),
        )
        if (freshTarget && dependencies.now() < deadline) return freshTarget
      }

      const remainingMs = deadline - dependencies.now()
      if (remainingMs > 0)
        yield* dependencies.sleep(Math.min(retryIntervalMs, remainingMs))
    }
    return undefined
  })

export interface LaunchServicesRequest {
  readonly command: "/usr/bin/open"
  readonly args: readonly [
    "-n",
    "-a",
    "Brave Browser",
    "--args",
    `--user-data-dir=${string}`,
    `--remote-debugging-port=${number}`,
    "--no-first-run",
    "--no-default-browser-check",
    LocalPageUrl,
  ]
}

export type PublicDebugTarget = Omit<DebugTarget, "webSocketDebuggerUrl">

export type CdpResponse =
  | { readonly kind: "result"; readonly id: number; readonly result: unknown }
  | { readonly kind: "error"; readonly id: number; readonly message: string }

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"])

export const launchServicesRequest = (
  url: LocalPageUrl,
  operatorProfilePath: string,
  debugPort: number,
): Effect.Effect<LaunchServicesRequest, BrowserControlError> =>
  Effect.gen(function* () {
    if (!operatorProfilePath.startsWith("/"))
      return yield* failure(
        "invalid_input",
        "Operator profile path must be absolute.",
      )
    if (
      !Number.isSafeInteger(debugPort) ||
      debugPort < 1_024 ||
      debugPort > 65_535
    )
      return yield* failure(
        "invalid_input",
        "Operator debugging port is invalid.",
      )
    return {
      command: "/usr/bin/open",
      args: [
        "-n",
        "-a",
        "Brave Browser",
        "--args",
        `--user-data-dir=${operatorProfilePath}`,
        `--remote-debugging-port=${debugPort}`,
        "--no-first-run",
        "--no-default-browser-check",
        url,
      ],
    }
  })

export const collectBoundedResponseBytes = (
  chunks: readonly Uint8Array[],
  maxBytes: number,
): Effect.Effect<Uint8Array, BrowserControlError> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      return yield* failure(
        "invalid_input",
        "Response byte limit must be positive.",
      )
    const totalBytes = chunks.reduce(
      (total, chunk) => total + chunk.byteLength,
      0,
    )
    if (totalBytes > maxBytes)
      return yield* failure(
        "response_limit",
        `Loopback response exceeded the ${maxBytes}-byte limit.`,
      )
    const result = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  })

export const parseLocalPageUrl = (
  input: string,
): Effect.Effect<LocalPageUrl, BrowserControlError> =>
  Effect.try({
    try: () => new URL(input),
    catch: () =>
      new BrowserControlError({
        code: "invalid_input",
        message: "Browser URLs must be absolute loopback HTTP URLs.",
      }),
  }).pipe(
    Effect.flatMap(url => {
      if (url.protocol !== "http:" && url.protocol !== "https:")
        return failure("invalid_input", "Browser URLs must use HTTP or HTTPS.")
      if (!LOOPBACK_HOSTS.has(url.hostname))
        return failure(
          "invalid_input",
          "Browser URLs must use an exact loopback host.",
        )
      if (url.username || url.password)
        return failure(
          "invalid_input",
          "Browser URLs must not contain credentials.",
        )
      return Effect.succeed(url.href as LocalPageUrl)
    }),
  )

const validateDebuggerUrl = (
  input: string,
  targetId: string,
  debugPort: number,
): Effect.Effect<void, BrowserControlError> =>
  Effect.try({
    try: () => new URL(input),
    catch: () =>
      new BrowserControlError({
        code: "protocol",
        message: "Brave returned an invalid debugging endpoint.",
      }),
  }).pipe(
    Effect.flatMap(url => {
      if (url.username || url.password)
        return failure(
          "protocol",
          "Brave returned a debugging endpoint containing credentials.",
        )
      return url.protocol === "ws:" &&
        LOOPBACK_HOSTS.has(url.hostname) &&
        url.port === String(debugPort) &&
        url.pathname === `/devtools/page/${targetId}`
        ? Effect.void
        : failure(
            "protocol",
            "Brave returned an unexpected debugging endpoint.",
          )
    }),
  )

const parseDebugTarget = (
  value: unknown,
  debugPort: number,
): Effect.Effect<Option.Option<DebugTarget>, BrowserControlError> =>
  Effect.gen(function* () {
    if (!isRecord(value))
      return yield* failure(
        "protocol",
        "Brave returned a malformed debug target.",
      )
    if (value.type !== "page") return Option.none()
    if (
      typeof value.id !== "string" ||
      typeof value.title !== "string" ||
      typeof value.url !== "string" ||
      typeof value.webSocketDebuggerUrl !== "string"
    )
      return yield* failure(
        "protocol",
        "Brave returned a malformed page target.",
      )
    const candidateUrl = yield* Effect.try({
      try: () => new URL(value.url),
      catch: () =>
        new BrowserControlError({
          code: "protocol",
          message: "Brave returned an invalid page target URL.",
        }),
    })
    if (candidateUrl.username || candidateUrl.password)
      return yield* failure(
        "protocol",
        "Brave returned a page target URL containing credentials.",
      )
    const parsedUrl = yield* Effect.either(parseLocalPageUrl(value.url))
    if (Either.isLeft(parsedUrl)) return Option.none()
    yield* validateDebuggerUrl(value.webSocketDebuggerUrl, value.id, debugPort)
    return Option.some({
      id: value.id,
      title: value.title,
      type: value.type,
      url: parsedUrl.right,
      webSocketDebuggerUrl: value.webSocketDebuggerUrl,
    })
  })

export const parseDebugTargets = (
  value: unknown,
  debugPort: number,
): Effect.Effect<readonly DebugTarget[], BrowserControlError> =>
  Effect.gen(function* () {
    if (!Array.isArray(value))
      return yield* failure(
        "protocol",
        "Brave debug target response must be an array.",
      )
    const parsed = yield* Effect.forEach(value, candidate =>
      parseDebugTarget(candidate, debugPort),
    )
    return parsed.flatMap(Option.toArray)
  })

export const selectReusableTarget: (
  targets: readonly DebugTarget[],
  url: LocalPageUrl,
  preferredTargetId: string | undefined,
) => DebugTarget | undefined = (targets, url, preferredTargetId) =>
  targets.find(
    target => target.id === preferredTargetId && target.url === url,
  ) ?? targets.find(target => target.url === url)

export const selectActiveTarget = (
  targets: readonly DebugTarget[],
  activeTargetId: string | undefined,
): Effect.Effect<DebugTarget, BrowserControlError> => {
  if (!activeTargetId)
    return failure(
      "unavailable",
      "No explicitly opened local page is available.",
    )
  const target = targets.find(candidate => candidate.id === activeTargetId)
  return target
    ? Effect.succeed(target)
    : failure(
        "unavailable",
        "The explicitly opened local page is no longer available.",
      )
}

export const publicTarget: (
  target: DebugTarget,
) => PublicDebugTarget = target => ({
  id: target.id,
  title: target.title,
  type: target.type,
  url: target.url,
})

export const parseCdpResponse = (
  data: string,
): Effect.Effect<Option.Option<CdpResponse>, BrowserControlError> =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      try: (): unknown => JSON.parse(data),
      catch: () =>
        new BrowserControlError({
          code: "protocol",
          message: "Brave returned malformed CDP JSON.",
        }),
    })
    if (!isRecord(value))
      return yield* failure(
        "protocol",
        "Brave returned a malformed CDP response.",
      )
    if (!("id" in value)) return Option.none()
    if (!Number.isSafeInteger(value.id) || Number(value.id) < 1)
      return yield* failure(
        "protocol",
        "Brave returned a CDP response with an invalid id.",
      )
    const id = Number(value.id)
    if ("error" in value) {
      if ("result" in value || !isRecord(value.error))
        return yield* failure(
          "protocol",
          "Brave returned a malformed CDP error.",
        )
      const dataMessage =
        typeof value.error.data === "string" ? value.error.data : undefined
      const message =
        typeof value.error.message === "string"
          ? value.error.message
          : undefined
      return Option.some({
        kind: "error",
        id,
        message: dataMessage ?? message ?? "CDP command failed",
      })
    }
    if (!("result" in value))
      return yield* failure(
        "protocol",
        "Brave returned a malformed CDP response.",
      )
    return Option.some({ kind: "result", id, result: value.result })
  })

export const parseEvaluationResult = (
  value: unknown,
): Effect.Effect<unknown, BrowserControlError> =>
  Effect.gen(function* () {
    if (!isRecord(value))
      return yield* failure(
        "protocol",
        "Brave returned a malformed Runtime.evaluate result.",
      )
    if ("exceptionDetails" in value) {
      if (!isRecord(value.exceptionDetails))
        return yield* failure(
          "protocol",
          "Brave returned malformed Runtime.evaluate exception details.",
        )
      const exception = isRecord(value.exceptionDetails.exception)
        ? value.exceptionDetails.exception
        : undefined
      const description =
        exception && typeof exception.description === "string"
          ? exception.description
          : undefined
      const text =
        typeof value.exceptionDetails.text === "string"
          ? value.exceptionDetails.text
          : undefined
      return yield* failure(
        "protocol",
        description ?? text ?? "Runtime.evaluate failed.",
      )
    }
    if (!isRecord(value.result) || typeof value.result.type !== "string")
      return yield* failure(
        "protocol",
        "Brave returned a malformed Runtime.evaluate result.",
      )
    if ("value" in value.result) return value.result.value
    return typeof value.result.description === "string"
      ? value.result.description
      : undefined
  })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
