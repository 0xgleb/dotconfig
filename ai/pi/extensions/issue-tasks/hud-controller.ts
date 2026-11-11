import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Cause, Data, Effect, Either, Exit, Option, Scope } from "effect"
import { currentIssueFromEntries } from "./hud-focus.ts"
import {
  createTaskHudComponent,
  taskHudStatus,
  type ConfirmedTaskHudFocus,
  type TaskHudView,
} from "./hud.ts"
import type { SqliteTaskStore } from "./sqlite-store.ts"

export class TaskHudError extends Data.TaggedError("TaskHudError")<{
  readonly code:
    | "ui_unavailable"
    | "branch_unavailable"
    | "invalid_progress"
    | "subscription_unavailable"
    | "read_unavailable"
  readonly message: string
}> {}

export interface TaskHudOptions {
  readonly pi: Pick<ExtensionAPI, "on">
  readonly ctx: ExtensionContext
  readonly readProgress: SqliteTaskStore["readProgress"] | undefined
  readonly isCurrent: () => boolean
  readonly claimPresentation: () => void
  readonly ownsPresentation: () => boolean
  readonly onFailure: (error: TaskHudError) => Effect.Effect<void>
}

const key = "issue-tasks"
const none: TaskHudView = Object.freeze({ kind: "none" })

const makeController = (options: TaskHudOptions) => {
  const {
    ctx,
    readProgress,
    isCurrent,
    claimPresentation,
    ownsPresentation,
    onFailure,
  } = options
  let phase: "open" | "failed" | "closed" = "open"
  let snapshot: TaskHudView = none
  let active: AbortController | undefined
  let mount: { requestRender?: () => void } | undefined
  const reads = new Set<AbortController>()
  const pending = new Set<Promise<unknown>>()
  const reported = new Set<TaskHudError["code"]>()
  const notifications = new AbortController()

  const track = (promise: Promise<unknown>): void => {
    pending.add(promise)
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    )
  }
  const report = (error: TaskHudError): void => {
    if (phase === "closed" || !isCurrent() || reported.has(error.code)) return
    reported.add(error.code)
    track(
      Effect.runPromiseExit(
        Effect.suspend(() => onFailure(error)),
        { signal: notifications.signal },
      ),
    )
  }
  const clear = (): void => {
    if (!ownsPresentation()) return
    for (const operation of [
      () => ctx.ui.setWidget(key, undefined),
      () => ctx.ui.setStatus(key, undefined),
    ]) {
      const result = Either.try({
        try: operation,
        catch: () =>
          new TaskHudError({
            code: "ui_unavailable",
            message: "Task HUD cleanup did not complete",
          }),
      })
      if (Either.isLeft(result)) report(result.left)
    }
    mount = undefined
  }
  const present = (view: TaskHudView): void => {
    if (phase !== "open" || !isCurrent()) return
    snapshot = view
    const shown = Either.try({
      try: () => {
        claimPresentation()
        ctx.ui.setStatus(key, taskHudStatus(view))
        if (view.kind === "none") {
          clear()
          return
        }
        if (mount !== undefined) {
          mount.requestRender?.()
          return
        }
        const current: { requestRender?: () => void } = {}
        mount = current
        ctx.ui.setWidget(
          key,
          (tui, theme) => {
            current.requestRender = () => tui.requestRender()
            return createTaskHudComponent(
              () =>
                phase === "open" && isCurrent() && mount === current
                  ? snapshot
                  : none,
              theme,
            )
          },
          { placement: "aboveEditor" },
        )
      },
      catch: () =>
        new TaskHudError({
          code: "ui_unavailable",
          message: "Task HUD presentation did not complete",
        }),
    })
    if (Either.isLeft(shown)) {
      phase = "failed"
      active?.abort()
      snapshot = none
      clear()
      report(shown.left)
    }
  }
  const refresh = (entries: readonly unknown[]): void => {
    if (phase !== "open" || !isCurrent()) return
    active?.abort()
    active = undefined
    const focus = currentIssueFromEntries(entries)
    if (Either.isLeft(focus)) {
      present({ kind: "selection_unavailable", code: focus.left.code })
      return
    }
    if (focus.right.kind !== "issue") {
      present(focus.right)
      return
    }
    const selected: ConfirmedTaskHudFocus = focus.right
    if (readProgress === undefined) {
      present({
        kind: "progress_unavailable",
        focus: selected,
        code: "unavailable",
      })
      return
    }
    present({ kind: "loading", focus: selected })
    if (phase !== "open" || !isCurrent()) return
    const controller = new AbortController()
    active = controller
    reads.add(controller)
    const current = (): boolean =>
      phase === "open" &&
      isCurrent() &&
      active === controller &&
      !controller.signal.aborted
    const effect = Effect.gen(function* () {
      const progress = yield* Effect.suspend(() => readProgress(selected.issue))
      if (!current()) return
      if (Option.isNone(progress)) {
        present({ kind: "missing", focus: selected })
        return
      }
      const observed = progress.value
      if (
        observed.issue.repository !== selected.issue.repository ||
        observed.issue.number !== selected.issue.number
      ) {
        present({
          kind: "progress_unavailable",
          focus: selected,
          code: "unavailable",
        })
        report(
          new TaskHudError({
            code: "invalid_progress",
            message: "Task HUD progress did not match the selected issue",
          }),
        )
        return
      }
      present({ kind: "ready", mode: selected.mode, progress: observed })
    }).pipe(
      Effect.catchAllCause(cause =>
        Effect.sync(() => {
          if (!current()) return
          const error = Cause.failureOption(cause)
          present({
            kind: "progress_unavailable",
            focus: selected,
            code: Option.isSome(error) ? error.value.code : "unavailable",
          })
          if (Option.isNone(error))
            report(
              new TaskHudError({
                code: "read_unavailable",
                message: "Task HUD progress read did not complete",
              }),
            )
        }),
      ),
    )
    const done = Effect.runPromiseExit(effect, { signal: controller.signal })
    track(done)
    void done.then(() => reads.delete(controller))
  }
  const restore = (message?: unknown): void => {
    if (phase !== "open" || !isCurrent()) return
    const branch = Either.try({
      try: () => ctx.sessionManager.getBranch(),
      catch: () =>
        new TaskHudError({
          code: "branch_unavailable",
          message: "Task HUD session branch was unavailable",
        }),
    })
    if (Either.isLeft(branch)) {
      active?.abort()
      present({ kind: "selection_unavailable", code: "invalid_state" })
      report(branch.left)
      return
    }
    refresh(
      message === undefined
        ? branch.right
        : [...branch.right, { type: "message", message }],
    )
  }
  return {
    restore,
    close: async (): Promise<void> => {
      clear()
      phase = "closed"
      snapshot = none
      notifications.abort()
      for (const controller of reads) controller.abort()
      await Promise.allSettled([...pending])
    },
  }
}

