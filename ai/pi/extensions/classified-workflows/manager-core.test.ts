import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import {
  MANAGER_CHAT_ENTRY,
  MANAGER_PRIORITY_ENTRY,
  MANAGER_SUMMARY_ENTRY,
  managerObservation,
  managerSummaryExists,
  orderManagerTasks,
  parseManagerPriorities,
  readManagerPriorities,
  readManagerTasks,
  readManagerTurns,
} from "./manager-core.ts"
import type { Todo } from "../todo/state.ts"
import { todoWorkSnapshot, taskContinuationMessage } from "./goal.ts"

const tasks: Todo[] = [
  { id: 1, text: "First existing task", status: "pending" },
  { id: 2, text: "New current priority", status: "in_progress" },
  { id: 3, text: "Paused task", status: "blocked", reason: "Explicit pause" },
  { id: 4, text: "Later task", status: "deferred" },
]
const entries = [
  {
    type: "custom",
    customType: "todo.state",
    data: { todos: tasks, nextId: 5 },
  },
]

test("manager observes current task state, not raw tool output", () => {
  const restored = readManagerTasks([
    ...entries,
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        content: "PRIVATE_RAW_OUTPUT",
      },
    },
  ])
  assert.ok(Either.isRight(restored))
  assert.deepEqual(restored.right, tasks)
  assert.ok(
    !JSON.stringify(managerObservation(restored.right)).includes(
      "PRIVATE_RAW_OUTPUT",
    ),
  )
})

test("explicit priority selection is bounded, unique and references runnable tasks", () => {
  const chosen = parseManagerPriorities("2 1", tasks)
  assert.ok(Either.isRight(chosen))
  assert.deepEqual(chosen.right, { version: 1, ids: [2, 1] })
  for (const bad of [
    "2 2",
    "999",
    "3",
    "4",
    "1; run something",
    "0",
    "-1",
    "1.2",
  ])
    assert.ok(Either.isLeft(parseManagerPriorities(bad, tasks)), bad)
})

test("missing priorities preserve existing order; malformed stored priorities are explicit errors", () => {
  assert.deepEqual(readManagerPriorities(entries), Either.right(undefined))
  assert.ok(
    Either.isLeft(
      readManagerPriorities([
        ...entries,
        {
          type: "custom",
          customType: MANAGER_PRIORITY_ENTRY,
          data: { version: 1, ids: [2, 2] },
        },
      ]),
    ),
  )
  assert.ok(
    Either.isLeft(
      readManagerTasks([
        {
          type: "custom",
          customType: "todo.state",
          data: { todos: "malformed" },
        },
      ]),
    ),
  )
})

test("manager priority order reaches the existing continuation without unpausing anything", () => {
  const prioritized = [
    ...entries,
    {
      type: "custom",
      customType: MANAGER_PRIORITY_ENTRY,
      data: { version: 1, ids: [1, 2] },
    },
  ]
  assert.deepEqual(
    orderManagerTasks(tasks, { version: 1, ids: [2, 1] }).map(task => task.id),
    [2, 1, 3, 4],
  )
  const pending = todoWorkSnapshot(prioritized).pending
  assert.ok(pending[0]?.startsWith("#1 "))
  assert.ok(pending[1]?.startsWith("#2 "))
  const continuation = taskContinuationMessage(todoWorkSnapshot(prioritized))
  assert.ok(continuation?.includes("#1 First existing task"))
  assert.ok(
    !pending.some(item => item.startsWith("#3 ") || item.startsWith("#4 ")),
  )
  assert.equal(tasks[2]?.status, "blocked")
})

test("manager dialogue is separate session data, not worker instructions", () => {
  const chat = [
    ...entries,
    {
      type: "custom",
      customType: MANAGER_CHAT_ENTRY,
      data: {
        version: 1,
        turns: [
          {
            question: "Maybe change priority?",
            answer: "Discuss first; do not execute.",
          },
        ],
      },
    },
  ]
  const restored = readManagerTurns(chat)
  assert.ok(Either.isRight(restored))
  assert.equal(restored.right[0]?.question, "Maybe change priority?")
  assert.deepEqual(todoWorkSnapshot(chat), todoWorkSnapshot(entries))
  assert.ok(
    Either.isLeft(
      readManagerTurns([
        {
          type: "custom",
          customType: MANAGER_CHAT_ENTRY,
          data: { version: 1, turns: [{ question: 42, answer: "bad" }] },
        },
      ]),
    ),
  )
})

test("summary reservation survives restoration and prevents automatic replay", () => {
  const reserved = [
    ...entries,
    {
      type: "custom",
      customType: MANAGER_SUMMARY_ENTRY,
      data: { version: 1, round: 123, status: "started" },
    },
  ]
  assert.deepEqual(managerSummaryExists(reserved, 123), Either.right(true))
  assert.deepEqual(managerSummaryExists(reserved, 124), Either.right(false))
  assert.ok(
    Either.isLeft(
      managerSummaryExists(
        [
          {
            type: "custom",
            customType: MANAGER_SUMMARY_ENTRY,
            data: { version: 1, round: 123, status: {} },
          },
        ],
        123,
      ),
    ),
  )
})
