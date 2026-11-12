import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Cause, Effect, Either, Exit, Option, Scope } from "effect"
import { acquireNativeTaskTool, type NativeTaskToolOptions } from "./native.ts"
import type { TaskStoreError } from "./sqlite-store.ts"
import { acquireTaskHud, TaskHudError } from "./hud-controller.ts"
import { TaskHostError } from "./tool.ts"

export interface NativeTaskHostOptions extends Omit<
  NativeTaskToolOptions,
  "cwd"
> {
  readonly prepareDatabase?: Effect.Effect<void, TaskStoreError>
  readonly onHudFailure?: (error: TaskHudError) => Effect.Effect<void>
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
  const { onHudFailure, onOpenFailure, prepareDatabase, ...nativeOptions } =
    options
  const reportHudFailure = (error: TaskHudError): Effect.Effect<void> =>
    onHudFailure === undefined
      ? onOpenFailure(
          new TaskHostError({
            code: "host_unavailable",
            message: `${error.message}; task operations remain available`,
          }),
        )
      : onHudFailure(error)
  let current: NativeTaskLifetime | undefined
  let presentationOwner: NativeTaskLifetime | undefined

  pi.on("session_start", async (_event, ctx) => {
    const lifetime: NativeTaskLifetime = {
      scope: Effect.runSync(Scope.make()),
      acquisition: new AbortController(),
    }
    const previous = current
    current = lifetime

    if (previous !== undefined) await release(previous)

    let hudFailure: TaskHudError | undefined
    const opened = await Effect.runPromiseExit(
      Scope.extend(
        Effect.gen(function* () {
          if (prepareDatabase !== undefined) yield* prepareDatabase
          const tool = yield* acquireNativeTaskTool({
            ...nativeOptions,
            cwd: ctx.cwd,
          })
          const hudScope = yield* Scope.make()
          yield* Scope.addFinalizer(
            lifetime.scope,
            Scope.close(hudScope, Exit.void),
          )
          const hud = yield* Effect.exit(
            Scope.extend(
              acquireTaskHud({
                pi,
                ctx,
                readProgress: tool.readProgress,
                isCurrent: () => current === lifetime,
                claimPresentation: () => {
                  presentationOwner = lifetime
                },
                ownsPresentation: () => presentationOwner === lifetime,
                onFailure: reportHudFailure,
              }),
              hudScope,
            ),
          )
          if (Exit.isFailure(hud)) {
            const cleanup = yield* Effect.exit(Scope.close(hudScope, hud))
            if (!Cause.isInterruptedOnly(hud.cause)) {
              hudFailure = Exit.isFailure(cleanup)
                ? new TaskHudError({
                    code: "ui_unavailable",
                    message: "Task HUD cleanup did not complete",
                  })
                : Option.match(Cause.failureOption(hud.cause), {
                    onSome: failure => failure,
                    onNone: () =>
                      new TaskHudError({
                        code: "ui_unavailable",
                        message: "Task HUD initialization did not complete",
                      }),
                  })
            }
          }
          return tool
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
      return
    }

    const warning = hudFailure
    if (warning !== undefined)
      await Effect.runPromise(Effect.suspend(() => reportHudFailure(warning)))
  })

  pi.on("session_shutdown", async () => {
    const lifetime = current
    current = undefined

    if (lifetime !== undefined) await release(lifetime)
  })
}
