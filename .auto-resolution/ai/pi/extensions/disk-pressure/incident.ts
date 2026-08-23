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
}> {}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined

const incidentCreatedAt = (path: string): number | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      typeof parsed.createdAt === "number" &&
      Number.isSafeInteger(parsed.createdAt)
      ? parsed.createdAt
      : undefined
  } catch {
    return undefined
  }
}

const createIncident = (
  path: string,
  sessionId: string,
  now: number,
): boolean => {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, "wx", 0o600)
    writeFileSync(
      descriptor,
      JSON.stringify({ sessionId, createdAt: now }),
      "utf8",
    )
    return true
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export const claimResourceIncident = (
  path: string,
  sessionId: string,
  now: number,
  ttlMs: number,
): Effect.Effect<boolean, ResourceIncidentError> =>
  Effect.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (createIncident(path, sessionId, now)) return true
        const createdAt = incidentCreatedAt(path)
        if (createdAt !== undefined && now - createdAt <= ttlMs) return false
        try {
          unlinkSync(path)
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error
        }
      }
      return false
    },
    catch: () =>
      new ResourceIncidentError({
        message: "Could not claim the resource-pressure incident",
      }),
  })

export const clearResourceIncident = (
  path: string,
): Effect.Effect<void, ResourceIncidentError> =>
  Effect.try({
    try: () => {
      try {
        unlinkSync(path)
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
      }
    },
    catch: () =>
      new ResourceIncidentError({
        message: "Could not clear the resource-pressure incident",
      }),
  })
