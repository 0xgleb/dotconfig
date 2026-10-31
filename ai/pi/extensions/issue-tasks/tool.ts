import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Cause, Data, Effect, Either, Exit, Option } from "effect"
import { Type } from "typebox"
import { MAX_PLAN_ISSUES_PER_CALL, type IssueReference } from "./identity.ts"
import {
  MAX_TASK_TEXT,
  type IssueTaskDetail,
  type IssueTaskPage,
  type MutationBatchId,
  type TaskAddress,
} from "./model.ts"
import { MAX_TASK_MUTATIONS, MAX_TASK_DEPENDENCIES } from "./mutations.ts"
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
      status: Type.Union([
        Type.Literal("todo"),
        Type.Literal("doing"),
        Type.Literal("done"),
        Type.Literal("cancelled"),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("block"),
      target: TaskReferenceParameters,
      reason: Type.Union([Type.Null(), TaskTextParameter]),
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
const TaskParameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("read"),
      Type.Literal("get"),
      Type.Literal("apply"),
    ]),
    issue: Type.Optional(IssueParameters),
    id: Type.Optional(TaskIdParameter),
    page: Type.Optional(
      Type.Object(
        {
          limit: Type.Integer({ minimum: 1, maximum: 100 }),
          after: Type.Optional(TaskIdParameter),
        },
        { additionalProperties: false },
      ),
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
  | { readonly kind: "page"; readonly page: IssueTaskPage }
  | { readonly kind: "task"; readonly detail: IssueTaskDetail }
  | { readonly kind: "missing_issue"; readonly issue: IssueReference }
  | { readonly kind: "missing_task"; readonly target: TaskAddress }
  | { readonly kind: "saved"; readonly result: TaskApplyResult }
  | {
      readonly kind: "failed"
      readonly code: Exclude<
        | TaskRequestDecodeError["code"]
        | TaskApplyError["code"]
        | TaskHostError["code"]
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
      readonly stop: "interrupted" | "execution_defect"
      readonly message: string
    }

export interface TaskToolDetails {
  readonly outcome: TaskExecutionOutcome
  readonly output: "complete" | "unavailable"
}
export interface TaskNativeCall {
  readonly toolCallId: string
  readonly sessionId: string
}
export interface TaskToolOptions {
  readonly store: Pick<SqliteTaskStore, "apply" | "readTasks" | "readTask">
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

type TaskFailure = TaskRequestDecodeError | TaskApplyError | TaskHostError
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
  request: TaskRequest,
  call: TaskNativeCall,
  options: TaskToolOptions,
  writeStarted: () => void,
): Effect.Effect<TaskExecutionOutcome> =>
  Effect.gen(function* () {
    switch (request.action) {
      case "read": {
        const page = yield* options.store.readTasks(request.issue, request.page)

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
    case "saved":
      return `Saved task batch ${outcome.result.batchId} (${outcome.result.receipt}); ${outcome.result.changed.length} changed, ${outcome.result.created.length} created. Detailed output unavailable. Do not repeat this write with a new request identity.`
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
const withinOutputBudget = (text: unknown): text is string =>
  typeof text === "string" &&
  Buffer.byteLength(text, "utf8") <= 50 * 1_024 &&
  text.split("\n").length <= 2_000

export const createTaskTool = (options: TaskToolOptions): IssueTaskTool => ({
  name: "task",
  label: "Task",
  description:
    "Read/get issue-qualified tasks or apply an atomic explicit-issue mutation batch. Read requires issue/page; get requires issue/id; apply requires complete issues/operations (add, edit, status, block, transfer). No worker selection or replies. Authority and request identity come only from the host.",
  parameters: TaskParameters,
  execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
    let outcome: TaskExecutionOutcome
    if (signal?.aborted === true) outcome = { kind: "interrupted" }
    else {
      const attempt: { invocation: TaskNativeCall | undefined } = {
        invocation: undefined,
      }
      const operation = Effect.suspend(() => {
        const decoded = decodeTaskRequest(params)

        if (Either.isLeft(decoded))
          return Effect.succeed(failureOutcome(decoded.left))

        const invocation = {
          toolCallId,
          sessionId: ctx.sessionManager.getSessionId(),
        }

        return executeRequest(decoded.right, invocation, options, () => {
          attempt.invocation = invocation
        })
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
      details: { outcome, output: complete ? "complete" : "unavailable" },
      isError:
        outcome.kind === "failed" ||
        outcome.kind === "unknown" ||
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
