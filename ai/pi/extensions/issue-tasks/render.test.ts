import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { openSqliteTaskStore } from "./sqlite-store.ts"
import { createIssueNextPicker, type IssuePickupTarget } from "./pickup.ts"
import { GitHubUserSchema } from "./github-user.ts"
import {
  GitHubInProgressTargetSchema,
  GitHubIssueNodeIdSchema,
  ProjectItemIdSchema,
} from "./github-project-read.ts"
import { selectIssueAssignment } from "./selector.ts"
import { Text, visibleWidth } from "@earendil-works/pi-tui"
import { Effect, Either, Option, Schema } from "effect"
import { decodeIssueReference } from "./identity.ts"
import { MutationBatchIdSchema, TaskIdSchema, StatusSchema } from "./model.ts"
import {
  createTaskTool,
  type TaskToolDetails,
  type TaskExecutionOutcome,
} from "./tool.ts"

const decoded = decodeIssueReference({
  repository: "0xgleb/dotconfig",
  number: 228,
})
assert.ok(Either.isRight(decoded))
const issue = decoded.right
const id = Schema.decodeUnknownSync(TaskIdSchema)(
  "10000000-0000-4000-8000-000000000001",
)
const batchId = Schema.decodeUnknownSync(MutationBatchIdSchema)(
  "20000000-0000-4000-8000-000000000001",
)
const task = {
  id,
  text: "Render task names",
  status: Schema.decodeUnknownSync(StatusSchema)({
    _tag: "blocked",
    reason: "Needs terminal verification",
  }),
}
const tool = createTaskTool({
  store: {
    apply: () => Effect.die("Read-only renderer fixture"),
    readTask: () => Effect.succeed(Option.none()),
    readTasks: () => Effect.succeed(Option.none()),
    readManyTasks: () => Effect.succeed([]),
  },
  contextForCall: () => Effect.die("Read-only renderer fixture"),
  renderOutput: outcome => Effect.succeed(JSON.stringify(outcome)),
})
const theme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
}
const render = (
  outcome: TaskExecutionOutcome,
  expanded = false,
  width = 100,
) => {
  assert.ok(tool.renderResult, "Task results need a registered SDK renderer")
  const details: TaskToolDetails = { outcome, output: "complete" }
  const component = tool.renderResult(
    { content: [{ type: "text", text: JSON.stringify(outcome) }], details },
    { expanded, isPartial: false },
    theme as Parameters<NonNullable<typeof tool.renderResult>>[2],
    {
      args: {},
      toolCallId: "render-call",
      keyHint: () => "expand",
    } as Parameters<NonNullable<typeof tool.renderResult>>[3],
  )
  const lines = component.render(width)
  assert.ok(lines.every(line => visibleWidth(line) <= width))
  return lines.join("\n")
}

