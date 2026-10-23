import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Data, Effect, Either } from "effect"

export type AutomaticCompressionOwner =
  | { readonly owner: "native" }
  | {
      readonly owner: "billion-context"
      readonly sessionId: string
    }

export class CompressionOwnershipError extends Data.TaggedError(
  "CompressionOwnershipError",
)<{
  readonly code:
    "malformed" | "conflicting" | "unavailable" | "stale-session" | "cancelled"
  readonly message: string
}> {}

export type AutomaticCompressionResolver = (
  context: ExtensionContext,
  signal: AbortSignal,
) => Promise<AutomaticCompressionOwner>

export const getAutomaticCompressionOwner = (
  pi: Pick<ExtensionAPI, "events">,
  context: ExtensionContext,
  signal: AbortSignal,
): Effect.Effect<AutomaticCompressionOwner, CompressionOwnershipError> =>
  Effect.gen(function* () {
    if (signal.aborted) return yield* Effect.fail(cancelled())
    const sessionId = yield* currentSessionId(context)
    const offers: unknown[] = []
    let accepting = true
    yield* Effect.try({
      try: () =>
        pi.events.emit(OWNERSHIP_EVENT, {
          version: 1,
          sessionId,
          accept: (resolver: unknown) => {
            if (accepting && offers.length < 2) offers.push(resolver)
          },
        } satisfies OwnershipQuery),
      catch: () =>
        new CompressionOwnershipError({
          code: "unavailable",
          message: "Automatic compression ownership could not be queried.",
        }),
    })
    accepting = false
    if (signal.aborted) return yield* Effect.fail(cancelled())
    if (offers.length > 1)
      return yield* Effect.fail(
        new CompressionOwnershipError({
          code: "conflicting",
          message: "Multiple automatic compression owners answered.",
        }),
      )
    if (offers.length === 0) {
      yield* unchangedSession(context, sessionId)
      return { owner: "native" }
    }
    const resolver = offers[0]
    if (typeof resolver !== "function") return yield* Effect.fail(malformed())
    const result = yield* Effect.tryPromise({
      try: runtimeSignal =>
        Promise.resolve<unknown>(
          Reflect.apply(resolver, undefined, [
            context,
            AbortSignal.any([signal, runtimeSignal]),
          ]),
        ),
      catch: () =>
        signal.aborted
          ? cancelled()
          : new CompressionOwnershipError({
              code: "unavailable",
              message:
                "Automatic compression owner could not resolve this session.",
            }),
    }).pipe(
      Effect.timeoutFail({
        duration: 1000,
        onTimeout: () =>
          signal.aborted
            ? cancelled()
            : new CompressionOwnershipError({
                code: "unavailable",
                message:
                  "Automatic compression owner did not respond within its deadline.",
              }),
      }),
      Effect.raceFirst(waitForCancellation(signal)),
    )
    if (signal.aborted) return yield* Effect.fail(cancelled())
    yield* unchangedSession(context, sessionId)
    const owner = yield* decodeOwner(result, sessionId)
    if (signal.aborted) return yield* Effect.fail(cancelled())
    yield* unchangedSession(context, sessionId)
    return owner
  })

export const registerAutomaticCompressionOwner = (
  pi: Pick<ExtensionAPI, "events">,
  resolve: AutomaticCompressionResolver,
): (() => void) =>
  pi.events.on(OWNERSHIP_EVENT, (value: unknown) => {
    offerController(value, resolve)
  })

const OWNERSHIP_EVENT = "pi:automatic-compression-ownership.v1"

interface OwnershipQuery {
  readonly version: 1
  readonly sessionId: string
  readonly accept: (resolver: unknown) => void
}

const ownDataValue = (
  descriptors: PropertyDescriptorMap,
  key: string,
): unknown =>
  Object.hasOwn(descriptors, key) ? descriptors[key]?.value : undefined

const offerController = (
  value: unknown,
  resolve: AutomaticCompressionResolver,
): Either.Either<void, CompressionOwnershipError> => {
  if (typeof value !== "object" || value === null)
    return Either.left(malformed())
  return Either.try({
    try: () => Object.getOwnPropertyDescriptors(value),
    catch: () => malformed(),
  }).pipe(
    Either.flatMap(descriptors => {
      const version = ownDataValue(descriptors, "version")
      const sessionId = ownDataValue(descriptors, "sessionId")
      const accept = ownDataValue(descriptors, "accept")
      if (
        version !== 1 ||
        typeof sessionId !== "string" ||
        sessionId.length === 0 ||
        typeof accept !== "function"
      )
        return Either.left(malformed())
      return Either.try({
        try: () => {
          Reflect.apply(accept, undefined, [resolve])
        },
        catch: () => malformed(),
      })
    }),
  )
}

const cancelled = (): CompressionOwnershipError =>
  new CompressionOwnershipError({
    code: "cancelled",
    message: "Automatic compression ownership request was cancelled.",
  })

const waitForCancellation = (
  signal: AbortSignal,
): Effect.Effect<never, CompressionOwnershipError> =>
  Effect.async(resume => {
    const onAbort = () => resume(Effect.fail(cancelled()))
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })

const malformed = (): CompressionOwnershipError =>
  new CompressionOwnershipError({
    code: "malformed",
    message: "Automatic compression ownership response is malformed.",
  })

const currentSessionId = (
  context: ExtensionContext,
): Effect.Effect<string, CompressionOwnershipError> =>
  Effect.try({
    try: () => context.sessionManager.getSessionId(),
    catch: () =>
      new CompressionOwnershipError({
        code: "stale-session",
        message: "Automatic compression session context is unavailable.",
      }),
  }).pipe(
    Effect.flatMap(sessionId =>
      typeof sessionId === "string" &&
      sessionId.length > 0 &&
      !/[\u0000-\u001f\u007f]/u.test(sessionId)
        ? Effect.succeed(sessionId)
        : Effect.fail(malformed()),
    ),
  )

const unchangedSession = (
  context: ExtensionContext,
  sessionId: string,
): Effect.Effect<void, CompressionOwnershipError> =>
  currentSessionId(context).pipe(
    Effect.flatMap(current =>
      current === sessionId
        ? Effect.void
        : Effect.fail(
            new CompressionOwnershipError({
              code: "stale-session",
              message:
                "Automatic compression session changed during ownership resolution.",
            }),
          ),
    ),
  )

const decodeOwner = (
  value: unknown,
  sessionId: string,
): Effect.Effect<AutomaticCompressionOwner, CompressionOwnershipError> =>
  Effect.gen(function* () {
    if (typeof value !== "object" || value === null)
      return yield* Effect.fail(malformed())
    const descriptors = yield* Effect.try({
      try: () => Object.getOwnPropertyDescriptors(value),
      catch: () => malformed(),
    })
    const keys = Reflect.ownKeys(descriptors)
    const owner: unknown = Object.hasOwn(descriptors, "owner")
      ? descriptors.owner?.value
      : undefined
    const resolvedSession: unknown = Object.hasOwn(descriptors, "sessionId")
      ? descriptors.sessionId?.value
      : undefined
    if (owner === "native" && keys.length === 1) return { owner: "native" }
    if (
      owner !== "billion-context" ||
      keys.length !== 2 ||
      typeof resolvedSession !== "string"
    )
      return yield* Effect.fail(malformed())
    if (resolvedSession !== sessionId)
      return yield* Effect.fail(
        new CompressionOwnershipError({
          code: "stale-session",
          message:
            "Automatic compression owner answered for a different session.",
        }),
      )
    return { owner: "billion-context", sessionId }
  })
