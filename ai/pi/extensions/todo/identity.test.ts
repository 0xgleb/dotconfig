import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { setImmediate } from "node:timers/promises"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either, Option } from "effect"
import { decodeTodoControl, requestTodoControl } from "./control.ts"
import { registerManagerBinding } from "../shared/manager-binding.ts"
import { BRANCH_TODO_BACKLOG_EVENT } from "../shared/backlog-events.ts"
import { decodeTodoState, type TodoRequest, type TodoState } from "./state.ts"

interface OrderingExample {
  readonly name: string
  readonly request: TodoRequest
  readonly ranks: Readonly<Record<number, number>>
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const fixture = async (
  t: test.TestContext,
  mode: "headless" | "interactive" = "headless",
) => {
  const support: unknown = await import(
    new URL("../../../test/pi-host-test-support.mjs", import.meta.url).href
  )

  assert.ok(record(support) && typeof support.loadHostExtension === "function")

  const factory: unknown = await support.loadHostExtension(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  )

  assert.ok(typeof factory === "function")

  const { getPackageDir } = await import("@earendil-works/pi-coding-agent")
  const validator: unknown = await import(
    pathToFileURL(
      join(
        getPackageDir(),
        "node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
      ),
    ).href
  )

  assert.ok(
    record(validator) && typeof validator.validateToolArguments === "function",
  )

  const validateToolArguments = validator.validateToolArguments

  const entries: Record<string, unknown>[] = []
  const publications: unknown[] = []
  const notifications: string[] = []
  const statuses: (string | undefined)[] = []
  const hooks = new Map<
    string,
    ((event: unknown, ctx: ExtensionContext) => unknown)[]
  >()
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const commands = new Map<
    string,
    (args: string, ctx: ExtensionContext) => Promise<void>
  >()

  let duringUi: (() => void) | undefined
  let failAppend = false
  let failStatus = false
  let appendAttempts = 0
  let tool:
    | {
        readonly name: string
        readonly parameters: unknown
        execute: (
          id: string,
          request: TodoRequest,
          signal: undefined,
          update: undefined,
          ctx: ExtensionContext,
        ) => Promise<unknown>
      }
    | undefined

  const pi = {
    events: {
      on: (name: string, callback: (value: unknown) => void) => {
        const callbacks = listeners.get(name) ?? new Set()
        callbacks.add(callback)
        listeners.set(name, callbacks)

        return () => callbacks.delete(callback)
      },
      emit: (name: string, value: unknown) => {
        if (name === BRANCH_TODO_BACKLOG_EVENT) publications.push(value)

        for (const callback of listeners.get(name) ?? []) callback(value)
      },
    },

    on: (
      name: string,
      callback: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => hooks.set(name, [...(hooks.get(name) ?? []), callback]),

    registerTool: (definition: typeof tool) => {
      tool = definition
    },

    registerCommand: (
      name: string,
      definition: {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>
      },
    ) => {
      commands.set(name, definition.handler)
    },
    registerShortcut: () => {},

    appendEntry: (customType: string, data: unknown) => {
      appendAttempts += 1

      if (failAppend) {
        failAppend = false
        assert.fail("Injected SDK persistence failure")
      }

      entries.push({
        type: "custom",
        customType,
        data,
        id: `entry-${entries.length}`,
      })
    },
  } as unknown as ExtensionAPI

  const ctx = {
    cwd: "/projects/todo-identity-fixture",
    hasUI: mode === "interactive",
    mode: "tui",
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "identity-worker",
      getBranch: () => entries,
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (_key: string, value: string | undefined) => {
        if (failStatus) {
          failStatus = false
          assert.fail("Injected SDK status failure")
        }

        statuses.push(value)
      },
      setWidget: () => {},
      onTerminalInput: () => () => {},
      select: async (_title: string, choices: string[]) => choices[0],
      custom: async () => {
        if (duringUi) {
          const action = duringUi
          duringUi = undefined
          queueMicrotask(() => queueMicrotask(action))
        }

        return "unblock"
      },
    },
  } as unknown as ExtensionContext

  registerManagerBinding(pi, id =>
    id === "identity-worker" ? { role: "worker" } : undefined,
  )
  factory(pi)

  const hook = async (name: string) => {
    for (const callback of hooks.get(name) ?? []) await callback({}, ctx)
  }

  t.after(() => hook("session_shutdown"))

  const run = (request: TodoRequest) => {
    assert.ok(tool)

    return tool.execute("identity-call", request, undefined, undefined, ctx)
  }

  const validate = (request: unknown): unknown => {
    assert.ok(tool)

    return validateToolArguments(tool, {
      type: "toolCall",
      id: "identity-validated-call",
      name: tool.name,
      arguments: request,
    })
  }

  const runValidated = (request: unknown) => {
    const validated = validate(request)
    const decoded = decodeTodoControl(validated)

    assert.ok(Either.isRight(decoded))
    assert.deepEqual(decoded.right, validated)

    return run(decoded.right)
  }

  const control = (request: TodoRequest) => {
    const result = requestTodoControl(pi, ctx, request)

    assert.ok(Either.isRight(result))
    assert.equal(result.right.isError, false, result.right.message)

    return result.right
  }

  const state = async () => {
    const result = await run({ action: "list" })

    assert.ok(record(result) && record(result.details))

    const decoded = decodeTodoState(result.details.state)

    assert.ok(Option.isSome(decoded))

    return decoded.value
  }

  const deliverResult = (result: unknown) => {
    assert.ok(record(result) && record(result.details))

    entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: result.details,
      },
    })
  }

  const unblockUi = () => {
    const blocked = commands.get("blocked")

    assert.ok(blocked)

    return blocked("", ctx)
  }

  return {
    run,
    validate,
    runValidated,
    control,
    state,
    hook,
    deliverResult,
    unblockUi,
    observations: () => ({
      entries: structuredClone(entries),
      publications: structuredClone(publications),
      notifications: [...notifications],
      appendAttempts,
    }),
    status: () => statuses.at(-1),
    failNextAppend: () => {
      failAppend = true
    },
    failNextStatus: () => {
      failStatus = true
    },
    duringUi: (action: () => void) => {
      duringUi = action
    },
    persistRaw: (data: unknown) => {
      entries.push({ type: "custom", customType: "todo.state", data })
    },
  }
}

