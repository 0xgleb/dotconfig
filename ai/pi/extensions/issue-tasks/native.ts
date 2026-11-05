import { Effect, type Scope } from "effect"
import {
  createGitHubCliReader,
  createGitHubCliProjectReader,
  createGitHubCliPickupClient,
  createGitHubCliProjectPlacement,
} from "./github-cli.ts"
import { createIssueNextReader } from "./next.ts"
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

export const acquireNativeTaskTool = (
  options: NativeTaskToolOptions,
): Effect.Effect<IssueTaskTool, TaskStoreError, Scope.Scope> => {
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

    const running = new Set<ReturnType<IssueTaskTool["execute"]>>()
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
    const nextPicker = createIssueNextPicker({
      reader: createIssueNextReader({
        projects: createGitHubCliProjectReader({ cwd }),
        github,
        tasks: store,
      }),
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
    return { ...tool, execute }
  })
}
