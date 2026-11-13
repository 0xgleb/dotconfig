import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Cause, Data, Effect, Either, Exit, Option } from "effect"
import { Type } from "typebox"
import { taskRenderers } from "./render.ts"
import {
  decodeIssueNextQuery,
  type IssueNextQuery,
  type IssueNextProgress,
  type IssueNextReadFailure,
  type IssueNextObserver,
  IssueNextReadError,
} from "./next.ts"
import type {
  TaskProjectPlacement,
  ProjectPlacementObservation,
} from "./placement.ts"
import type {
  IssueNextPicker,
  IssueNextPickResult,
  IssuePickupTrace,
  IssuePickupReadError,
  IssueNextPickError,
} from "./pickup.ts"
import { MAX_PLAN_ISSUES_PER_CALL, type IssueReference } from "./identity.ts"
import {
  MAX_TASK_TEXT,
  MAX_TASK_PAGE_SIZE,
  type IssueTaskPageResult,
  type IssueTaskDetail,
  type IssueTask,
  type IssueTaskPage,
  type MutationBatchId,
  type TaskAddress,
} from "./model.ts"
import { MAX_TASK_MUTATIONS, MAX_TASK_DEPENDENCIES } from "./mutations.ts"
import {
  MAX_GITHUB_READ_BYTES,
  MAX_GITHUB_ISSUE_PAGE_SIZE,
} from "./github-read.ts"
import {
  decodeIssueTaskListQuery,
  decodeIssueTaskGetQuery,
  type IssueTaskListQuery,
  type IssueTaskGetQuery,
  type IssueTaskListView,
  type IssueTaskDetailView,
  type IssueTaskReader,
  type IssueTaskReadFailure,
  type IssueTaskReadError,
} from "./issue-view.ts"
import {
  decodeTaskRequest,
  type TaskRequest,
  type TaskRequestDecodeError,
} from "./request.ts"
import type {
  SqliteTaskStore,
  TaskApplyContext,
  TaskApplyError,
  TaskApplyResult,
} from "./sqlite-store.ts"

