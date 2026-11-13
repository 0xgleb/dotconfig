import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect } from "effect"
import type { NativeTaskHostOptions } from "./host.ts"
import { TaskHostError, TaskOutputError } from "./tool.ts"
import { TaskStoreError } from "./sqlite-store.ts"
import type { TaskHudError } from "./hud-controller.ts"

export type NativeTaskHostReport =
  | {
      readonly phase: "initialization" | "release"
      readonly code: Parameters<
        NativeTaskHostOptions["onOpenFailure"]
      >[0]["code"]
    }
  | { readonly phase: "hud"; readonly code: TaskHudError["code"] }

export const nativeTaskRuntimeOptions = (
  databasePath: string,
  report: (report: NativeTaskHostReport) => Effect.Effect<void>,
): NativeTaskHostOptions => ({
  databasePath,
  prepareDatabase: Effect.try({
    try: () =>
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 }),
    catch: () =>
      new TaskStoreError({
        code: "io",
        message: "Could not prepare task storage directory",
      }),
  }).pipe(Effect.asVoid),
  contextForCall: call =>
    Effect.suspend(() => {
      const now = Date.now()

      return Number.isSafeInteger(now) && now >= 0
        ? Effect.succeed({
            actorId: call.sessionId,
            requestId: call.toolCallId,
            now,
            cancellation: "forbidden" as const,
          })
        : Effect.fail(
            new TaskHostError({
              code: "host_unavailable",
              message: "Task host clock is not a non-negative safe integer",
            }),
          )
    }),
  renderOutput: outcome =>
    Effect.try({
      try: () => JSON.stringify(outcome),
      catch: () =>
        new TaskOutputError({ message: "Task output could not be encoded" }),
    }).pipe(
      Effect.flatMap(text =>
        typeof text === "string"
          ? Effect.succeed(text)
          : Effect.fail(
              new TaskOutputError({ message: "Task output is not text" }),
            ),
      ),
    ),
  onHudFailure: error =>
    Effect.suspend(() =>
      report(Object.freeze({ phase: "hud", code: error.code })),
    ),
  onOpenFailure: error =>
    Effect.suspend(() =>
      report(Object.freeze({ phase: "initialization", code: error.code })),
    ),
  onCloseFailure: error =>
    Effect.suspend(() =>
      report(Object.freeze({ phase: "release", code: error.code })),
    ),
})
