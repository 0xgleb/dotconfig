import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { getPackageDir } from "@earendil-works/pi-coding-agent"
import { Deferred, Effect, Schema } from "effect"
import {
  createTaskTool,
  type TaskToolOptions,
  type IssueTaskTool,
} from "./tool.ts"
import {
  GitHubInProgressTargetSchema,
  GitHubIssueNodeIdSchema,
  ProjectItemIdSchema,
} from "./github-project-read.ts"
import { GitHubUserSchema } from "./github-user.ts"
import { decodeIssueReference } from "./identity.ts"
import type { IssueNextObservation } from "./next.ts"
import type { IssueNextPicker, IssuePickupTrace } from "./pickup.ts"

const { validateToolArguments } = await import(
  pathToFileURL(
    join(
      getPackageDir(),
      "node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
    ),
  ).href
)
const query = { repository: "0xgleb/dotconfig", project: "personal" }
const observation: IssueNextObservation = {
  selection: { kind: "none", assessments: [] },
  selected: null,
  viewer: Schema.decodeUnknownSync(GitHubUserSchema)({
    id: "viewer-id",
    login: "0xgleb",
  }),
  inProgress: Schema.decodeUnknownSync(GitHubInProgressTargetSchema)({
    projectId: "PVT_kwHOAl_tIc4BpO1U",
    fieldId: "PVTSSF_lAHOAl_tIc4BpO1UzhnrYfs",
    optionId: "47fc9ee4",
  }),
  excludedAssignments: [],
}
const noStore = (): never =>
  assert.fail(
    "next dispatch must not apply or directly read SQLite outside its domain picker",
  )
const options = (picker: IssueNextPicker): TaskToolOptions => ({
  store: {
    apply: noStore,
    readTasks: noStore,
    readTask: noStore,
    readManyTasks: noStore,
  },
  nextPicker: picker,
  contextForCall: call =>
    Effect.succeed({
      actorId: call.sessionId,
      requestId: call.toolCallId,
      now: 1,
      cancellation: "forbidden",
    }),
  renderOutput: outcome => Effect.succeed(JSON.stringify(outcome)),
})
const context = {
  sessionManager: { getSessionId: () => "actual-host-session" },
} as Parameters<IssueTaskTool["execute"]>[4]
const args = (
  tool: IssueTaskTool,
  input: unknown = { action: "next", query },
) =>
  validateToolArguments(tool, {
    type: "toolCall",
    id: "actual-host-call",
    name: "task",
    arguments: input,
  })

test("actual SDK argument dispatch exposes native next and derives invocation from host", async () => {
  const calls: unknown[] = []
  const tool = createTaskTool(
    options({
      next: (input, invocation) =>
        Effect.sync(() => {
          calls.push({ input, invocation })
          return { kind: "none" as const, observation }
        }),
    }),
  )
  const result = await tool.execute(
    "actual-host-call",
    args(tool),
    undefined,
    undefined,
    context,
  )
  assert.equal(result.details.outcome.kind, "issue_next")
  assert.deepEqual(calls, [
    {
      input: query,
      invocation: {
        toolCallId: "actual-host-call",
        sessionId: "actual-host-session",
      },
    },
  ])
  assert.equal(result.isError, false)
})

test("native next rejects fabricated authority before the picker or host write context", async () => {
  let calls = 0
  const tool = createTaskTool(
    options({
      next: () => {
        calls++
        return Effect.succeed({ kind: "none", observation })
      },
    }),
  )
  const result = await tool.execute(
    "actual-host-call",
    {
      action: "next",
      query: { ...query, authorization: "allowed" },
    } as Parameters<IssueTaskTool["execute"]>[1],
    undefined,
    undefined,
    context,
  )
  assert.equal(result.details.outcome.kind, "failed")
  assert.equal(calls, 0)
})

test("next streams source-read progress through the real SDK update callback", async () => {
  const tool = createTaskTool(
    options({
      next: (_input, _invocation, _trace, observe) =>
        Effect.gen(function* () {
          assert.ok(observe)
          yield* observe({ stage: "project", reads: 1 })
          return { kind: "none" as const, observation }
        }),
    }),
  )
  const updates: unknown[] = []
  const result = await tool.execute(
    "actual-host-call",
    args(tool),
    undefined,
    update => {
      updates.push(update)
    },
    context,
  )
  assert.equal(result.details.outcome.kind, "issue_next")
  assert.equal(updates.length, 1)
  assert.match(JSON.stringify(updates), /project/)
})

test("stopping after possible pickup dispatch retains original invocation and effect trace", async () => {
  const entered = Effect.runSync(Deferred.make<void>())
  const issue = decodeIssueReference({
    repository: query.repository,
    number: 179,
  })
  assert.equal(issue._tag, "Right")
  assert.ok(issue._tag === "Right")
  const trace: IssuePickupTrace = {
    target: {
      issue: issue.right,
      viewer: observation.viewer,
      inProgress: observation.inProgress,
      issueNodeId: Schema.decodeUnknownSync(GitHubIssueNodeIdSchema)(
        "issue-id",
      ),
      itemId: Schema.decodeUnknownSync(ProjectItemIdSchema)("item-id"),
    },
    stage: "assignment",
    assignment: "possible",
    status: "not_started",
  }
  const tool = createTaskTool(
    options({
      next: (_input, _invocation, onTrace) =>
        Effect.gen(function* () {
          assert.ok(onTrace)
          onTrace(trace)
          yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        }),
    }),
  )
  const controller = new AbortController()
  const pending = tool.execute(
    "actual-host-call",
    args(tool),
    controller.signal,
    undefined,
    context,
  )
  assert.equal(
    await Promise.race([
      Effect.runPromise(Deferred.await(entered)).then(() => true),
      pending.then(() => false),
    ]),
    true,
  )
  controller.abort()
  const result = await pending
  assert.ok(result.details.outcome.kind === "unconfirmed")
  assert.deepEqual(result.details.outcome.invocation, {
    toolCallId: "actual-host-call",
    sessionId: "actual-host-session",
  })
  assert.deepEqual(result.details.outcome.pickup, trace)
  assert.equal(result.details.outcome.stop, "interrupted")
})