const IssueParameters = Type.Object(
  {
    repository: Type.String({ minLength: 1, maxLength: 140 }),
    number: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
)
const TaskIdParameter = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
})
const DraftKeyParameter = Type.String({
  pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
})
const TaskTextParameter = Type.String({
  minLength: 1,
  maxLength: MAX_TASK_TEXT,
})
const TaskReferenceParameters = Type.Object(
  {
    issue: IssueParameters,
    task: Type.Union([
      Type.Object(
        { kind: Type.Literal("existing"), id: TaskIdParameter },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal("added"), key: DraftKeyParameter },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
)
const DependencyParameters = Type.Array(TaskReferenceParameters, {
  maxItems: MAX_TASK_DEPENDENCIES,
})
const TaskStatusParameter = Type.Union([
  Type.Literal("todo"),
  Type.Literal("doing"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
  Type.Object(
    { _tag: Type.Literal("blocked"), reason: TaskTextParameter },
    { additionalProperties: false },
  ),
])
const OperationParameters = Type.Union([
  Type.Object(
    {
      op: Type.Literal("add"),
      issue: IssueParameters,
      key: DraftKeyParameter,
      text: TaskTextParameter,
      dependsOn: Type.Optional(DependencyParameters),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("edit"),
      target: TaskReferenceParameters,
      text: Type.Optional(TaskTextParameter),
      dependsOn: Type.Optional(DependencyParameters),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("status"),
      target: TaskReferenceParameters,
      status: TaskStatusParameter,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("transfer"),
      target: TaskReferenceParameters,
      toIssue: IssueParameters,
    },
    { additionalProperties: false },
  ),
])
const TaskPageParameters = Type.Object(
  {
    limit: Type.Integer({ minimum: 1, maximum: MAX_TASK_PAGE_SIZE }),
    after: Type.Optional(TaskIdParameter),
  },
  { additionalProperties: false },
)
const TaskFilterParameters = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        Type.Literal("todo"),
        Type.Literal("doing"),
        Type.Literal("done"),
        Type.Literal("cancelled"),
        Type.Literal("blocked"),
      ]),
    ),
  },
  { additionalProperties: false },
)
const TaskReadQueryParameters = Type.Object(
  {
    issue: IssueParameters,
    page: TaskPageParameters,
    filter: Type.Optional(TaskFilterParameters),
  },
  { additionalProperties: false },
)
const GitHubCursorParameter = Type.String({
  minLength: 1,
  maxLength: MAX_GITHUB_READ_BYTES,
})
const RelatedIssueParameters = Type.Object(
  {
    limit: Type.Integer({ minimum: 1, maximum: MAX_GITHUB_ISSUE_PAGE_SIZE }),
    blockedByAfter: Type.Optional(GitHubCursorParameter),
    deliveryAfter: Type.Optional(GitHubCursorParameter),
  },
  { additionalProperties: false },
)
const IssueListQueryParameters = Type.Object(
  {
    repository: Type.String({ minLength: 1, maxLength: 140 }),
    state: Type.Union([
      Type.Literal("open"),
      Type.Literal("closed"),
      Type.Literal("all"),
    ]),
    page: Type.Object(
      {
        limit: Type.Integer({
          minimum: 1,
          maximum: MAX_GITHUB_ISSUE_PAGE_SIZE,
        }),
        after: Type.Optional(GitHubCursorParameter),
      },
      { additionalProperties: false },
    ),
    tasks: Type.Object(
      {
        limit: Type.Integer({ minimum: 1, maximum: MAX_TASK_PAGE_SIZE }),
        filter: Type.Optional(TaskFilterParameters),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
const IssueGetQueryParameters = Type.Object(
  {
    issue: Type.Object(
      {
        repository: Type.String({ minLength: 1, maxLength: 140 }),
        number: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
      },
      { additionalProperties: false },
    ),
    related: RelatedIssueParameters,
    tasks: Type.Object(
      { page: TaskPageParameters, filter: Type.Optional(TaskFilterParameters) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
const NextQueryParameters = Type.Object(
  {
    repository: Type.String({ minLength: 1, maxLength: 140 }),
    project: Type.Union([Type.Literal("personal"), Type.Literal("dataclique")]),
    mode: Type.Optional(
      Type.Union([Type.Literal("implementation"), Type.Literal("review")]),
    ),
  },
  { additionalProperties: false },
)
const TaskParameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("read"),
      Type.Literal("readMany"),
      Type.Literal("get"),
      Type.Literal("apply"),
      Type.Literal("listIssues"),
      Type.Literal("getIssue"),
      Type.Literal("next"),
    ]),
    query: Type.Optional(
      Type.Union([
        IssueListQueryParameters,
        IssueGetQueryParameters,
        NextQueryParameters,
      ]),
    ),
    issue: Type.Optional(IssueParameters),
    id: Type.Optional(TaskIdParameter),
    page: Type.Optional(TaskPageParameters),
    filter: Type.Optional(TaskFilterParameters),
    queries: Type.Optional(
      Type.Array(TaskReadQueryParameters, {
        minItems: 1,
        maxItems: MAX_TASK_PAGE_SIZE,
      }),
    ),

    issues: Type.Optional(
      Type.Array(IssueParameters, {
        minItems: 1,
        maxItems: MAX_PLAN_ISSUES_PER_CALL,
      }),
    ),
    operations: Type.Optional(
      Type.Array(OperationParameters, {
        minItems: 1,
        maxItems: MAX_TASK_MUTATIONS,
      }),
    ),
  },
  { additionalProperties: false },
)

export class TaskHostError extends Data.TaggedError("TaskHostError")<{
  readonly code: "host_unavailable"
  readonly message: string
}> {}
export class TaskOutputError extends Data.TaggedError("TaskOutputError")<{
  readonly message: string
}> {}

export type TaskExecutionOutcome =
  | { readonly kind: "issue_next"; readonly result: IssueNextPickResult }
  | { readonly kind: "next_progress"; readonly progress: IssueNextProgress }
  | { readonly kind: "issue_list"; readonly view: IssueTaskListView }
  | { readonly kind: "issue_detail"; readonly view: IssueTaskDetailView }
  | { readonly kind: "page"; readonly page: IssueTaskPage }
  | { readonly kind: "pages"; readonly pages: readonly IssueTaskPageResult[] }
  | { readonly kind: "task"; readonly detail: IssueTaskDetail }
  | { readonly kind: "missing_issue"; readonly issue: IssueReference }
  | { readonly kind: "missing_task"; readonly target: TaskAddress }
  | {
      readonly kind: "saved"
      readonly result: TaskApplyResult
      readonly projectPlacement?: readonly ProjectPlacementObservation[]
      readonly projectPlacementFailure?:
        "interrupted" | "unavailable" | "inconsistent_readback"
    }
  | {
      readonly kind: "failed"
      readonly code: Exclude<
        | TaskRequestDecodeError["code"]
        | TaskApplyError["code"]
        | TaskHostError["code"]
        | IssueTaskReadFailure["code"]
        | IssueNextReadFailure["code"]
        | IssuePickupReadError["code"]
        | IssueNextPickError["code"]
        | "execution_defect",
        "unknown_completion"
      >
      readonly message: string
    }
  | {
      readonly kind: "unknown"
      readonly batchId: MutationBatchId
      readonly requestId: string
      readonly message: string
    }
  | { readonly kind: "interrupted" }
  | {
      readonly kind: "unconfirmed"
      readonly invocation: TaskNativeCall
      readonly pickup?: IssuePickupTrace
      readonly stop: "interrupted" | "execution_defect"
      readonly message: string
    }

export interface TaskToolDetails {
  readonly outcome: TaskExecutionOutcome
  readonly output: "complete" | "unavailable"
  readonly invocation?: TaskNativeCall
  readonly displayTasks?: readonly {
    readonly issue: IssueReference
    readonly task: IssueTask
  }[]
}
export interface TaskNativeCall {
  readonly toolCallId: string
  readonly sessionId: string
}
export interface TaskToolOptions {
  readonly placeAffected?: TaskProjectPlacement["placeAffected"]
  readonly nextPicker?: IssueNextPicker
  readonly issueReader?: IssueTaskReader
  readonly store: Pick<
    SqliteTaskStore,
    "apply" | "readTasks" | "readTask" | "readManyTasks"
  >
  readonly contextForCall: (
    call: TaskNativeCall,
  ) => Effect.Effect<TaskApplyContext, TaskHostError>
  readonly renderOutput: (
    outcome: TaskExecutionOutcome,
  ) => Effect.Effect<string, TaskOutputError>
}
export type IssueTaskTool = ToolDefinition<
  typeof TaskParameters,
  TaskToolDetails
>

type TaskFailure =
  | TaskRequestDecodeError
  | TaskApplyError
  | TaskHostError
  | IssueTaskReadFailure
  | IssueNextReadFailure
  | IssuePickupReadError
  | IssueNextPickError
type TaskToolRequest =
  | TaskRequest
  | { readonly action: "listIssues"; readonly query: IssueTaskListQuery }
  | { readonly action: "getIssue"; readonly query: IssueTaskGetQuery }
  | { readonly action: "next"; readonly query: IssueNextQuery }
const decodeToolRequest = (
  input: unknown,
): Either.Either<
  TaskToolRequest,
  TaskRequestDecodeError | IssueTaskReadError | IssueNextReadError
> => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return decodeTaskRequest(input)

  const action: unknown = Reflect.get(input, "action")
  if (action !== "listIssues" && action !== "getIssue" && action !== "next")
    return decodeTaskRequest(input)
  if (
    !Object.hasOwn(input, "action") ||
    !Object.hasOwn(input, "query") ||
    Reflect.ownKeys(input).some(key => key !== "action" && key !== "query")
  )
    return decodeTaskRequest(input)

  const query: unknown = Reflect.get(input, "query")
  if (action === "next")
    return decodeIssueNextQuery(query).pipe(
      Either.map(value => Object.freeze({ action: "next", query: value })),
    )
  return action === "listIssues"
    ? decodeIssueTaskListQuery(query).pipe(
        Either.map(value =>
          Object.freeze({ action: "listIssues", query: value }),
        ),
      )
    : decodeIssueTaskGetQuery(query).pipe(
        Either.map(value =>
          Object.freeze({ action: "getIssue", query: value }),
        ),
      )
}
const failureOutcome = (error: TaskFailure): TaskExecutionOutcome =>
  error._tag === "TaskCommitUnknownError"
    ? {
        kind: "unknown",
        batchId: error.batchId,
        requestId: error.requestId,
        message: error.message,
      }
    : { kind: "failed", code: error.code, message: error.message }

const executeRequest = (
  request: TaskToolRequest,
  call: TaskNativeCall,
  options: TaskToolOptions,
  writeStarted: () => void,
  onPickupTrace: (trace: IssuePickupTrace) => void,
  observeNext: IssueNextObserver,
): Effect.Effect<TaskExecutionOutcome> =>
  Effect.gen(function* () {
    switch (request.action) {
      case "next": {
        const picker = options.nextPicker
        if (picker === undefined)
          return yield* Effect.fail(
            new TaskHostError({
              code: "host_unavailable",
              message: "Native next dispatch is unavailable",
            }),
          )
        yield* options.contextForCall(call)
        const result = yield* picker.next(
          request.query,
          call,
          onPickupTrace,
          observeNext,
        )
        return { kind: "issue_next", result } satisfies TaskExecutionOutcome
      }
      case "listIssues":
      case "getIssue": {
        const reader = options.issueReader

        if (reader === undefined)
          return yield* Effect.fail(
            new TaskHostError({
              code: "host_unavailable",
              message: "Issue reader is unavailable in this host",
            }),
          )

        if (request.action === "listIssues") {
          const view = yield* reader.list(request.query)
          return { kind: "issue_list", view } satisfies TaskExecutionOutcome
        }
        const view = yield* reader.get(request.query)
        return { kind: "issue_detail", view } satisfies TaskExecutionOutcome
      }
      case "readMany": {
        const pages = yield* options.store.readManyTasks(request.queries)

        return { kind: "pages", pages } satisfies TaskExecutionOutcome
      }
      case "read": {
        const page = yield* options.store.readTasks(
          request.issue,
          request.page,
          request.filter,
        )

        if (Option.isNone(page))
          return {
            kind: "missing_issue",
            issue: request.issue,
          } satisfies TaskExecutionOutcome

        return { kind: "page", page: page.value } satisfies TaskExecutionOutcome
      }
      case "get": {
        const detail = yield* options.store.readTask(
          request.target.issue,
          request.target.id,
        )

        if (Option.isNone(detail))
          return {
            kind: "missing_task",
            target: request.target,
          } satisfies TaskExecutionOutcome

        return {
          kind: "task",
          detail: detail.value,
        } satisfies TaskExecutionOutcome
      }
      case "apply": {
        const context = yield* options.contextForCall(call)
        yield* Effect.sync(writeStarted)
        const result = yield* options.store.apply(request.batch, context)

        return { kind: "saved", result } satisfies TaskExecutionOutcome
      }
    }
  }).pipe(Effect.catchAll(error => Effect.succeed(failureOutcome(error))))

const unavailableOutput = (outcome: TaskExecutionOutcome): string => {
  switch (outcome.kind) {
    case "issue_next": {
      const next = outcome.result
      if (next.kind === "none")
        return "No eligible issue was selected. Detailed observations retained."
      if (next.kind === "review")
        return "Review selection retained; issue assignees and status were not changed."
      const target = next.receipt.trace.target
      return next.receipt.kind === "verified"
        ? `Verified ${target.issue.repository}#${target.issue.number} assigned to ${target.viewer.login} and In Progress at readback; no exclusive ownership guarantee. Detailed observations retained.`
        : `Pickup ${next.receipt.kind} for ${target.issue.repository}#${target.issue.number}. Reconcile retained effect observations; do not automatically retry or select another issue.`
    }
    case "next_progress":
      return `Reading next issue: ${outcome.progress.stage}, ${outcome.progress.reads} source reads.`
    case "issue_list":
      return `Read ${outcome.view.issues.length} issues from ${outcome.view.repository}. Detailed output unavailable.`
    case "issue_detail": {
      const metadata =
        outcome.view.detail === null
          ? "GitHub metadata unavailable"
          : "Read issue metadata"
      const tasks =
        outcome.view.tasks === null
          ? "No local task state"
          : `Local task page: ${outcome.view.tasks.tasks.length} tasks, revision ${outcome.view.tasks.revision}`
      return `${metadata} for ${outcome.view.issue.repository}#${outcome.view.issue.number}. ${tasks}. Detailed output unavailable.`
    }
    case "saved": {
      const incomplete =
        outcome.projectPlacementFailure !== undefined ||
        outcome.projectPlacement?.some(row => row.kind !== "linked") === true
      return `Saved task batch ${outcome.result.batchId} (${outcome.result.receipt}); ${outcome.result.changed.length} changed, ${outcome.result.created.length} created. ${incomplete ? "Project placement incomplete; local tasks remain saved. Reconcile Project membership without resubmitting the task write. " : ""}Detailed output unavailable. Do not repeat this write with a new request identity.`
    }
    case "pages":
      return `Checked ${outcome.pages.length} qualified issue-page queries. Detailed output unavailable.`
    case "page":
      return `Read ${outcome.page.tasks.length} tasks from ${outcome.page.issue.repository}#${outcome.page.issue.number}, revision ${outcome.page.revision}. Detailed output unavailable.`
    case "task":
      return `Read task ${outcome.detail.task.id} from ${outcome.detail.issue.repository}#${outcome.detail.issue.number}. Detailed output unavailable.`
    case "missing_issue":
      return `No task state found for ${outcome.issue.repository}#${outcome.issue.number}.`
    case "missing_task":
      return `Task ${outcome.target.id} was not found under ${outcome.target.issue.repository}#${outcome.target.issue.number}.`
    case "failed":
      return `Task operation failed (${outcome.code}). Detailed output unavailable.`
    case "unknown":
      return `Completion is unknown for batch ${outcome.batchId}. Reconcile the original request; do not retry with a new identity.`
    case "interrupted":
      return "Task operation interrupted."
    case "unconfirmed":
      return "Task execution did not produce a verified outcome. Reconcile state before retrying; do not substitute a new request identity."
  }
}
const placeSavedOutcome = async (
  saved: Extract<TaskExecutionOutcome, { readonly kind: "saved" }>,
  invocation: TaskNativeCall | undefined,
  options: TaskToolOptions,
  signal: AbortSignal | undefined,
): Promise<Extract<TaskExecutionOutcome, { readonly kind: "saved" }>> => {
  const captured = Either.try({
    try: () => options.placeAffected,
    catch: () => "unavailable" as const,
  })
  if (Either.isRight(captured) && captured.right === undefined) return saved
  const scope = new Map(
    saved.result.issues.map(row => [
      `${row.issue.repository}#${row.issue.number}`,
      row.issue,
    ]),
  )
  let known = new Map<string, ProjectPlacementObservation>()
  let inconsistent = false
  const observe = (
    observations: readonly ProjectPlacementObservation[],
  ): void => {
    const next = new Map<string, ProjectPlacementObservation>()
    for (const row of observations) {
      const key = `${row.issue.repository}#${row.issue.number}`
      if (!scope.has(key) || next.has(key)) {
        inconsistent = true
        return
      }
      next.set(key, row)
    }
    if ([...known.keys()].some(key => !next.has(key))) {
      inconsistent = true
      return
    }
    known = next
  }
  let failure:
    "interrupted" | "unavailable" | "inconsistent_readback" | undefined
  if (Either.isLeft(captured) || invocation === undefined)
    failure = "unavailable"
  else {
    const place = captured.right
    if (place !== undefined) {
      const attempted = await Effect.runPromiseExit(
        Effect.suspend(() => place(saved.result, invocation, observe)),
        signal === undefined ? {} : { signal },
      )
      if (Exit.isSuccess(attempted)) observe(attempted.value)
      else
        failure = Cause.isInterruptedOnly(attempted.cause)
          ? "interrupted"
          : "unavailable"
    }
  }
  if (inconsistent) failure = "inconsistent_readback"
  if (known.size !== scope.size && failure === undefined)
    failure = "inconsistent_readback"
  const projectPlacement: readonly ProjectPlacementObservation[] =
    Object.freeze(
      [...scope].map(([key, issue]) => {
        const observed = known.get(key)
        return observed === undefined
          ? Object.freeze({
              kind: "not_attempted" as const,
              issue,
              reason:
                failure === "interrupted"
                  ? ("cancelled" as const)
                  : ("unavailable" as const),
            })
          : observed
      }),
    )
  return Object.freeze({
    ...saved,
    projectPlacement,
    ...(failure === undefined ? {} : { projectPlacementFailure: failure }),
  })
}

const withinOutputBudget = (text: unknown): text is string =>
  typeof text === "string" &&
  Buffer.byteLength(text, "utf8") <= 50 * 1_024 &&
  text.split("\n").length <= 2_000

export const createTaskTool = (options: TaskToolOptions): IssueTaskTool => ({
  name: "task",
  label: "Task",
  description:
    "Select and pick up an eligible issue with next query {repository,project:personal|dataclique,mode?:implementation|review}; review mode selects In review without changing assignees or status. Use positive integers when writing GitHub Priority ranks; next also accepts existing positive finite fractional priorities. Read/get issue-qualified tasks, listIssues/getIssue metadata with local tasks, or apply an atomic explicit-issue mutation batch. read uses issue/page/filter; readMany explicit queries totals at most 100 requested tasks; get uses issue/id. listIssues uses query {repository,state,page,tasks:{limit,filter?}} with at most 100 aggregate requested tasks; getIssue uses query {issue,related:{limit,blockedByAfter?,deliveryAfter?},tasks:{page,filter?}}. apply uses complete issues/operations (add, edit, status, block, transfer). No worker selection or replies. Mutation authority and request identity come only from the host.",
  parameters: TaskParameters,
  ...taskRenderers,
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    let outcome: TaskExecutionOutcome
    let completedInvocation: TaskNativeCall | undefined
    if (signal?.aborted === true) outcome = { kind: "interrupted" }
    else {
      const attempt: {
        invocation: TaskNativeCall | undefined
        pickup: IssuePickupTrace | undefined
      } = {
        invocation: undefined,
        pickup: undefined,
      }
      const operation = Effect.suspend(() => {
        const decoded = decodeToolRequest(params)

        if (Either.isLeft(decoded))
          return Effect.succeed(failureOutcome(decoded.left))

        const invocation = {
          toolCallId,
          sessionId: ctx.sessionManager.getSessionId(),
        }
        completedInvocation = invocation

        const observeNext: IssueNextObserver = progress =>
          Effect.try({
            try: () =>
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `Reading next issue: ${progress.stage}, ${progress.reads} source reads.`,
                  },
                ],
                details: {
                  outcome: { kind: "next_progress", progress },
                  output: "complete",
                },
              }),
            catch: () =>
              new IssueNextReadError({
                code: "observer_unavailable",
                message: "Next issue progress could not be delivered",
              }),
          })
        return executeRequest(
          decoded.right,
          invocation,
          options,
          () => {
            attempt.invocation = invocation
          },
          trace => {
            attempt.pickup = trace
            if (
              trace.assignment === "possible" ||
              trace.assignment === "acknowledged" ||
              trace.status === "possible" ||
              trace.status === "acknowledged"
            )
              attempt.invocation = invocation
          },
          observeNext,
        )
      })
      const executed = await Effect.runPromiseExit(operation, { signal })

      if (Exit.isSuccess(executed)) outcome = executed.value
      else {
        const interrupted = Cause.isInterruptedOnly(executed.cause)
        outcome =
          attempt.invocation !== undefined
            ? {
                kind: "unconfirmed",
                invocation: attempt.invocation,
                ...(attempt.pickup === undefined
                  ? {}
                  : { pickup: attempt.pickup }),
                stop: interrupted ? "interrupted" : "execution_defect",
                message:
                  "Write completion is unconfirmed; reconcile the original invocation before retrying",
              }
            : interrupted
              ? { kind: "interrupted" }
              : {
                  kind: "failed",
                  code: "execution_defect",
                  message: "Task execution failed before starting a write",
                }
      }
    }

    if (outcome.kind === "saved")
      outcome = await placeSavedOutcome(
        outcome,
        completedInvocation,
        options,
        signal,
      )

    // Only receipt-matching readback may supply display names/states. A failed
    // display read never changes the already-established mutation outcome.
    let displayTasks: TaskToolDetails["displayTasks"]
    if (outcome.kind === "saved") {
      const named = await Effect.runPromiseExit(
        Effect.forEach(outcome.result.changed.slice(0, 3), row =>
          Effect.suspend(() => options.store.readTask(row.issue, row.id)).pipe(
            Effect.map(detail =>
              Option.filter(
                detail,
                value =>
                  value.revision === row.revision &&
                  value.task.id === row.id &&
                  value.issue.repository === row.issue.repository &&
                  value.issue.number === row.issue.number,
              ),
            ),
          ),
        ),
        signal === undefined ? {} : { signal },
      )
      displayTasks = Exit.isSuccess(named)
        ? named.value.flatMap(detail =>
            Option.isSome(detail)
              ? [{ issue: detail.value.issue, task: detail.value.task }]
              : [],
          )
        : []
    }

    const rendered =
      signal?.aborted === true
        ? undefined
        : await Effect.runPromiseExit(
            Effect.suspend(() => options.renderOutput(outcome)),
            { signal },
          )
    const complete =
      rendered !== undefined &&
      Exit.isSuccess(rendered) &&
      withinOutputBudget(rendered.value)
    const text = complete ? rendered.value : unavailableOutput(outcome)

    return {
      content: [{ type: "text", text }],
      details: {
        outcome,
        output: complete ? "complete" : "unavailable",
        ...(completedInvocation === undefined
          ? {}
          : { invocation: completedInvocation }),
        ...(displayTasks === undefined ? {} : { displayTasks }),
      },
      isError:
        outcome.kind === "failed" ||
        outcome.kind === "unknown" ||
        (outcome.kind === "saved" &&
          (outcome.projectPlacementFailure !== undefined ||
            outcome.projectPlacement?.some(row => row.kind !== "linked") ===
              true)) ||
        (outcome.kind === "issue_next" &&
          outcome.result.kind === "pickup" &&
          outcome.result.receipt.kind !== "verified") ||
        (outcome.kind === "unconfirmed" && outcome.stop === "execution_defect"),
    }
  },
})

export const registerTaskTool = (
  pi: Pick<ExtensionAPI, "registerTool">,
  options: TaskToolOptions,
): IssueTaskTool => {
  const tool = createTaskTool(options)
  pi.registerTool(tool)
  return tool
}
