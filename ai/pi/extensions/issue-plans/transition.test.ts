import assert from "node:assert/strict"
import test from "node:test"
import { Either, Schema } from "effect"
import {
  decodeIssueReference,
  issueKey,
  type IssueReference,
} from "./identity.ts"
import {
  PlanIdSchema,
  TaskIdSchema,
  type IssuePlan,
  type TaskId,
} from "./model.ts"
import { decodeTaskMutationBatch, type TaskMutationBatch } from "./mutations.ts"
import {
  prepareTaskChanges,
  MAX_TRANSITION_NODES,
  type CurrentTask,
  type PlanCandidate,
  type TaskSnapshot,
  type TaskMutationContext,
  type PreparedTaskChanges,
} from "./transition.ts"

const issue = (repository: string): IssueReference => {
  const value = decodeIssueReference({ repository, number: 1 })
  assert.ok(Either.isRight(value))
  return value.right
}
const a = issue("0xgleb/dotconfig")
const b = issue("dataclique/yielduck")
const taskId = (index: number): TaskId => {
  const value = Schema.decodeUnknownEither(TaskIdSchema)(
    `20000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
  )
  assert.ok(Either.isRight(value))
  return value.right
}
const plan = (
  issue: IssueReference,
  index: number,
  revision: number,
): IssuePlan => {
  const value = Schema.decodeUnknownEither(PlanIdSchema)(
    `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
  )
  assert.ok(Either.isRight(value))
  return { id: value.right, issue, revision }
}
const t1 = taskId(1)
const t2 = taskId(2)
const current = (
  issue: IssueReference,
  id: TaskId,
  dependsOn: readonly TaskId[] = [],
): CurrentTask => ({
  issue,
  id,
  text: "Original requirement",
  status: "todo",
  blocker: null,
  dependsOn,
})
const snapshot = (): TaskSnapshot => ({
  plans: [
    { kind: "stored", plan: plan(a, 1, 2) },
    { kind: "stored", plan: plan(b, 2, 7) },
  ],
  tasks: [current(a, t1), current(b, t2)],
  external: [],
})
const existing = (issue: IssueReference, id: TaskId) => ({
  issue,
  task: { kind: "existing", id },
})
const added = (issue: IssueReference, key: string) => ({
  issue,
  task: { kind: "added", key },
})
const batch = (operations: readonly unknown[]): TaskMutationBatch => {
  const value = decodeTaskMutationBatch({ issues: [a, b], operations })
  assert.ok(Either.isRight(value))
  return value.right
}
const context = (
  input: TaskMutationBatch,
  cancellation: TaskMutationContext["cancellation"] = "forbidden",
): TaskMutationContext => ({
  cancellation,
  additions: input.operations.flatMap(operation =>
    operation.op === "add"
      ? [
          {
            issue: operation.issue,
            key: operation.key,
            id: taskId(100 + input.operations.indexOf(operation)),
          },
        ]
      : [],
  ),
})
const success = (
  input: TaskMutationBatch,
  state = snapshot(),
  policy = context(input),
): PreparedTaskChanges => {
  const result = prepareTaskChanges(input, state, policy)
  assert.ok(
    Either.isRight(result),
    Either.isLeft(result) ? result.left.message : undefined,
  )
  return result.right
}
const fails = (
  input: TaskMutationBatch,
  code: string,
  state = snapshot(),
  policy = context(input),
) => {
  const result = prepareTaskChanges(input, state, policy)
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, code)
}

