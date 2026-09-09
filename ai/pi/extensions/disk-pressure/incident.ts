import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { Data, Effect } from "effect"

export class ResourceIncidentError extends Data.TaggedError(
  "ResourceIncidentError",
)<{
  readonly message: string
  readonly code?: string
  readonly cause?: unknown
}> {}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined

const incidentFailure = (
  message: string,
  cause: unknown,
): ResourceIncidentError =>
  new ResourceIncidentError({
    message,
    ...(errorCode(cause) ? { code: errorCode(cause) } : {}),
    cause,
  })

const incidentCreatedAt = (
  path: string,
): Effect.Effect<number | undefined, never> =>
  Effect.try({
    try: (): unknown => JSON.parse(readFileSync(path, "utf8")),
    catch: cause => incidentFailure("Could not read resource incident", cause),
  }).pipe(
    Effect.map(parsed =>
      typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      typeof parsed.createdAt === "number" &&
      Number.isSafeInteger(parsed.createdAt)
        ? parsed.createdAt
        : undefined,
    ),
    Effect.catchAll(() => Effect.succeed(undefined)),
  )

const createIncident = (
  path: string,
  sessionId: string,
  now: number,
): Effect.Effect<boolean, ResourceIncidentError> => {
  let descriptor: number | undefined
  return Effect.try({
    try: () => {
      descriptor = openSync(path, "wx", 0o600)
      writeFileSync(
        descriptor,
        JSON.stringify({ sessionId, createdAt: now }),
        "utf8",
      )
      return true
    },
    catch: cause =>
      incidentFailure("Could not create resource incident", cause),
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        descriptor === undefined
          ? Effect.void
          : Effect.try({
              try: () => closeSync(descriptor),
              catch: cause =>
                incidentFailure("Could not close resource incident", cause),
            }).pipe(Effect.ignore),
      ),
    ),
    Effect.catchIf(
      error => error.code === "EEXIST",
      () => Effect.succeed(false),
    ),
  )
}

const removeIncident = (
  path: string,
): Effect.Effect<void, ResourceIncidentError> =>
  Effect.try({
    try: () => unlinkSync(path),
    catch: cause =>
      incidentFailure("Could not remove resource incident", cause),
  }).pipe(
    Effect.catchIf(
      error => error.code === "ENOENT",
      () => Effect.void,
    ),
  )

export const claimResourceIncident = (
  path: string,
  sessionId: string,
  now: number,
  ttlMs: number,
): Effect.Effect<boolean, ResourceIncidentError> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => mkdirSync(dirname(path), { recursive: true, mode: 0o700 }),
      catch: cause =>
        incidentFailure("Could not prepare resource incident directory", cause),
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (yield* createIncident(path, sessionId, now)) return true
      const createdAt = yield* incidentCreatedAt(path)
      if (createdAt !== undefined && now - createdAt <= ttlMs) return false
      yield* removeIncident(path)
    }
    return false
  }).pipe(
    Effect.mapError(
      error =>
        new ResourceIncidentError({
          message: "Could not claim the resource-pressure incident",
          cause: error,
        }),
    ),
  )

export const clearResourceIncident = (
  path: string,
): Effect.Effect<void, ResourceIncidentError> =>
  removeIncident(path).pipe(
    Effect.mapError(
      error =>
        new ResourceIncidentError({
          message: "Could not clear the resource-pressure incident",
          cause: error,
        }),
    ),
  )
