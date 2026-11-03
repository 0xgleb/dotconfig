import { Effect, type Scope } from "effect"
import { createGitHubCliReader } from "./github-cli.ts"
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
    const issueReader = createIssueTaskReader({
      github: createGitHubCliReader({ cwd }),
      tasks: store,
    })

    return createTaskTool({ store, issueReader, contextForCall, renderOutput })
  })
}
