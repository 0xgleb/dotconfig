import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { makeSqliteRegistryStore } from "../agent-registry/sqlite-store.ts"
import { decodeBranchTodoBacklogSnapshot } from "../shared/backlog-events.ts"
import { branchTodoBacklogSnapshot } from "./backlog-adapter.ts"
import type { TodoState } from "./state.ts"

const state: TodoState = {
  nextId: 2,
  todos: [
    {
      id: 1,
      text: "Implement the durable adapter",
      status: "blocked",
      reason: "Waiting for exact evidence",
      replies: ["Preserve the owner correction"],
    },
  ],
}

test("branch todo adapter emits stable canonical provenance with every requirement", () => {
  const first = branchTodoBacklogSnapshot("/repo/a", "session-1", state, 1_000)
  const second = branchTodoBacklogSnapshot("/repo/a", "session-1", state, 2_000)

  assert.equal(first.todos.length, 1)
  assert.equal(first.todos[0]?.canonicalId, second.todos[0]?.canonicalId)
  assert.equal(first.todos[0]?.sourceId, second.todos[0]?.sourceId)
  assert.deepEqual(first.todos[0]?.requirements, [
    "Implement the durable adapter",
    "Owner or agent reply: Preserve the owner correction",
    "Current blocker: Waiting for exact evidence",
  ])
  assert.equal(first.todos[0]?.status, "blocked")
  assert.deepEqual(decodeBranchTodoBacklogSnapshot(first), first)
})

test("branch todo adapter pages large requirement histories without dropping text", () => {
  const replies = Array.from(
    { length: 40 },
    (_, index) => `requirement-${index}`,
  )
  const snapshot = branchTodoBacklogSnapshot(
    "/repo/a",
    "session-1",
    {
      nextId: 2,
      todos: [{ id: 1, text: "Root requirement", status: "pending", replies }],
    },
    1_000,
  )

  assert.equal(snapshot.todos.length, 2)
  assert.equal(snapshot.todos.flatMap(todo => todo.requirements).length, 41)
  assert.equal(new Set(snapshot.todos.map(todo => todo.sourceId)).size, 2)
  assert.ok(
    snapshot.todos.every(
      todo => todo.canonicalId === snapshot.todos[0]?.canonicalId,
    ),
  )
  assert.deepEqual(decodeBranchTodoBacklogSnapshot(snapshot), snapshot)
})

test("repeated page contents have distinct source identities without losing requirements", () => {
  const replies = Array.from({ length: 96 }, () => "same requirement")
  const snapshot = branchTodoBacklogSnapshot(
    "/repo/a",
    "session-1",
    {
      nextId: 2,
      todos: [{ id: 1, text: "Root", status: "pending", replies }],
    },
    1_000,
  )
  assert.equal(snapshot.todos.length, 4)
  assert.equal(new Set(snapshot.todos.map(todo => todo.sourceId)).size, 4)
  assert.deepEqual(
    snapshot.todos.flatMap(todo => todo.requirements),
    ["Root", ...replies.map(reply => `Owner or agent reply: ${reply}`)],
  )
  assert.deepEqual(decodeBranchTodoBacklogSnapshot(snapshot), snapshot)
})

test("Unicode requirement boundaries remain valid through the shared decoder", () => {
  const text = `${"x".repeat(3_999)}🙂`
  const snapshot = branchTodoBacklogSnapshot(
    "/repo/a",
    "session-1",
    {
      nextId: 2,
      todos: [{ id: 1, text, status: "pending" }],
    },
    1_000,
  )
  const requirements = snapshot.todos.flatMap(todo => todo.requirements)
  assert.equal(requirements.join(""), text)
  assert.deepEqual(requirements, ["x".repeat(3_999), "🙂"])
  assert.ok(requirements.every(part => part.length <= 4_000))
  assert.deepEqual(decodeBranchTodoBacklogSnapshot(snapshot), snapshot)
})

