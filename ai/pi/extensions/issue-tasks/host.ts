import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Cause, Effect, Either, Exit, Option, Scope } from "effect"
import { acquireNativeTaskTool, type NativeTaskToolOptions } from "./native.ts"
import type { TaskStoreError } from "./sqlite-store.ts"
import { TaskHostError } from "./tool.ts"

export interface NativeTaskHostOptions extends Omit<
  NativeTaskToolOptions,
  "cwd"
> {
  readonly prepareDatabase?: Effect.Effect<void, TaskStoreError>
  readonly onOpenFailure: (
    error: TaskStoreError | TaskHostError,
  ) => Effect.Effect<void>
}

type NativeTaskLifetime = {
  readonly scope: Scope.CloseableScope
  readonly acquisition: AbortController
}

const release = (lifetime: NativeTaskLifetime): Promise<void> => {
  lifetime.acquisition.abort()
  return Effect.runPromise(Scope.close(lifetime.scope, Exit.void))
}

export const registerNativeTaskHost = (
  pi: Pick<ExtensionAPI, "on" | "registerTool">,
  options: NativeTaskHostOptions,
): void => {
  const { onOpenFailure, prepareDatabase, ...nativeOptions } = options
  let current: NativeTaskLifetime | undefined

  pi.on("session_start", async (_event, ctx) => {
    const lifetime: NativeTaskLifetime = {
      scope: Effect.runSync(Scope.make()),
      acquisition: new AbortController(),
    }
    const previous = current
    current = lifetime

    if (previous !== undefined) await release(previous)

    const opened = await Effect.runPromiseExit(
      Scope.extend(
        Effect.gen(function* () {
          if (prepareDatabase !== undefined) yield* prepareDatabase
          return yield* acquireNativeTaskTool({
            ...nativeOptions,
            cwd: ctx.cwd,
          })
        }),
        lifetime.scope,
      ),
      { signal: lifetime.acquisition.signal },
    )

    if (current !== lifetime) {
      await release(lifetime)
      return
    }
    if (Exit.isFailure(opened)) {
      current = undefined
      await release(lifetime)
      if (Cause.isInterruptedOnly(opened.cause)) return

      const failure = Option.match(Cause.failureOption(opened.cause), {
        onSome: error => error,
        onNone: () =>
          new TaskHostError({
            code: "host_unavailable",
            message: "Task host initialization did not complete",
          }),
      })
      await Effect.runPromise(onOpenFailure(failure))
      return
    }

    const registered = Either.try({
      try: () => pi.registerTool(opened.value),
      catch: () =>
        new TaskHostError({
          code: "host_unavailable",
          message: "Task tool registration did not complete",
        }),
    })

    if (Either.isLeft(registered)) {
      current = undefined
      await release(lifetime)
      await Effect.runPromise(onOpenFailure(registered.left))
    }
  })

  pi.on("session_shutdown", async () => {
    const lifetime = current
    current = undefined

    if (lifetime !== undefined) await release(lifetime)
  })
}
