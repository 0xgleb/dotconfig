import { Text } from "@earendil-works/pi-tui"
import { Either, Schema } from "effect"
import {
  decodeIssueReference,
  issueKey,
  type IssueReference,
} from "./identity.ts"
import { TaskIdSchema, StatusSchema, RevisionSchema } from "./model.ts"
import type { IssueTaskTool } from "./tool.ts"
import { GitHubUserSchema } from "./github-user.ts"
import {
  GitHubInProgressTargetSchema,
  GitHubIssueNodeIdSchema,
  ProjectItemIdSchema,
} from "./github-project-read.ts"

const IssueSchema = Schema.declare<IssueReference>(
  (input): input is IssueReference => {
    const decoded = decodeIssueReference(input)
    return (
      Either.isRight(decoded) &&
      record(input)?.repository === decoded.right.repository
    )
  },
)
const TaskSchema = Schema.Struct({
  id: TaskIdSchema,
  text: Schema.String,
  status: StatusSchema,
  blocker: Schema.NullOr(Schema.String),
})
const PageSchema = Schema.Struct({
  issue: IssueSchema,
  revision: RevisionSchema,
  tasks: Schema.Array(TaskSchema),
  next: Schema.NullOr(TaskIdSchema),
})
const SelectionSchema = Schema.Struct({
  selection: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({ kind: Schema.Literal("selected"), issue: IssueSchema }),
  ),
  selected: Schema.NullOr(
    Schema.Struct({
      issue: IssueSchema,
      itemId: ProjectItemIdSchema,
      issueNodeId: GitHubIssueNodeIdSchema,
    }),
  ),
  viewer: GitHubUserSchema,
  inProgress: GitHubInProgressTargetSchema,
})
const TargetSchema = Schema.Struct({
  issue: IssueSchema,
  issueNodeId: GitHubIssueNodeIdSchema,
  itemId: ProjectItemIdSchema,
  viewer: GitHubUserSchema,
  inProgress: GitHubInProgressTargetSchema,
})
const ReadbackSchema = Schema.Struct({
  viewer: GitHubUserSchema,
  issue: IssueSchema,
  issueNodeId: GitHubIssueNodeIdSchema,
  itemId: ProjectItemIdSchema,
  projectId: Schema.String,
  state: Schema.Literal("open", "closed"),
  archived: Schema.Boolean,
  assignees: Schema.Array(GitHubUserSchema),
  status: Schema.NullOr(
    Schema.Struct({ fieldId: Schema.String, optionId: Schema.String }),
  ),
})
const TraceSchema = Schema.Struct({
  target: TargetSchema,
  assignment: Schema.Literal(
    "not_started",
    "not_needed",
    "acknowledged",
    "possible",
  ),
  status: Schema.Literal(
    "not_started",
    "not_needed",
    "acknowledged",
    "possible",
  ),
})
const ReceiptSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("verified"),
    trace: TraceSchema,
    observed: ReadbackSchema,
    verification: Schema.Literal("observed_not_exclusive"),
  }),
  Schema.Struct({
    kind: Schema.Literal("partial"),
    trace: TraceSchema,
    observed: ReadbackSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    trace: TraceSchema,
    observed: Schema.NullOr(ReadbackSchema),
  }),
)
const NextSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none"), observation: SelectionSchema }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    observation: SelectionSchema,
    observed: ReadbackSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("pickup"),
    observation: SelectionSchema,
    receipt: ReceiptSchema,
  }),
).pipe(
  Schema.filter(next => {
    const observation = next.observation
    const selected = observation.selected
    if (next.kind === "none")
      return selected === null && observation.selection.kind === "none"
    if (
      selected === null ||
      observation.selection.kind !== "selected" ||
      issueKey(selected.issue) !== issueKey(observation.selection.issue)
    )
      return false
    if (next.kind === "review")
      return (
        issueKey(selected.issue) === issueKey(next.observed.issue) &&
        selected.itemId === next.observed.itemId &&
        selected.issueNodeId === next.observed.issueNodeId
      )
    const { target } = next.receipt.trace
    if (
      issueKey(selected.issue) !== issueKey(target.issue) ||
      selected.itemId !== target.itemId ||
      selected.issueNodeId !== target.issueNodeId ||
      observation.viewer.id !== target.viewer.id ||
      observation.viewer.login !== target.viewer.login ||
      observation.inProgress.projectId !== target.inProgress.projectId ||
      observation.inProgress.fieldId !== target.inProgress.fieldId ||
      observation.inProgress.optionId !== target.inProgress.optionId
    )
      return false
    if (next.receipt.kind !== "verified") return true
    const observed = next.receipt.observed
    return (
      issueKey(observed.issue) === issueKey(target.issue) &&
      observed.issueNodeId === target.issueNodeId &&
      observed.itemId === target.itemId &&
      observed.projectId === target.inProgress.projectId &&
      observed.viewer.id === target.viewer.id &&
      observed.viewer.login === target.viewer.login &&
      observed.state === "open" &&
      !observed.archived &&
      observed.assignees.length > 0 &&
      observed.assignees.every(user => user.id === target.viewer.id) &&
      observed.status?.fieldId === target.inProgress.fieldId &&
      observed.status.optionId === target.inProgress.optionId
    )
  }),
)
export const decodeTaskNextResult = Schema.decodeUnknownEither(NextSchema)

const PlacementSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("linked"), issue: IssueSchema }),
  Schema.Struct({ kind: Schema.Literal("unknown"), issue: IssueSchema }),
  Schema.Struct({
    kind: Schema.Literal("failed", "not_attempted"),
    issue: IssueSchema,
    reason: Schema.String,
  }),
)
const OutcomeSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("page"), page: PageSchema }),
  Schema.Struct({
    kind: Schema.Literal("pages"),
    pages: Schema.Array(
      Schema.Struct({ issue: IssueSchema, page: Schema.NullOr(PageSchema) }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("task"),
    detail: Schema.Struct({ issue: IssueSchema, task: TaskSchema }),
  }),
  Schema.Struct({
    kind: Schema.Literal("issue_detail"),
    view: Schema.Struct({
      issue: IssueSchema,
      detail: Schema.NullOr(Schema.Struct({ title: Schema.String })),
      tasks: Schema.NullOr(PageSchema),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("issue_list"),
    view: Schema.Struct({
      repository: Schema.String,
      issues: Schema.Array(
        Schema.Struct({
          metadata: Schema.Struct({ issue: IssueSchema, title: Schema.String }),
          tasks: Schema.NullOr(PageSchema),
        }),
      ),
      pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("missing_issue"), issue: IssueSchema }),
  Schema.Struct({
    kind: Schema.Literal("missing_task"),
    target: Schema.Struct({ issue: IssueSchema, id: TaskIdSchema }),
  }),
  Schema.Struct({
    kind: Schema.Literal("saved"),
    result: Schema.Struct({
      changed: Schema.Array(Schema.Unknown),
      created: Schema.Array(Schema.Unknown),
      receipt: Schema.Literal("committed", "replayed", "recovered"),
      issues: Schema.Array(
        Schema.Struct({ issue: IssueSchema, revision: RevisionSchema }),
      ),
    }),
    projectPlacement: Schema.optional(Schema.Array(PlacementSchema)),
    projectPlacementFailure: Schema.optional(
      Schema.Literal("interrupted", "unavailable", "inconsistent_readback"),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    code: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("unknown"), message: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("unconfirmed"),
    stop: Schema.Literal("interrupted", "execution_defect"),
    message: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("interrupted") }),
  Schema.Struct({
    kind: Schema.Literal("next_progress"),
    progress: Schema.Struct({ stage: Schema.String, reads: Schema.Number }),
  }),
  Schema.Struct({
    kind: Schema.Literal("issue_next"),
    result: NextSchema,
  }),
)
const DetailsSchema = Schema.Struct({
  outcome: OutcomeSchema,
  output: Schema.Literal("complete", "unavailable"),
  displayTasks: Schema.optional(
    Schema.Array(Schema.Struct({ issue: IssueSchema, task: TaskSchema })),
  ),
})

const safeText = (text: string): string =>
  text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )

const label = (text: string): string =>
  safeText(text).replace(/\s+/gu, " ").trim()

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const record = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  isRecord(value) ? value : undefined

const issueLabel = (value: unknown): string => {
  const issue = record(value)
  return typeof issue?.repository === "string" &&
    typeof issue.number === "number"
    ? `${label(issue.repository)}#${issue.number}`
    : "issue not yet specified"
}

const operationLabel = (value: unknown): string => {
  const operation = record(value)
  if (typeof operation?.op !== "string") return "incomplete operation"
  const target = record(operation.target)
  const task = record(target?.task)
  const name =
    typeof operation.text === "string"
      ? label(operation.text).slice(0, 160)
      : typeof task?.id === "string"
        ? `task ${task.id.slice(0, 8)}`
        : typeof task?.key === "string"
          ? task.key
          : "task"
  if (operation.op === "status" && !Schema.is(StatusSchema)(operation.status))
    return `status · incomplete operation · ${issueLabel(target?.issue)}`
  const change =
    operation.op === "status" && typeof operation.status === "string"
      ? ` → ${operation.status}`
      : ""
  return `${label(operation.op)} ${name}${change} · ${issueLabel(operation.issue ?? target?.issue)}`
}

const callLines = (args: unknown): readonly string[] => {
  const input = record(args)
  if (typeof input?.action !== "string") return ["Task · receiving arguments"]
  const query = record(input.query)
  if (input.action === "apply" && Array.isArray(input.operations))
    return [
      `Task · apply ${input.operations.length} operations`,
      ...input.operations.slice(0, 3).map(operationLabel),
      ...(input.operations.length > 3
        ? ["More operations in expanded arguments"]
        : []),
    ]
  if (input.action === "next")
    return [
      `Task · select ${label(typeof query?.mode === "string" ? query.mode : "implementation")} issue · ${label(typeof query?.repository === "string" ? query.repository : "repository not yet specified")}`,
    ]
  if (input.action === "listIssues")
    return [
      `Task · list issues · ${label(typeof query?.repository === "string" ? query.repository : "repository not yet specified")}`,
    ]
  if (input.action === "readMany")
    return [
      `Task · read ${Array.isArray(input.queries) ? input.queries.length : "pending"} issue pages`,
    ]
  return [
    `Task · ${label(input.action)} · ${issueLabel(input.issue ?? query?.issue)}`,
  ]
}

const taskLine = (task: typeof TaskSchema.Type): string =>
  `${task.status} · ${label(task.text).slice(0, 200)}${task.blocker === null ? "" : ` · Blocked: ${label(task.blocker).slice(0, 160)}${task.blocker.length > 160 ? "… (expand for full blocker)" : ""}`}`

const pageLines = (page: typeof PageSchema.Type): readonly string[] => [
  `${issueKey(page.issue)} · ${page.tasks.length} tasks on this page${page.next === null ? "" : " · more available"}`,
  ...page.tasks.slice(0, 3).map(taskLine),
  ...(page.tasks.length > 3
    ? [`${page.tasks.length - 3} more tasks in expanded details`]
    : []),
  ...(page.tasks.slice(3).some(task => task.blocker !== null)
    ? [
        `${page.tasks.slice(3).filter(task => task.blocker !== null).length} additional blocked tasks · expand for blockers`,
      ]
    : []),
]

const outcomeLines = (
  outcome: typeof OutcomeSchema.Type,
): readonly string[] => {
  switch (outcome.kind) {
    case "page":
      return pageLines(outcome.page)
    case "pages":
      return outcome.pages.flatMap(row =>
        row.page === null
          ? [`${issueKey(row.issue)} · no local task state`]
          : pageLines(row.page),
      )
    case "task":
      return [issueKey(outcome.detail.issue), taskLine(outcome.detail.task)]
    case "issue_detail":
      return [
        `${issueKey(outcome.view.issue)} · ${outcome.view.detail === null ? "GitHub metadata unavailable" : label(outcome.view.detail.title)}`,
        ...(outcome.view.tasks === null
          ? ["No local task state"]
          : pageLines(outcome.view.tasks)),
      ]
    case "issue_list":
      return [
        `${outcome.view.repository} · ${outcome.view.issues.length} issues on this page${outcome.view.pageInfo.hasNextPage ? " · more available" : ""}`,
        ...outcome.view.issues.map(
          row =>
            `${issueKey(row.metadata.issue)} · ${label(row.metadata.title)} · ${row.tasks === null ? "no local task state" : `${row.tasks.tasks.length} tasks on this page${row.tasks.next === null ? "" : " · more tasks available"}`}`,
        ),
      ]
    case "missing_issue":
      return [`${issueKey(outcome.issue)} · no local task state`]
    case "missing_task":
      return [
        `${issueKey(outcome.target.issue)} · task ${outcome.target.id.slice(0, 8)} not found`,
      ]
    case "saved":
      return [
        `Saved locally · ${outcome.result.changed.length} changed · ${outcome.result.created.length} created · ${outcome.result.receipt}`,
        ...outcome.result.issues.map(
          row => `${issueKey(row.issue)} · revision ${row.revision}`,
        ),
        ...(outcome.projectPlacement ?? [])
          .filter(row => row.kind !== "linked")
          .map(
            row =>
              `${issueKey(row.issue)} · Project ${row.kind}${"reason" in row ? `: ${row.reason}` : ""}`,
          ),
        ...(outcome.projectPlacementFailure === undefined
          ? []
          : [
              `Project placement incomplete: ${outcome.projectPlacementFailure}`,
            ]),
        "Do not resubmit the saved task write; reconcile any incomplete Project effects separately.",
      ]
    case "failed":
      return [`Task failed · ${outcome.code}: ${outcome.message}`]
    case "unknown":
      return [
        "Task completion unknown",
        outcome.message,
        "Reconcile the original request; do not retry with a new identity.",
      ]
    case "unconfirmed":
      return [
        `Task write unconfirmed · ${outcome.stop}`,
        outcome.message,
        "Reconcile retained invocation/effect details before retrying; do not select replacement work.",
      ]
    case "interrupted":
      return ["Task operation interrupted"]
    case "next_progress":
      return [
        `Selecting issue · ${outcome.progress.stage} · ${outcome.progress.reads} source reads`,
      ]
    case "issue_next": {
      const next = outcome.result
      if (next.kind === "none") return ["No eligible issue selected"]
      if (next.kind === "review")
        return [
          `Review selected · ${issueKey(next.observed.issue)}`,
          "Assignees and Project status unchanged.",
        ]
      const target = next.receipt.trace.target
      if (next.receipt.kind === "verified")
        return [
          `Picked up · ${issueKey(target.issue)}`,
          `Assigned to ${target.viewer.login} · In progress verified at readback; not exclusive ownership.`,
        ]
      return [
        `Pickup ${next.receipt.kind} · ${issueKey(target.issue)}`,
        `Assignment ${next.receipt.trace.assignment} · status ${next.receipt.trace.status}`,
        "Reconcile retained effects; do not automatically retry or select another issue.",
      ]
    }
  }
}

const serialize = (value: unknown): string => {
  const result = Either.try({
    try: () => JSON.stringify(value, null, 2),
    catch: () => "Stored details could not be serialized",
  })
  return Either.isLeft(result)
    ? result.left
    : (result.right ?? "No stored value")
}

// Resumed session details are external input; failure keeps the original output visible.
const resultLines = (value: unknown, content: string): readonly string[] => {
  const decoded = Schema.decodeUnknownEither(DetailsSchema)(value)
  if (Either.isLeft(decoded))
    return ["Task result details unreadable; retained output:", content]
  const details = decoded.right
  const names =
    details.outcome.kind === "saved"
      ? [
          ...(details.displayTasks ?? []).map(
            row => `${issueKey(row.issue)} · ${taskLine(row.task)}`,
          ),
          ...((details.displayTasks?.length ?? 0) <
          Math.min(3, details.outcome.result.changed.length)
            ? [
                "Some task names unavailable at the saved revision; inspect receipt.",
              ]
            : []),
        ]
      : []
  return [
    ...outcomeLines(details.outcome),
    ...names,
    ...(decoded.right.output === "unavailable"
      ? ["Detailed model output unavailable; retained receipt is expandable."]
      : []),
  ]
}

export const taskRenderers: Required<
  Pick<IssueTaskTool, "renderCall" | "renderResult">
> = {
  renderCall: (args, theme, context) =>
    new Text(
      theme.fg("toolTitle", safeText(callLines(args).join("\n"))) +
        (context?.expanded ? `\nArguments\n${safeText(serialize(args))}` : ""),
      0,
      0,
    ),
  renderResult: (result, { expanded, isPartial }, theme, context) => {
    const content = result.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
    const summary = safeText(resultLines(result.details, content).join("\n"))
    const details = expanded
      ? `\n\nRetained output\n${safeText(content)}\n\nReceipt\n${safeText(serialize(result.details))}\n\nInvocation: ${safeText(context?.toolCallId ?? "unavailable")}`
      : `\n${context?.keyHint?.("app.tools.expand", "for complete receipt") ?? "Expand for complete receipt"}`
    return new Text(
      theme.fg(
        isPartial ? "muted" : context?.isError ? "error" : "toolOutput",
        summary,
      ) + details,
      0,
      0,
    )
  },
}