export const acquireTaskHud = (
  options: TaskHudOptions,
): Effect.Effect<void, TaskHudError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!options.ctx.hasUI || options.ctx.mode !== "tui") return
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => makeController(options)),
      value => Effect.promise(() => value.close()),
    )
    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          options.pi.on("message_end", event => {
            const message = event.message
            if (
              (message.role === "toolResult" && message.toolName === "task") ||
              (message.role === "assistant" &&
                message.content.some(
                  part => part.type === "toolCall" && part.name === "task",
                ))
            )
              controller.restore(message)
          }),
        catch: () =>
          new TaskHudError({
            code: "subscription_unavailable",
            message: "Task HUD message observer was unavailable",
          }),
      }),
      unsubscribe => Effect.sync(() => unsubscribe()),
    )
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => options.pi.on("turn_end", () => controller.restore()),
        catch: () =>
          new TaskHudError({
            code: "subscription_unavailable",
            message: "Task HUD turn observer was unavailable",
          }),
      }),
      unsubscribe => Effect.sync(() => unsubscribe()),
    )
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => options.pi.on("session_tree", () => controller.restore()),
        catch: () =>
          new TaskHudError({
            code: "subscription_unavailable",
            message: "Task HUD branch observer was unavailable",
          }),
      }),
      unsubscribe => Effect.sync(() => unsubscribe()),
    )
    controller.restore()
  })
