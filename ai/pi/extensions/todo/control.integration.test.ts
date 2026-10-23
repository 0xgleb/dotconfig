import assert from "node:assert/strict"
import test from "node:test"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either, Option } from "effect"
import { fileURLToPath } from "node:url"
import { loadHostExtension } from "../../../test/pi-host-test-support.mjs"
import { requestTodoControl } from "./control.ts"
import { decodeTodoDetails, type TodoRequest } from "./state.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { managerPairDirectory } from "../classified-workflows/manager-session-core.ts"
import { prepareNativeManagerState } from "../classified-workflows/manager-native-state.ts"
import { registerManagerBinding } from "../shared/manager-binding.ts"
import { todoWorkSnapshot } from "../classified-workflows/goal.ts"

interface CapturedTool {
  execute: (
    id: string,
    request: TodoRequest,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<unknown>
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

test("manager control updates the real worker todo store used by subsequent ordinary tool calls", async t => {
  const entries: Record<string, unknown>[] = []
  const hooks = new Map<
    string,
    ((event: unknown, ctx: ExtensionContext) => unknown)[]
  >()
  const listeners = new Map<string, ((data: unknown) => void)[]>()
  let tool: CapturedTool | undefined
  let failAppend = false
  const pi = {
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), handler])
        return () =>
          listeners.set(
            name,
            (listeners.get(name) ?? []).filter(value => value !== handler),
          )
      },
      emit: (name: string, value: unknown) => {
        for (const listener of listeners.get(name) ?? []) listener(value)
      },
    },
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    registerTool: (definition: CapturedTool) => {
      tool = definition
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    appendEntry: (customType: string, data: unknown) => {
      if (failAppend) {
        failAppend = false
        assert.fail("Injected SDK persistence failure")
      }
      entries.push({
        type: "custom",
        id: `e${entries.length + 1}`,
        customType,
        data,
      })
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: "/projects/worker",
    hasUI: false,
    mode: "tui",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "worker", getBranch: () => entries },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  } as unknown as ExtensionContext
  const todoExtension: unknown = await loadHostExtension(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  )
  assert.equal(typeof todoExtension, "function")
  if (typeof todoExtension !== "function")
    assert.fail("Expected the actual todo extension factory")
  todoExtension(pi)
  for (const handler of hooks.get("session_start") ?? []) await handler({}, ctx)
  assert.ok(tool)
  await tool.execute(
    "add",
    { action: "add", text: "Worker task" },
    undefined,
    undefined,
    ctx,
  )
  const updated = requestTodoControl(pi, ctx, {
    action: "status",
    id: 1,
    status: "completed",
  })
  assert.ok(Either.isRight(updated))
  assert.equal(updated.right.isError, false)
  const ranked = requestTodoControl(pi, ctx, {
    action: "priority",
    id: 1,
    priority: 2,
  })
  assert.ok(Either.isRight(ranked))
  assert.equal(ranked.right.isError, false)
  const workerTreeHandlers = [...(hooks.get("session_tree") ?? [])]
  const beforeRead = entries.length
  const listed = await tool.execute(
    "list",
    { action: "list" },
    undefined,
    undefined,
    ctx,
  )
  assert.equal(
    entries.length,
    beforeRead,
    "list must not mutate the task journal",
  )
  for (const handler of hooks.get("session_start") ?? []) await handler({}, ctx)
  assert.equal(
    entries.length,
    beforeRead,
    "unchanged restoration must not mutate the task journal",
  )
  assert.ok(record(listed))
  const details = decodeTodoDetails(listed.details)
  assert.ok(Option.isSome(details))
  assert.equal(details.value.state.todos[0]?.status, "completed")
  assert.equal(details.value.state.todos[0]?.priority, 2)
  await tool.execute(
    "lower-priority-work",
    { action: "add", text: "Unassigned existing work" },
    undefined,
    undefined,
    ctx,
  )

  const root = mkdtempSync(join(tmpdir(), "pi-manager-todo-tool-test-"))
  t.after(() => rmSync(root, { recursive: true }))
  const directory = managerPairDirectory({
    agentDir: root,
    workerCwd: ctx.cwd,
    workerSessionId: "worker",
  })
  assert.ok(Either.isRight(directory))
  const state = prepareNativeManagerState(directory.right, {
    workerSessionId: "worker",
    cwd: ctx.cwd,
  })
  assert.ok(Either.isRight(state))
  state.right.publish({
    version: 1,
    workerSessionId: "worker",
    cwd: ctx.cwd,
    observedAt: Date.now(),
    priorityRevision: "rev",
    data: { todoControl: true, todoPriorityControl: true },
  })
  const managerEntries: Record<string, unknown>[] = []
  let selected = true
  let managerTool: CapturedTool | undefined
  const managerPi = {
    ...pi,
    getFlag: () => undefined,
    registerTool: (definition: CapturedTool) => {
      managerTool = definition
    },
    appendEntry: (customType: string, data: unknown) =>
      managerEntries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI
  const managerCtx = {
    ...ctx,
    cwd: "/global/manager",
    sessionManager: {
      getSessionId: () => "manager",
      getBranch: () => managerEntries,
    },
  } as unknown as ExtensionContext
  registerManagerBinding(pi, id =>
    id === "manager"
      ? selected
        ? { role: "manager", workerSessionId: "worker", workerCwd: ctx.cwd }
        : { role: "manager-unavailable", message: "Select an existing worker." }
      : undefined,
  )
  assert.equal(managerPi.getFlag("manager-worker"), undefined)
  todoExtension(managerPi, {
    agentDir: root,
    timeoutMs: 1000,
    wait: async () => {
      state.right.processPriorities(
        () => "rev",
        () => assert.fail("Wrong queue lane"),
        request => {
          const result = requestTodoControl(pi, ctx, request)
          assert.ok(Either.isRight(result))
          return Either.right(result.right.message)
        },
      )
    },
  })
  assert.ok(managerTool)
  await managerTool.execute(
    "manager-add",
    { action: "add", text: "Added from manager" },
    undefined,
    undefined,
    managerCtx,
  )
  const managerRanked = await managerTool.execute(
    "manager-priority",
    { action: "priority", id: 3, priority: 1 },
    undefined,
    undefined,
    managerCtx,
  )
  assert.ok(record(managerRanked))
  assert.notEqual(managerRanked.isError, true)
  for (const handler of workerTreeHandlers) await handler({}, ctx)
  selected = false
  const unselected = await managerTool.execute(
    "unselected",
    { action: "add", text: "Must not become manager-local work" },
    undefined,
    undefined,
    managerCtx,
  )
  assert.ok(record(unselected))
  assert.equal(unselected.isError, true)
  const finalList = await tool.execute(
    "final-list",
    { action: "list" },
    undefined,
    undefined,
    ctx,
  )
  assert.ok(record(finalList))
  const finalDetails = decodeTodoDetails(finalList.details)
  assert.ok(Option.isSome(finalDetails))
  assert.equal(finalDetails.value.state.todos.length, 3)
  assert.equal(finalDetails.value.state.todos[2]?.text, "Added from manager")
  assert.equal(finalDetails.value.state.todos[2]?.priority, 1)
  assert.equal(finalDetails.value.state.todos[2]?.status, "pending")
  assert.deepEqual(
    todoWorkSnapshot(entries).pending.map(text => text.split(" ")[0]),
    ["#3", "#2"],
  )
  assert.equal(finalDetails.value.state.todos[0]?.priority, 2)
  failAppend = true
  const failedPriority = requestTodoControl(pi, ctx, {
    action: "priority",
    id: 3,
    priority: 5,
  })
  assert.ok(Either.isLeft(failedPriority))
  assert.equal(
    managerEntries.filter(entry => entry.customType === "todo.state").length,
    0,
  )
  failAppend = true
  const failed = requestTodoControl(pi, ctx, {
    action: "add",
    text: "Must not survive failed persistence",
  })
  assert.ok(Either.isLeft(failed))
  const afterFailure = await tool.execute(
    "after-failure",
    { action: "list" },
    undefined,
    undefined,
    ctx,
  )
  assert.ok(record(afterFailure))
  const afterDetails = decodeTodoDetails(afterFailure.details)
  assert.ok(Option.isSome(afterDetails))
  assert.equal(afterDetails.value.state.todos.length, 3)
  assert.equal(afterDetails.value.state.todos[2]?.priority, 1)
  selected = true
  const cleared = await managerTool.execute(
    "clear-manager-priority",
    { action: "priority", id: 3, priority: null },
    undefined,
    undefined,
    managerCtx,
  )
  assert.ok(record(cleared))
  assert.notEqual(cleared.isError, true)
  for (const handler of workerTreeHandlers) await handler({}, ctx)
  const afterClear = await tool.execute(
    "read-back-clear",
    { action: "list" },
    undefined,
    undefined,
    ctx,
  )
  assert.ok(record(afterClear))
  const clearedDetails = decodeTodoDetails(afterClear.details)
  assert.ok(Option.isSome(clearedDetails))
  const { priority: removed, ...unranked } = afterDetails.value.state.todos[2]!
  assert.equal(removed, 1)
  assert.deepEqual(clearedDetails.value.state.todos, [
    ...afterDetails.value.state.todos.slice(0, 2),
    unranked,
  ])
  for (const handler of hooks.get("session_shutdown") ?? [])
    await handler({}, ctx)
})