test("chunk boundaries preserve whitespace instead of joining separate words", () => {
  const text = `${"x".repeat(3_999)} next`
  const snapshot = branchTodoBacklogSnapshot(
    "/repo/a",
    "session-1",
    {
      nextId: 2,
      todos: [{ id: 1, text, status: "pending" }],
    },
    1_000,
  )
  assert.equal(snapshot.todos.flatMap(todo => todo.requirements).join(""), text)
  assert.deepEqual(decodeBranchTodoBacklogSnapshot(snapshot), snapshot)
})

test("single-page publication preserves the pre-paging producer identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-todo-legacy-pages-"))
  const store = makeSqliteRegistryStore(root)
  const legacy = decodeBranchTodoBacklogSnapshot({
    project: "/repo/a",
    sessionId: "session-1",
    observedAt: 500,
    todos: [
      {
        canonicalId: "session-1:todo-1:bc71832d9573ff08",
        sourceId: "session-1:todo-1:bc71832d9573ff08:snapshot-bc71832d9573ff08",
        requirements: ["Root requirement"],
        status: "pending",
      },
    ],
  })
  assert.ok(legacy)
  try {
    const prior = await Effect.runPromise(store.reconcileBranchTodos(legacy))
    const current = decodeBranchTodoBacklogSnapshot(
      branchTodoBacklogSnapshot(
        "/repo/a",
        "session-1",
        {
          nextId: 2,
          todos: [{ id: 1, text: "Root requirement", status: "pending" }],
        },
        1_000,
      ),
    )
    assert.ok(current)
    assert.equal(current.todos[0]?.canonicalId, legacy.todos[0]?.canonicalId)
    assert.equal(current.todos[0]?.sourceId, legacy.todos[0]?.sourceId)
    const next = await Effect.runPromise(store.reconcileBranchTodos(current))
    assert.equal(next.items.length, 1)
    assert.equal(next.items[0]?.id, prior.items[0]?.id)
    assert.equal(next.sources.length, 1)
    assert.equal(next.requirements.length, 1)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("accepted pages reconcile into one SQLite item with all requirements and lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-todo-pages-"))
  const store = makeSqliteRegistryStore(root)
  const replies = Array.from(
    { length: 40 },
    (_, index) => `requirement-${index}`,
  )
  const initial: TodoState = {
    nextId: 2,
    todos: [{ id: 1, text: "Root", status: "pending", replies }],
  }
  const reconcile = async (state: TodoState, at: number) => {
    const snapshot = decodeBranchTodoBacklogSnapshot(
      branchTodoBacklogSnapshot("/repo/a", "session-1", state, at),
    )
    assert.ok(snapshot)
    return Effect.runPromise(store.reconcileBranchTodos(snapshot))
  }
  try {
    const first = await reconcile(initial, 1_000)
    assert.equal(first.items.length, 1)
    assert.equal(first.sources.length, 2)
    assert.equal(first.requirements.length, 41)
    assert.deepEqual(
      new Set(first.requirements.map(requirement => requirement.text)),
      new Set([
        "Root",
        ...replies.map(reply => `Owner or agent reply: ${reply}`),
      ]),
    )
    assert.ok(
      first.sources.every(source => source.authority.kind === "routing-only"),
    )
    const replay = await reconcile(initial, 2_000)
    assert.equal(replay.items[0]?.id, first.items[0]?.id)
    assert.equal(replay.sources.length, 2)
    assert.equal(replay.requirements.length, 41)
    const blocked = await reconcile(
      {
        ...initial,
        todos: [
          {
            id: 1,
            text: "Root",
            status: "blocked",
            reason: "Waiting for evidence",
            replies,
          },
        ],
      },
      3_000,
    )
    assert.equal(blocked.items.length, 1)
    assert.deepEqual(blocked.items[0]?.state, {
      kind: "blocked",
      reason: "Waiting for evidence",
    })
    const completed = await reconcile(
      {
        ...initial,
        todos: [{ id: 1, text: "Root", status: "completed", replies }],
      },
      4_000,
    )
    assert.equal(completed.items.length, 1)
    assert.equal(completed.items[0]?.id, first.items[0]?.id)
    assert.equal(completed.items[0]?.state.kind, "terminal")
    assert.ok(
      completed.sources.every(
        source => source.authority.kind === "routing-only",
      ),
    )
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