test("registered task renderer shows task names, status and blockers before receipts", () => {
  const outcome: TaskExecutionOutcome = {
    kind: "page",
    page: { issue, revision: 7, tasks: [task], next: id },
  }
  const text = render(outcome)
  assert.match(text, /0xgleb\/dotconfig#228/)
  assert.match(text, /Render task names/)
  assert.match(text, /blocked/)
  assert.match(text, /Needs terminal verification/)
  assert.match(text, /more/i)
  assert.doesNotMatch(text, /"revision"/)
  assert.doesNotMatch(text, new RegExp(id))
  assert.match(render(outcome, true), new RegExp(id))
  assert.match(render(outcome, true), /"revision": 7/)
})

test("saved local writes keep remote failures and retry warnings visible", () => {
  const outcome: TaskExecutionOutcome = {
    kind: "saved",
    result: {
      kind: "saved",
      receipt: "replayed",
      batchId,
      issues: [{ issue, revision: 8 }],
      changed: [{ issue, id, revision: 8, fields: ["status"] }],
      created: [],
      eventCount: 1,
    },
    projectPlacement: [{ kind: "unknown", issue, project: "personal" }],
  }
  const text = render(outcome)
  assert.match(text, /Saved locally/)
  assert.match(text, /replayed/)
  assert.match(text, /Project.*unknown/)
  assert.match(text, /do not.*(?:repeat|resubmit)/i)
  const expanded = render(outcome, true)
  assert.match(expanded, /Saved locally/)
  assert.match(expanded, new RegExp(batchId))
})

test("unknown and interrupted writes never become success summaries", () => {
  const text = render({
    kind: "unknown",
    batchId,
    requestId: "original-request",
    message: "Commit acknowledgement lost",
  })
  assert.match(text, /unknown/i)
  assert.match(text, /reconcile/i)
  assert.match(text, /do not.*retry/i)
  assert.match(
    render({ kind: "failed", code: "busy", message: "Database locked" }),
    /Database locked/,
  )
  assert.match(render({ kind: "interrupted" }), /interrupted/i)
})

test("task calls identify their action and target without dumping payloads", () => {
  assert.ok(tool.renderCall, "Task calls need a registered SDK renderer")
  const component = tool.renderCall(
    {
      action: "apply",
      issues: [issue],
      operations: [
        { op: "add", issue, key: "renderer", text: "Readable task cards" },
      ],
    },
    theme as Parameters<NonNullable<typeof tool.renderCall>>[1],
    { expanded: false } as Parameters<NonNullable<typeof tool.renderCall>>[2],
  )
  assert.ok(component instanceof Text)
  const text = component.render(80).join("\n")
  assert.match(text, /add/i)
  assert.match(text, /Readable task cards/)
  assert.match(text, /#228/)
  assert.doesNotMatch(text, /"operations"/)
})

test("saved status changes retain names and invocation identity without changing the write receipt", async () => {
  const root = mkdtempSync(
    join(process.cwd(), ".tmp/task-renderer-tests/names-"),
  )
  const store = await Effect.runPromise(
    openSqliteTaskStore({ databasePath: join(root, "tasks.sqlite") }),
  )
  try {
    const liveTool = createTaskTool({
      store,
      contextForCall: call =>
        Effect.succeed({
          actorId: call.sessionId,
          requestId: call.toolCallId,
          now: 1000,
          cancellation: "forbidden",
        }),
      renderOutput: outcome => Effect.succeed(JSON.stringify(outcome)),
    })
    const ctx = {
      sessionManager: { getSessionId: () => "renderer-session" },
    } as Parameters<typeof liveTool.execute>[4]
    const added = await liveTool.execute(
      "add-renderer",
      {
        action: "apply",
        issues: [issue],
        operations: [
          {
            op: "add",
            issue,
            key: "named",
            text: "Explain partial Project effects",
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    )
    assert.equal(added.details.outcome.kind, "saved")
    if (added.details.outcome.kind !== "saved") return
    const created = added.details.outcome.result.created[0]
    assert.ok(created)
    const saved = await liveTool.execute(
      "finish-renderer",
      {
        action: "apply",
        issues: [issue],
        operations: [
          {
            op: "status",
            target: { issue, task: { kind: "existing", id: created.id } },
            status: "done",
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    )
    assert.ok(liveTool.renderResult)
    const paint = (expanded: boolean) =>
      liveTool.renderResult!(
        saved,
        { expanded, isPartial: false },
        theme as Parameters<NonNullable<typeof liveTool.renderResult>>[2],
        { args: {}, toolCallId: "finish-renderer" } as Parameters<
          NonNullable<typeof liveTool.renderResult>
        >[3],
      )
        .render(100)
        .join("\n")
    assert.match(paint(false), /Explain partial Project effects/)
    assert.match(paint(false), /done/)
    assert.match(paint(true), /renderer-session/)
    assert.match(paint(true), /finish-renderer/)
    assert.equal(saved.details.outcome.kind, "saved")
  } finally {
    await Effect.runPromise(store.close())
    rmSync(root, { recursive: true })
  }
})

test("malformed status arguments remain readable before validation", () => {
  const renderer = tool.renderCall
  assert.ok(renderer)
  const component = renderer(
    {
      action: "apply",
      operations: [
        {
          op: "status",
          target: { issue, task: { kind: "existing", id } },
          status: { toString: null },
        },
      ],
    } as Parameters<typeof renderer>[0],
    theme as Parameters<typeof renderer>[1],
    {} as Parameters<typeof renderer>[2],
  )
  assert.match(component.render(100).join("\n"), /incomplete/i)
})

test("compact output bounds long blockers without dropping their availability", () => {
  const outcome: TaskExecutionOutcome = {
    kind: "page",
    page: {
      issue,
      revision: 1,
      tasks: Array.from({ length: 100 }, () => ({
        ...task,
        status: Schema.decodeUnknownSync(StatusSchema)({
          _tag: "blocked",
          reason: "Blocker detail ".repeat(8000),
        }),
      })),
      next: null,
    },
  }
  const compact = render(outcome)
  assert.ok(compact.length < 6000)
  assert.match(compact, /Blocked/)
  assert.match(compact, /expand/i)
  assert.match(
    render(
      {
        kind: "page",
        page: {
          issue,
          revision: 1,
          tasks: [outcome.page.tasks[0]!],
          next: null,
        },
      },
      true,
    ),
    /Blocker detail Blocker detail/,
  )
})

test("real verified pickup receipts render, while missing or mismatched evidence cannot claim success", async () => {
  const viewer = Schema.decodeUnknownSync(GitHubUserSchema)({
    id: "viewer-id",
    login: "0xgleb",
  })
  const target: IssuePickupTarget = {
    issue,
    viewer,
    issueNodeId: Schema.decodeUnknownSync(GitHubIssueNodeIdSchema)(
      "issue-node",
    ),
    itemId: Schema.decodeUnknownSync(ProjectItemIdSchema)("project-item"),
    inProgress: Schema.decodeUnknownSync(GitHubInProgressTargetSchema)({
      projectId: "project-id",
      fieldId: "status-field",
      optionId: "progress-option",
    }),
  }
  const selection = Effect.runSync(
    selectIssueAssignment({
      scope: [issue],
      coverage: "complete",
      candidates: [
        {
          issue,
          state: "open",
          priority: { kind: "number", value: 1 },
          effort: { kind: "number", value: 1 },
          eligibility: { blockers: "clear", dependencies: "clear" },
        },
      ],
    }),
  )
  const result = await Effect.runPromise(
    createIssueNextPicker({
      reader: {
        read: () =>
          Effect.succeed({
            selection,
            viewer,
            inProgress: target.inProgress,
            excludedAssignments: [],
            selected: {
              kind: "issue",
              issue,
              itemId: target.itemId,
              issueNodeId: target.issueNodeId,
              assignees: [viewer],
              status: target.inProgress.optionId,
              state: "open",
              priority: { kind: "number", value: 1 },
              effort: { kind: "number", value: 1 },
            },
          }),
      },
      pickup: {
        inspect: () =>
          Effect.succeed({
            viewer,
            issue,
            issueNodeId: target.issueNodeId,
            itemId: target.itemId,
            projectId: target.inProgress.projectId,
            state: "open",
            archived: false,
            assignees: [viewer],
            status: {
              fieldId: target.inProgress.fieldId,
              optionId: target.inProgress.optionId,
            },
          }),
        assignOwner: () => Effect.die("Already assigned"),
        setInProgress: () => Effect.die("Already in progress"),
      },
    }).next({}, { sessionId: "fixture-session", toolCallId: "fixture-pickup" }),
  )
  const valid = { kind: "issue_next", result } as const
  assert.match(render(valid), /In progress verified/)
  const malformed = JSON.parse(JSON.stringify(valid))
  malformed.result.observation.selected = null
  delete malformed.result.receipt.observed
  const text = render(malformed)
  assert.match(text, /unreadable/i)
  assert.doesNotMatch(text, /Picked up|In progress verified/)
  const stale = JSON.parse(JSON.stringify(valid))
  stale.result.receipt.observed.status.optionId = "other-status"
  assert.match(render(stale), /unreadable/i)
})

test("renderer escapes terminal controls and wraps long Unicode task names", () => {
  const outcome: TaskExecutionOutcome = {
    kind: "page",
    page: {
      issue,
      revision: 1,
      tasks: [{ ...task, text: "界🦆".repeat(40) + "\u001b[2J" }],
      next: null,
    },
  }
  assert.doesNotMatch(render(outcome, false, 24), /\u001b\[2J/)
  render(outcome, true, 24)
})