const rankedBranch = (remindAt: number): TodoState => ({
  nextId: 5,
  todos: [
    {
      id: 1,
      text: "Held parent",
      status: "blocked",
      reason: "Retain hold",
      replies: ["Scope retained"],
      priority: 2,
    },
    {
      id: 2,
      text: "Deferred child",
      parentId: 1,
      status: "deferred",
      remindAt,
      statusChangedAt: 123,
      priority: 8,
    },
    { id: 3, text: "Unranked work", status: "pending" },
    {
      id: 4,
      text: "Historical completion",
      status: "completed",
      priority: Number.MAX_SAFE_INTEGER,
    },
  ],
})

const orderingExamples: ReadonlyArray<OrderingExample> = [
  {
    name: "above",
    request: {
      action: "priority_relative",
      id: 3,
      referenceId: 2,
      position: "above",
    },
    ranks: { 1: 1, 2: 3, 3: 2 },
  },
  {
    name: "below",
    request: {
      action: "priority_relative",
      id: 3,
      referenceId: 2,
      position: "below",
    },
    ranks: { 1: 1, 2: 2, 3: 3 },
  },
  {
    name: "bulk",
    request: { action: "priority_order", ids: [2, 3, 1] },
    ranks: { 1: 3, 2: 1, 3: 2 },
  },
]