test("a complete multi-issue batch prepares changes and advances each touched plan once", () => {
  const input = batch([
    {
      op: "add",
      issue: a,
      key: "new",
      text: "New requirement",
      dependsOn: [existing(b, t2)],
    },
    { op: "status", target: added(a, "new"), status: "doing" },
    {
      op: "block",
      target: added(a, "new"),
      reason: "External input is missing",
    },
    { op: "edit", target: existing(a, t1), text: "Updated requirement" },
    { op: "status", target: existing(b, t2), status: "done" },
  ])
  const before = snapshot()
  const copy = structuredClone(before)
  const result = success(input, before)
  assert.deepEqual(before, copy)
  assert.equal(result.tasks.length, 3)
  assert.equal(result.events.length, 5)
  assert.deepEqual(
    result.plans.map(candidate => [
      issueKey(candidate.plan.issue),
      candidate.plan.revision,
    ]),
    [
      [issueKey(a), 3],
      [issueKey(b), 8],
    ],
  )
  const created = result.tasks.find(task => task.id === taskId(100))
  assert.ok(created)
  assert.equal(created.status, "doing")
  assert.equal(created.blocker, "External input is missing")
  assert.deepEqual(created.dependsOn, [t2])
  assert.equal(result.changed.length, 3)
})

test("new plan candidates are persisted only when they receive real task changes", () => {
  const input = batch([{ op: "add", issue: a, key: "new", text: "First step" }])
  const newCandidate = (
    issue: IssueReference,
    index: number,
  ): PlanCandidate => ({
    kind: "new",
    plan: { ...plan(issue, index, 0), revision: 0 },
  })
  const result = success(input, {
    plans: [newCandidate(a, 1), newCandidate(b, 2)],
    tasks: [],
    external: [],
  })
  assert.equal(result.plans.length, 1)
  assert.equal(result.plans[0]?.kind, "new")
  assert.equal(result.plans[0]?.plan.revision, 1)
})

test("qualified targets cannot redirect a valid task ID to another issue", () => {
  fails(
    batch([{ op: "status", target: existing(a, t2), status: "doing" }]),
    "scope_mismatch",
  )
})

test("a missing later target rejects the batch without changing its source snapshot", () => {
  const input = batch([
    { op: "add", issue: a, key: "new", text: "Do not partially add" },
    { op: "edit", target: existing(b, taskId(999)), text: "Missing" },
  ])
  const state = snapshot()
  const original = structuredClone(state)
  fails(input, "missing_task", state)
  assert.deepEqual(state, original)
})

test("cancellation and reopening cancelled work require trusted owner authorization", () => {
  const cancel = batch([
    { op: "status", target: existing(a, t1), status: "cancelled" },
  ])
  fails(cancel, "unauthorized")
  assert.equal(
    success(cancel, snapshot(), context(cancel, "owner-authorized")).tasks[0]
      ?.status,
    "cancelled",
  )
  const base = snapshot()
  const cancelled: TaskSnapshot = {
    ...base,
    tasks: base.tasks.map(task =>
      task.id === t1 ? { ...task, status: "cancelled" } : task,
    ),
  }
  const reopen = batch([
    { op: "status", target: existing(a, t1), status: "todo" },
  ])
  fails(reopen, "unauthorized", cancelled)
  assert.equal(
    success(reopen, cancelled, context(reopen, "owner-authorized")).tasks[0]
      ?.status,
    "todo",
  )
})

test("cycle checks include the external dependency closure without mutating it", () => {
  const c = taskId(3)
  const state: TaskSnapshot = {
    plans: snapshot().plans,
    tasks: [current(a, t1), current(b, t2, [c])],
    external: [{ id: c, dependsOn: [t1] }],
  }
  const input = batch([
    { op: "edit", target: existing(a, t1), dependsOn: [existing(b, t2)] },
  ])
  const original = structuredClone(state)
  fails(input, "cycle", state)
  assert.deepEqual(state, original)
})

test("dependency rewrites validate the final atomic graph, not intermediate order", () => {
  const state: TaskSnapshot = {
    ...snapshot(),
    tasks: [current(a, t1, [t2]), current(b, t2)],
  }
  const result = success(
    batch([
      { op: "edit", target: existing(b, t2), dependsOn: [existing(a, t1)] },
      { op: "edit", target: existing(a, t1), dependsOn: [] },
    ]),
    state,
  )
  assert.deepEqual(
    result.events.map(event => event.operationIndex),
    [0, 1],
  )
  assert.deepEqual(result.tasks.find(task => task.id === t1)?.dependsOn, [])
  assert.deepEqual(result.tasks.find(task => task.id === t2)?.dependsOn, [t1])
})

