import { Cause, Effect, Either, Exit, Option, type Scope } from "effect"
import {
  createGitHubCliReader,
  createGitHubCliProjectReader,
  createGitHubCliPickupClient,
  createGitHubCliProjectPlacement,
} from "./github-cli.ts"
import { createIssueNextReader } from "./next.ts"
import {
  formatTaskContinuation,
  TaskContinuationError,
  type TaskContinuationReader,
} from "./continuation.ts"
import { createIssueNextPicker } from "./pickup.ts"
import { createIssueTaskReader } from "./issue-view.ts"
import {
  openSqliteTaskStore,
  type SqliteTaskStoreOptions,
  type TaskStoreError,
} from "./sqlite-store.ts"
import {
  createTaskTool,
  type IssueTaskTool,
  type TaskToolOptions,
  type TaskExecutionOutcome,
} from "./tool.ts"

export interface NativeTaskToolOptions
  extends
    Pick<SqliteTaskStoreOptions, "databasePath" | "busyTimeoutMs">,
    Pick<TaskToolOptions, "contextForCall" | "renderOutput"> {
  readonly cwd: string
  readonly onCloseFailure: (error: TaskStoreError) => Effect.Effect<void>
}

export type NativeIssueTaskTool = IssueTaskTool & {
  readonly continuation: TaskContinuationReader
}

export const acquireNativeTaskTool = (
  options: NativeTaskToolOptions,
): Effect.Effect<NativeIssueTaskTool, TaskStoreError, Scope.Scope> => {
  const {
    databasePath,
    busyTimeoutMs,
    cwd,
    contextForCall,
    renderOutput,
    onCloseFailure,
  } = options
  const storeOptions = Object.freeze({
    databasePath,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
  })

  return Effect.gen(function* () {
    yield* Effect.yieldNow()

    const store = yield* Effect.acquireRelease(
      openSqliteTaskStore(storeOptions),
      acquired => acquired.close().pipe(Effect.catchAll(onCloseFailure)),
    )

    const running = new Set<Promise<unknown>>()
    const lifetime = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      controller =>
        Effect.gen(function* () {
          controller.abort()
          yield* Effect.promise(() => Promise.allSettled([...running])).pipe(
            Effect.asVoid,
          )
        }),
    )
    const github = createGitHubCliReader({ cwd })
    const issueReader = createIssueTaskReader({ github, tasks: store })
    const nextReader = createIssueNextReader({
      projects: createGitHubCliProjectReader({ cwd }),
      github,
      tasks: store,
    })
    const nextPicker = createIssueNextPicker({
      reader: nextReader,
      pickup: createGitHubCliPickupClient({ cwd }),
    })
    const placement = createGitHubCliProjectPlacement({ cwd })
    const tool = createTaskTool({
      store,
      issueReader,
      nextPicker,
      placeAffected: placement.placeAffected,
      contextForCall,
      renderOutput,
    })
    const execute: IssueTaskTool["execute"] = async (
      id,
      parameters,
      signal,
      onUpdate,
      context,
    ) => {
      if (lifetime.signal.aborted) {
        const outcome: TaskExecutionOutcome = {
          kind: "failed",
          code: "closed",
          message: "Native task scope is closed",
        }
        return {
          content: [{ type: "text", text: "Native task scope is closed." }],
          details: { outcome, output: "complete" },
          isError: true,
        }
      }
      const activeSignal =
        signal === undefined
          ? lifetime.signal
          : AbortSignal.any([signal, lifetime.signal])
      const execution = tool.execute(
        id,
        parameters,
        activeSignal,
        onUpdate,
        context,
      )
      running.add(execution)
      try {
        return await execution
      } finally {
        running.delete(execution)
      }
    }
    const continuation: TaskContinuationReader = async (query, signal) => {
      if (lifetime.signal.aborted || signal.aborted)
        return Either.left(
          new TaskContinuationError({
            code: "interrupted",
            message: "Task continuation was interrupted.",
          }),
        )
      const execution = Effect.runPromiseExit(
        nextReader.read(query).pipe(
          Effect.flatMap(observed => {
            if (observed.selection.kind !== "selected")
              return Effect.succeed(undefined)
            const issue = observed.selection.issue
            return store
              .readTasks(issue, { limit: 20 })
              .pipe(
                Effect.map(page =>
                  formatTaskContinuation(
                    query,
                    issue,
                    Option.getOrUndefined(page),
                  ),
                ),
              )
          }),
        ),
        { signal: AbortSignal.any([signal, lifetime.signal]) },
      )
      running.add(execution)
      try {
        const result = await execution
        return Exit.isSuccess(result)
          ? Either.right(result.value)
          : Either.left(
              new TaskContinuationError({
                code: Cause.isInterruptedOnly(result.cause)
                  ? "interrupted"
                  : "unavailable",
                message:
                  "Task continuation could not read current issue/task state.",
              }),
            )
      } finally {
        running.delete(execution)
      }
    }
    return { ...tool, execute, continuation }
  })
}