for (const example of orderingExamples)
  test(`SDK-validated ${example.name} ordering reaches the real local todo tool`, async t => {
    const worker = await fixture(t)

    worker.persistRaw(rankedBranch(Date.now() + 60_000))
    await worker.hook("session_start")

    worker.control({ action: "effort", id: 3, effort: 3 })

    const before = await worker.state()

    const result = await worker.runValidated(example.request)

    assert.ok(record(result) && record(result.details))
    assert.equal(result.details.outcome, "success")

    const after = await worker.state()

    assert.equal(after.nextId, before.nextId)
    assert.deepEqual(
      after.todos,
      before.todos.map(todo =>
        Object.hasOwn(example.ranks, todo.id)
          ? { ...todo, priority: example.ranks[todo.id] }
          : todo,
      ),
    )
  })

for (const request of [
  { action: "priority_relative", id: 3, referenceId: 0, position: "above" },
  { action: "priority_relative", id: 3, referenceId: 2.5, position: "above" },
  { action: "priority_relative", id: 3, referenceId: 2, position: "sideways" },
  { action: "priority", id: 3, priority: 2.5 },
  { action: "effort", id: 3, effort: 3.5 },
  { action: "add", text: "Reject a fractional parent", parentId: 1.5 },
  { action: "priority_order", ids: [] },
  { action: "priority_order", ids: [1, 1] },
  { action: "priority_order", ids: [1, 2.5] },
  { action: "priority_order", ids: [1, Number.MAX_SAFE_INTEGER + 1] },
])
  test(`the advertised SDK schema rejects malformed ordering ${JSON.stringify(request)}`, async t => {
    const worker = await fixture(t)

    const validation = Either.try(() => worker.validate(request))

    assert.ok(
      Either.isLeft(validation),
      `SDK accepted ${JSON.stringify(validation)}`,
    )
  })

test("legacy tool-result-only branches restore once and continue allocating stable IDs", async t => {
  const original = await fixture(t)
  await original.hook("session_start")
  const legacy = await original.run({
    action: "add",
    text: "Legacy task",
    effort: 3,
  })

  const f = await fixture(t)
  f.deliverResult(legacy)
  await f.hook("session_start")

  assert.deepEqual(await f.state(), await original.state())

  await f.run({ action: "add", text: "New task" })

  assert.equal((await f.state()).todos[1]?.id, 2)
})

test("a malformed authoritative entry fails closed rather than falling back to later valid result details", async t => {
  const f = await fixture(t)
  await f.hook("session_start")
  const delayed = await f.run({ action: "add", text: "Existing task" })

  f.persistRaw({
    nextId: 1,
    todos: [{ id: 1, text: "Invalid allocator", status: "pending" }],
  })
  f.deliverResult(delayed)
  await f.hook("session_tree")

  const result = await f.run({ action: "list" })

  assert.ok(record(result))
  assert.equal(result.isError, true)
  assert.ok(record(result.details))
  assert.equal(result.details.outcome, "unavailable")
  assert.equal(Object.hasOwn(result.details, "state"), false)
})