test("no-op batches preserve exhausted revisions but real changes cannot overflow", () => {
  const state: TaskSnapshot = {
    ...snapshot(),
    plans: [
      { kind: "stored", plan: plan(a, 1, Number.MAX_SAFE_INTEGER) },
      { kind: "stored", plan: plan(b, 2, 7) },
    ],
  }
  const result = success(
    batch([
      { op: "status", target: existing(a, t1), status: "todo" },
      {
        op: "edit",
        target: existing(a, t1),
        text: "Original requirement",
        dependsOn: [],
      },
      { op: "block", target: existing(a, t1), reason: null },
    ]),
    state,
  )
  assert.deepEqual(result, { plans: [], tasks: [], events: [], changed: [] })
  fails(
    batch([{ op: "status", target: existing(a, t1), status: "doing" }]),
    "revision_exhausted",
    state,
  )
})

test("malformed projections and ID allocations fail rather than overwrite data", () => {
  const input = batch([
    { op: "status", target: existing(a, t1), status: "doing" },
  ])
  const base = snapshot()
  fails(input, "corrupt_state", {
    ...base,
    tasks: [...base.tasks, current(a, t1)],
  })
  fails(input, "corrupt_state", {
    ...base,
    tasks: [current(a, t1, [taskId(999)]), current(b, t2)],
  })
  const add = batch([
    { op: "add", issue: a, key: "new", text: "Requires generated identity" },
  ])
  fails(add, "invalid_allocation", base, {
    cancellation: "forbidden",
    additions: [],
  })
  const allocation = context(add).additions[0]
  assert.ok(allocation)
  fails(add, "invalid_allocation", base, {
    cancellation: "forbidden",
    additions: [{ ...allocation, id: t2 }],
  })
  fails(input, "invalid_allocation", base, context(add))
})

test("status changes preserve factual blockers and history records only changed fields", () => {
  const base = snapshot()
  const state: TaskSnapshot = {
    ...base,
    tasks: base.tasks.map(task =>
      task.id === t1
        ? { ...task, status: "doing", blocker: "Awaiting external input" }
        : task,
    ),
  }
  const result = success(
    batch([{ op: "status", target: existing(a, t1), status: "done" }]),
    state,
  )
  assert.equal(result.tasks[0]?.blocker, "Awaiting external input")
  assert.deepEqual(result.changed[0]?.fields, ["status"])
  const event = result.events[0]
  assert.ok(event?.op === "status")
  assert.equal(event.before, "doing")
  assert.equal(event.after, "done")
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.tasks))
  assert.ok(Object.isFrozen(result.tasks[0]))
  assert.ok(Object.isFrozen(result.tasks[0]?.dependsOn))
  assert.ok(Object.isFrozen(result.changed[0]?.fields))
})

test("deep dependency components are validated iteratively within explicit bounds", () => {
  const external = Array.from({ length: 5_000 }, (_, index) => ({
    id: taskId(1_000 + index),
    dependsOn: index === 4_999 ? [] : [taskId(1_001 + index)],
  }))
  const state: TaskSnapshot = {
    ...snapshot(),
    tasks: [current(a, t1, [taskId(1_000)]), current(b, t2)],
    external,
  }
  assert.equal(
    success(
      batch([{ op: "edit", target: existing(a, t1), text: "Still bounded" }]),
      state,
    ).events.length,
    1,
  )
  fails(
    batch([{ op: "status", target: existing(a, t1), status: "doing" }]),
    "capacity",
    {
      ...snapshot(),
      external: Array.from({ length: MAX_TRANSITION_NODES }, (_, index) => ({
        id: taskId(10_000 + index),
        dependsOn: [],
      })),
    },
  )
})
