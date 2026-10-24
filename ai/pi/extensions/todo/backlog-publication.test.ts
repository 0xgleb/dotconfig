import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import {
  BRANCH_TODO_BACKLOG_EVENT,
  decodeBranchTodoBacklogSnapshot,
} from "../shared/backlog-events.ts"
import { branchTodoBacklogSnapshot } from "./backlog-adapter.ts"
import type { TodoState } from "./state.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("the actual todo publisher emits a decodable paged snapshot for its context", () => {
  const start = source.indexOf("  const publishBranchTodos =")
  const end = source.indexOf("  const mountTaskWidget =", start)
  assert.ok(start >= 0 && end > start)
  const events: { name: string; value: unknown }[] = []
  const pi = {
    events: {
      emit: (name: string, value: unknown) => {
        events.push({ name, value })
      },
    },
  }
  const publish: (
    ctx: { cwd: string; sessionManager: { getSessionId: () => string } },
    state: TodoState,
  ) => void = new Function(
    "pi",
    "BRANCH_TODO_BACKLOG_EVENT",
    "branchTodoBacklogSnapshot",
    `${stripTypeScriptTypes(source.slice(start, end), { mode: "strip" })}\nreturn publishBranchTodos`,
  )(pi, BRANCH_TODO_BACKLOG_EVENT, branchTodoBacklogSnapshot)
  publish(
    { cwd: "/repo/a", sessionManager: { getSessionId: () => "session-1" } },
    {
      nextId: 2,
      todos: [
        {
          id: 1,
          text: "Root",
          status: "pending",
          replies: Array.from(
            { length: 40 },
            (_, index) => `Requirement ${index}`,
          ),
        },
      ],
    },
  )
  assert.equal(events.length, 1)
  assert.equal(events[0]?.name, BRANCH_TODO_BACKLOG_EVENT)
  const snapshot = decodeBranchTodoBacklogSnapshot(events[0]?.value)
  assert.ok(snapshot)
  assert.equal(snapshot.project, "/repo/a")
  assert.equal(snapshot.sessionId, "session-1")
  assert.equal(snapshot.todos.length, 2)
  assert.equal(new Set(snapshot.todos.map(todo => todo.canonicalId)).size, 1)
  assert.equal(snapshot.todos.flatMap(todo => todo.requirements).length, 41)
})

test("every todo persistence site publishes the same state immediately afterward", () => {
  const calls = [
    ...source.matchAll(/pi\.appendEntry\(TODO_STATE_ENTRY, ([\w.]+)\)/gu),
  ]
  assert.equal(calls.length, 5)
  for (const call of calls) {
    assert.equal(typeof call.index, "number")
    const remainder = source.slice(call.index + call[0].length).trimStart()
    assert.ok(
      remainder.startsWith(`publishBranchTodos(ctx, ${call[1]})`),
      `missing publication after persistence at ${call.index}`,
    )
  }
})