test("a delayed actual tool result cannot roll back manager-created identity or effort", async t => {
  const f = await fixture(t)
  await f.hook("session_start")
  const delayed = await f.run({ action: "add", text: "First worker task" })

  const created = f.control({ action: "add", text: "Manager task" })

  assert.match(created.message, /#2/u)

  f.control({ action: "effort", id: 2, effort: 8 })

  const committed = await f.state()

  assert.equal(committed.todos[1]?.id, 2)
  assert.equal(committed.todos[1]?.effort, 8)

  f.deliverResult(delayed)
  await f.hook("session_tree")

  assert.deepEqual(await f.state(), committed)

  await f.run({ action: "add", text: "Later worker task" })

  const after = await f.state()

  assert.equal(after.todos[2]?.id, 3)
  assert.equal(after.todos[1]?.text, "Manager task")
  assert.equal(after.todos[1]?.effort, 8)
})

test("branch restoration cannot overwrite a manager mutation admitted during hydration", async t => {
  const f = await fixture(t)
  await f.hook("session_start")
  await f.run({ action: "add", text: "Existing worker task" })

  const restoration = f.hook("session_tree")
  const created = f.control({
    action: "add",
    text: "Concurrent manager task",
    effort: 3,
  })

  assert.match(created.message, /#2/u)

  await restoration

  const after = await f.state()

  assert.equal(after.todos[1]?.text, "Concurrent manager task")
  assert.equal(after.todos[1]?.effort, 3)
  assert.equal(after.nextId, 3)
})

test("a native UI state change and concurrent manager add preserve both mutations", async t => {
  const f = await fixture(t)
  await f.hook("session_start")
  await f.run({ action: "add", text: "Held task", effort: 3 })
  await f.run({ action: "block", id: 1, reason: "Decision" })

  f.duringUi(() => {
    f.control({ action: "add", text: "Concurrent manager task", effort: 8 })
  })
  await f.unblockUi()

  const after = await f.state()

  assert.equal(after.todos[0]?.status, "pending")
  assert.equal(after.todos[0]?.effort, 3)
  assert.equal(after.todos[1]?.text, "Concurrent manager task")
  assert.equal(after.todos[1]?.effort, 8)
  assert.equal(after.nextId, 3)
})

test("failed native UI persistence cannot change the state observed by the next manager request", async t => {
  const f = await fixture(t)
  await f.hook("session_start")
  await f.run({ action: "add", text: "Held task" })
  await f.run({ action: "block", id: 1, reason: "Decision" })

  const before = await f.state()

  f.failNextAppend()
  await assert.rejects(f.unblockUi(), /Injected SDK persistence failure/u)

  assert.deepEqual(await f.state(), before)
  assert.match(f.control({ action: "list" }).message, /Decision/u)
})

test("failed reminder persistence preserves the deferred state and its rank", async t => {
  const f = await fixture(t)
  await f.hook("session_start")
  await f.run({ action: "add", text: "Deferred task", effort: 3 })
  f.control({ action: "priority", id: 1, priority: 2 })
  const due = Date.now() + 60_000
  await f.run({
    action: "status",
    id: 1,
    status: "deferred",
    remindAt: new Date(due).toISOString(),
  })

  const before = await f.state()

  t.mock.method(Date, "now", () => due)
  f.failNextAppend()
  await assert.rejects(
    f.hook("agent_settled"),
    /Injected SDK persistence failure/u,
  )

  assert.deepEqual(await f.state(), before)
})

for (const mode of ["headless", "interactive", "unavailable-status"] as const)
  test(`a scheduled reminder append failure conserves tasks and cannot escape or retry (${mode})`, async t => {
    const now = Date.UTC(2030, 0, 1)

    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now })

    const f = await fixture(t, mode === "headless" ? "headless" : "interactive")

    await f.hook("session_start")
    await f.run({ action: "add", text: "Deferred task", effort: 3 })
    f.control({ action: "priority", id: 1, priority: 2 })
    await f.run({
      action: "status",
      id: 1,
      status: "deferred",
      remindAt: new Date(now + 1000).toISOString(),
    })

    const before = await f.state()
    const observed = f.observations()

    f.failNextAppend()
    if (mode === "unavailable-status") f.failNextStatus()

    t.mock.timers.tick(1000)
    await setImmediate()

    if (mode === "interactive")
      assert.equal(f.status(), "tasks:reminder-blocked")

    assert.deepEqual(f.observations(), {
      ...observed,
      appendAttempts: observed.appendAttempts + 1,
    })

    t.mock.timers.tick(3_600_000)
    await setImmediate()

    assert.deepEqual(await f.state(), before)
    assert.deepEqual(f.observations(), {
      ...observed,
      appendAttempts: observed.appendAttempts + 1,
    })
  })

test("cleared effort stays cleared when an older actual result arrives after the write", async t => {
  const f = await fixture(t)
  await f.hook("session_start")
  const delayed = await f.run({
    action: "add",
    text: "Estimated task",
    effort: 5,
  })

  f.control({ action: "effort", id: 1, effort: null })

  const committed = await f.state()

  assert.equal(committed.todos[0]?.effort, undefined)

  f.deliverResult(delayed)
  await f.hook("session_tree")

  assert.deepEqual(await f.state(), committed)
})
