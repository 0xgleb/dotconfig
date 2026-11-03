import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import os, { tmpdir } from "node:os"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import { registerWorkManager, type ManagerModel } from "./manager.ts"
import { createOwnerAllowance, OWNER_ALLOWANCE_MS } from "./owner-allowance.ts"
import type { NativeManagerRuntime } from "./manager-native.ts"
import { readManagerPriorities } from "./manager-core.ts"
import { fileURLToPath } from "node:url"
import { loadHostExtension } from "../../../test/pi-host-test-support.mjs"
import { invokeManagerTodo } from "./manager-client.ts"
import { managerPairDirectory } from "./manager-session-core.ts"
import { openNativeManagerState } from "./manager-native-state.ts"
import { todoWorkSnapshot } from "./goal.ts"

const fixture = (t: test.TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "pi-manager-pair-test-"))
  t.after(() => rmSync(root, { recursive: true }))
  t.mock.method(os, "homedir", () => root)
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const actor = (manager: boolean) => {
    let now = 1000
    let deadline: (() => void) | undefined
    const ticks: (() => void)[] = []
    const entries: Record<string, unknown>[] = manager
      ? []
      : [
          {
            type: "custom",
            id: "e1",
            customType: "todo.state",
            data: {
              todos: [
                { id: 1, text: "First", status: "pending" },
                { id: 2, text: "Second", status: "pending" },
                { id: 3, text: "Later", status: "deferred" },
              ],
              nextId: 4,
            },
          },
        ]
    const hooks = new Map<
      string,
      ((event: unknown, ctx: ExtensionContext) => unknown)[]
    >()
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    >()
    const messages: { content: unknown; options: unknown }[] = []
    const modelCalls: string[] = []
    const executions: string[][] = []
    const notices: string[] = []
    const listeners = new Map<string, ((value: unknown) => void)[]>()
    const tools = new Map<
      string,
      {
        execute: (
          id: string,
          request: Record<string, unknown>,
          signal: undefined,
          update: undefined,
          ctx: ExtensionContext,
        ) => unknown
      }
    >()
    const pi = {
      events: {
        on: (name: string, callback: (value: unknown) => void) => {
          listeners.set(name, [...(listeners.get(name) ?? []), callback])
          return () =>
            listeners.set(
              name,
              (listeners.get(name) ?? []).filter(value => value !== callback),
            )
        },
        emit: (name: string, value: unknown) => {
          for (const callback of listeners.get(name) ?? []) callback(value)
        },
      },
      registerFlag: () => {},
      getFlag: (name: string) =>
        manager && name === "manager-worker" ? "worker-pair" : undefined,
      setActiveTools: () => {},
      on: (
        name: string,
        callback: (event: unknown, ctx: ExtensionContext) => unknown,
      ) => hooks.set(name, [...(hooks.get(name) ?? []), callback]),
      registerEntryRenderer: () => {},
      registerCommand: (
        name: string,
        command: {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>
        },
      ) => commands.set(name, command),
      appendEntry: (customType: string, data: unknown) =>
        entries.push({
          type: "custom",
          id: `e${entries.length + 1}`,
          customType,
          data,
        }),
      sendMessage: (message: { content: unknown }, options: unknown) => {
        messages.push({ content: message.content, options })
        entries.push({
          type: "message",
          id: `e${entries.length + 1}`,
          message: { ...message, role: "custom" },
        })
      },
      sendUserMessage: () => assert.fail("manager started a worker round"),
      registerTool: (tool: {
        name: string
        execute: (
          id: string,
          request: Record<string, unknown>,
          signal: undefined,
          update: undefined,
          ctx: ExtensionContext,
        ) => unknown
      }) => {
        assert.ok(
          tool.name === "manager_control" || (!manager && tool.name === "todo"),
          "only owner-loaded management/worker todo tools may register",
        )
        tools.set(tool.name, tool)
      },
      registerShortcut: () => {},
      exec: async (_command: string, args: string[]) => {
        executions.push(args)
        return { code: 0, stdout: "[]", stderr: "" }
      },
    } as unknown as ExtensionAPI
    const ctx = {
      mode: "tui",
      cwd: "/projects/worker",
      model: { provider: "openai-codex", id: "gpt-6.1-sol" },
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => (manager ? "manager-pair" : "worker-pair"),
        getBranch: () => entries,
      },
      ui: {
        notify: (text: string) => notices.push(text),
        setWidget: () => {},
        setStatus: () => {},
        custom: () => assert.fail("custom chat frontend used"),
      },
    } as unknown as ExtensionContext
    let work: ReturnType<typeof registerWorkManager>
    const guard = createOwnerAllowance({
      now: () => now,
      schedule: callback => {
        deadline = callback
        return callback
      },
      clear: () => {},
      persist: () => {},
      cancel: () => {},
      onExpired: window => work.expire(window),
    })
    guard.ownerInput(now)
    const runtime: NativeManagerRuntime = {
      agentDir: root,
      piExecutable: join(root, "bin", "pi"),
      schedule: callback => {
        ticks.push(callback)
        return () => {}
      },
    }
    const model: ManagerModel = async (_ctx, request) => {
      modelCalls.push(request.kind)
      return Either.right("## Finished\n\n- Recorded outcome")
    }
    work = registerWorkManager(pi, guard, model, undefined, runtime)
    const emit = async (name: string, event: unknown = {}) => {
      for (const callback of hooks.get(name) ?? []) await callback(event, ctx)
    }
    const command = async (text: string) => {
      const registered = commands.get("manager")
      assert.ok(registered)
      await registered.handler(text, ctx)
    }
    return {
      pi,
      ctx,
      root,
      tools,
      entries,
      guard,
      modelCalls,
      executions,
      messages,
      notices,
      emit,
      command,
      tick: () => {
        for (const tick of ticks) tick()
      },
      expire: () => {
        now += OWNER_ALLOWANCE_MS
        deadline?.()
      },
    }
  }
  return { worker: actor(false), manager: actor(true) }
}

