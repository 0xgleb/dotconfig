import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import {
  BRANCH_TODO_BACKLOG_EVENT,
  decodeBranchTodoBacklogSnapshot,
} from "../shared/backlog-events.ts"
import { branchTodoBacklogSnapshot } from "./backlog-adapter.ts"
import { fileURLToPath } from "node:url"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either, Option } from "effect"
import { decodeTodoState, type TodoState, type TodoRequest } from "./state.ts"
import { requestTodoControl } from "./control.ts"

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

test("all five persistence paths publish their saved snapshot; reads and failed writes conserve publication", async t => {
  assert.equal(
    [...source.matchAll(/pi\.appendEntry\(TODO_STATE_ENTRY, ([\w.]+)\)/gu)]
      .length,
    5,
    "update runtime path coverage when adding persistence sites",
  )
  const support: unknown = await import(
    new URL("../../../test/pi-host-test-support.mjs", import.meta.url).href
  )
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null
  assert.ok(record(support) && typeof support.loadHostExtension === "function")
  const factory: unknown = await support.loadHostExtension(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  )
  assert.equal(typeof factory, "function")
  if (typeof factory !== "function")
    assert.fail("Expected actual todo extension")
  const entries: Record<string, unknown>[] = []
  const hooks = new Map<
    string,
    ((event: unknown, ctx: ExtensionContext) => unknown)[]
  >()
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const commands = new Map<
    string,
    (args: string, ctx: ExtensionContext) => Promise<void>
  >()
  type Observed =
    | { kind: "persist"; state: TodoState }
    | {
        kind: "publish"
        snapshot: NonNullable<
          ReturnType<typeof decodeBranchTodoBacklogSnapshot>
        >
      }
  const observed: Observed[] = []
  let failAppend = false
  let tool:
    | {
        execute: (
          id: string,
          request: TodoRequest,
          signal: undefined,
          update: undefined,
          ctx: ExtensionContext,
        ) => Promise<unknown>
      }
    | undefined
  let listLines: string[] = []
  let customMode: "unblock" | "list" = "unblock"
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  }
  const pi = {
    events: {
      on: (name: string, callback: (value: unknown) => void) => {
        const callbacks = listeners.get(name) ?? new Set()
        callbacks.add(callback)
        listeners.set(name, callbacks)
        return () => callbacks.delete(callback)
      },
      emit: (name: string, value: unknown) => {
        if (name === BRANCH_TODO_BACKLOG_EVENT) {
          const snapshot = decodeBranchTodoBacklogSnapshot(value)
          assert.ok(snapshot)
          observed.push({ kind: "publish", snapshot })
        }
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
    ) => commands.set(name, definition.handler),
    registerShortcut: () => {},
    appendEntry: (customType: string, data: unknown) => {
      if (failAppend) {
        failAppend = false
        assert.fail("Injected SDK append failure")
      }
      assert.equal(customType, "todo.state")
      const state = decodeTodoState(data)
      assert.ok(Option.isSome(state))
      entries.push({
        type: "custom",
        id: `entry-${entries.length}`,
        customType,
        data,
      })
      observed.push({ kind: "persist", state: state.value })
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: "/projects/publication-test",
    hasUI: false,
    mode: "tui",
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "publication-worker",
      getBranch: () => entries,
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async (_title: string, choices: string[]) => choices[0],
      custom: async (
        build: (
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: () => void,
        ) => unknown,
      ) => {
        if (customMode === "unblock") return "unblock"
        const component = build({}, theme, {}, () => {})
        assert.ok(record(component) && typeof component.render === "function")
        listLines = component.render(120)
      },
    },
  } as unknown as ExtensionContext
  factory(pi)
  const hook = async (name: string) => {
    for (const callback of hooks.get(name) ?? []) await callback({}, ctx)
  }
  t.after(async () => {
    await hook("session_shutdown")
    t.mock.timers.reset()
  })
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] })
  const run = async (request: TodoRequest) => {
    assert.ok(tool)
    await tool.execute("test-call", request, undefined, undefined, ctx)
  }
  const phase = async (
    label: string,
    operation: () => unknown,
    writes = 1,
    publications = writes,
  ) => {
    observed.length = 0
    await operation()
    assert.equal(
      observed.filter(event => event.kind === "persist").length,
      writes,
      label,
    )
    const published = observed.filter(event => event.kind === "publish")
    assert.equal(published.length, publications, label)
    if (writes === 1)
      assert.deepEqual(
        observed.map(event => event.kind),
        ["persist", "publish"],
        label,
      )
    for (const event of published) {
      const saved = decodeTodoState(entries.at(-1)?.data)
      assert.ok(Option.isSome(saved))
      assert.deepEqual(
        event.snapshot,
        branchTodoBacklogSnapshot(
          ctx.cwd,
          "publication-worker",
          saved.value,
          event.snapshot.observedAt,
        ),
        label,
      )
    }
  }
  await phase("restoration", () => hook("session_start"))
  await phase("registered tool", () =>
    run({ action: "add", text: "Delivery unit", effort: 3 }),
  )
  await phase("compaction", () => hook("session_compact"))
  await phase("block setup", () =>
    run({ action: "block", id: 1, reason: "Awaiting decision" }),
  )
  const blocked = commands.get("blocked")
  assert.ok(blocked)
  await phase("UI mutation", () => blocked("", ctx))
  await phase("reminder setup", () =>
    run({
      action: "status",
      id: 1,
      status: "deferred",
      remindAt: new Date(Date.now() + 1000).toISOString(),
    }),
  )
  await phase("reminder wake", () => t.mock.timers.tick(1000))
  await phase("unchanged restoration", () => hook("session_tree"), 0, 1)
  await phase("list", () => run({ action: "list" }), 0)
  failAppend = true
  await phase(
    "failed persistence",
    () => {
      assert.ok(
        Either.isLeft(
          requestTodoControl(pi, ctx, { action: "effort", id: 1, effort: 13 }),
        ),
      )
    },
    0,
  )
  customMode = "list"
  const todos = commands.get("todos")
  assert.ok(todos)
  await phase("native task list", () => todos("", ctx), 0)
  assert.match(listLines.join("\n"), /\[effort 3 points\]/u)
})