test("default /manager launches native Pi; owner priorities reach actual continuation state without renewing the worker", async t => {
  const f = fixture(t)
  await f.worker.emit("session_start")
  const allowance = f.worker.guard.admit()
  await f.worker.command("")
  assert.equal(f.worker.executions.length, 2)
  await f.manager.emit("session_start")
  await f.manager.command("priorities 2 1")
  f.worker.tick()
  f.manager.tick()
  const priorities = readManagerPriorities(f.worker.entries)
  assert.ok(Either.isRight(priorities))
  assert.deepEqual(priorities.right?.ids, [2, 1])
  assert.deepEqual(f.worker.guard.admit(), allowance)
  assert.deepEqual(f.worker.modelCalls, [])
  assert.equal(f.manager.messages.length, 1)
})

test("actual todo registration publishes priority capability and a manager correction preserves the allowance and round", async t => {
  const f = fixture(t)
  const extension: unknown = await loadHostExtension(
    fileURLToPath(new URL("../todo/index.ts", import.meta.url)),
  )
  if (typeof extension !== "function")
    return assert.fail("actual todo factory unavailable")
  extension(f.worker.pi)
  await f.worker.emit("session_start")
  // A restored, unchanged backlog must be usable without a repair poll.
  await f.manager.emit("session_start")
  const directory = managerPairDirectory({
    workerSessionId: "worker-pair",
    workerCwd: f.worker.ctx.cwd,
    agentDir: f.worker.root,
  })
  assert.ok(Either.isRight(directory))
  const state = openNativeManagerState(directory.right, {
    workerSessionId: "worker-pair",
    cwd: f.worker.ctx.cwd,
  })
  assert.ok(Either.isRight(state))
  const observed = state.right.context()
  assert.ok(Either.isRight(observed))
  assert.equal(observed.right.data.todoPriorityControl, true)
  assert.match(
    observed.right.priorityRevision,
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/,
  )
  assert.ok(observed.right.priorityRevision.length <= 80)
  const allowance = f.worker.guard.admit()
  const result = await invokeManagerTodo(
    f.manager.pi,
    f.manager.ctx,
    { action: "priority", id: 2, priority: 1 },
    undefined,
    {
      agentDir: f.worker.root,
      timeoutMs: 1000,
      wait: async () => f.worker.tick(),
    },
  )
  assert.equal(
    result.details.outcome,
    "completed",
    result.content.map(part => part.text).join("\n"),
  )
  assert.deepEqual(
    todoWorkSnapshot(f.worker.entries).pending.map(text => text.split(" ")[0]),
    ["#2", "#1"],
  )
  assert.deepEqual(f.worker.guard.admit(), allowance)
  assert.deepEqual(f.worker.modelCalls, [])
  await f.worker.emit("session_shutdown", { reason: "reload" })
})

test("task-state changes fence already queued manager control instead of applying to a stale backlog", async t => {
  const f = fixture(t)
  await f.worker.emit("session_start")
  await f.worker.command("")
  await f.manager.emit("session_start")
  await f.manager.command("priorities 2 1")
  f.worker.entries.push({
    type: "custom",
    id: "replacement-todos",
    customType: "todo.state",
    data: {
      todos: [
        { id: 1, text: "Different work after clearing", status: "pending" },
        { id: 2, text: "Another replacement", status: "pending" },
      ],
      nextId: 3,
    },
  })
  f.worker.tick()
  const priorities = readManagerPriorities(f.worker.entries)
  assert.ok(Either.isRight(priorities))
  assert.equal(priorities.right, undefined)
})

test("native priority relay preserves deferred status and reports the actual rejection", async t => {
  const f = fixture(t)
  await f.worker.emit("session_start")
  await f.worker.command("")
  await f.manager.emit("session_start")
  await f.manager.command("priorities 3")
  f.worker.tick()
  f.manager.tick()
  const priorities = readManagerPriorities(f.worker.entries)
  assert.ok(Either.isRight(priorities))
  assert.equal(priorities.right, undefined)
  assert.equal(f.manager.messages.length, 1)
  assert.match(
    String(f.manager.messages[0]?.content),
    /runnable|deferred|pending|in_progress/u,
  )
})

test("manager chat's own allowance expiry cannot create a worker summary or false scope error", async t => {
  const f = fixture(t)
  await f.worker.emit("session_start")
  await f.worker.command("")
  await f.manager.emit("session_start")
  await f.manager.command("priorities 2 1")
  f.manager.expire()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.manager.modelCalls, [])
  assert.ok(
    !f.manager.notices.some(message => /Summary request/u.test(message)),
  )
})

test("one real worker expiry reaches native manager as Markdown without another worker round", async t => {
  const f = fixture(t)
  await f.worker.emit("session_start")
  await f.worker.command("")
  await f.manager.emit("session_start")
  f.worker.expire()
  await new Promise(resolve => setImmediate(resolve))
  f.worker.tick()
  f.manager.tick()
  f.manager.tick()
  assert.deepEqual(f.worker.modelCalls, ["summary"])
  assert.equal(f.manager.messages.length, 1)
  assert.match(String(f.manager.messages[0]?.content), /## Finished/u)
  assert.ok(Either.isLeft(f.worker.guard.admit()))
})
