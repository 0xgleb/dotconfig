import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import { registerWorkManager, type ManagerModel } from "./manager.ts"
import { createOwnerAllowance, OWNER_ALLOWANCE_MS } from "./owner-allowance.ts"
import type { NativeManagerRuntime } from "./manager-native.ts"
import { readManagerPriorities } from "./manager-core.ts"
import { invokeManagerTodo } from "./manager-client.ts"
import { managerPairDirectory } from "./manager-session-core.ts"
import { openNativeManagerState } from "./manager-native-state.ts"
import { todoWorkSnapshot } from "./goal.ts"

type CapturedHook = (event: unknown, ctx: ExtensionContext) => unknown
type CapturedCommand = (args: string, ctx: ExtensionContext) => Promise<void>

const fixture = (t: test.TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "pi-manager-pair-test-"))
  t.after(() => rmSync(root, { recursive: true }))

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
    const hooks = new Map<string, CapturedHook[]>()
    const commands = new Map<string, CapturedCommand>()
    const messages: { content: unknown; options: unknown }[] = []
    const modelCalls: string[] = []
    const executions: string[][] = []
    const notices: string[] = []
    const listeners = new Map<string, ((value: unknown) => void)[]>()
    const tools = new Map<
      string,
      Pick<Parameters<ExtensionAPI["registerTool"]>[0], "name" | "execute">
    >()

    const on: ExtensionAPI["on"] = (name, callback) => {
      // Tests emit only captured lifecycle hooks with a projected base context.
      const captured = callback as unknown as CapturedHook
      hooks.set(name, [...(hooks.get(name) ?? []), captured])

      return () => {
        hooks.set(
          name,
          (hooks.get(name) ?? []).filter(handler => handler !== captured),
        )
      }
    }

    const pi = {
      events: {
        on: (name: string, callback: (value: unknown) => void) => {
          listeners.set(name, [...(listeners.get(name) ?? []), callback])

          return () => {
            listeners.set(
              name,
              (listeners.get(name) ?? []).filter(value => value !== callback),
            )
          }
        },
        emit: (name: string, value: unknown) => {
          for (const callback of listeners.get(name) ?? []) callback(value)
        },
      },
      registerFlag: () => {},
      getFlag: name =>
        manager && name === "manager-worker" ? "worker-pair" : undefined,
      setActiveTools: () => {},
      on,
      registerEntryRenderer: () => {},
      registerCommand: (name, command) => {
        // These commands exercise only the base extension-context projection.
        commands.set(name, command.handler as CapturedCommand)
      },
      appendEntry: (customType, data) => {
        entries.push({
          type: "custom",
          id: `e${entries.length + 1}`,
          customType,
          data,
        })
      },
      sendMessage: (message, options) => {
        messages.push({ content: message.content, options })
        entries.push({
          type: "message",
          id: `e${entries.length + 1}`,
          message: { ...message, role: "custom" },
        })
      },
      sendUserMessage: () => assert.fail("manager started a worker round"),
      registerTool: tool => {
        assert.ok(
          tool.name === "manager_control" || (!manager && tool.name === "todo"),
          "only owner-loaded management/worker todo tools may register",
        )
        tools.set(tool.name, tool)
      },
      registerShortcut: () => {},
      exec: async (_command, args) => {
        executions.push(args)

        return { code: 0, stdout: "[]", stderr: "", killed: false }
      },
    } satisfies Pick<
      ExtensionAPI,
      | "events"
      | "registerFlag"
      | "getFlag"
      | "setActiveTools"
      | "on"
      | "registerEntryRenderer"
      | "registerCommand"
      | "appendEntry"
      | "sendMessage"
      | "sendUserMessage"
      | "registerTool"
      | "registerShortcut"
      | "exec"
    >
    const ui = {
      notify: text => {
        notices.push(text)
      },
      setWidget: () => {},
      setStatus: () => {},
      custom: () => assert.fail("custom chat frontend used"),
    } satisfies Pick<
      ExtensionUIContext,
      "notify" | "setWidget" | "setStatus" | "custom"
    >
    const sessionManager = {
      getSessionId: () => (manager ? "manager-pair" : "worker-pair"),
      // Session hydration consumes these entry projections, not full SDK records.
      getBranch: () =>
        entries as unknown as ReturnType<
          ExtensionContext["sessionManager"]["getBranch"]
        >,
    } satisfies Pick<
      ExtensionContext["sessionManager"],
      "getSessionId" | "getBranch"
    >

    // Only the checked host surfaces and model identity are used by this fixture.
    const partialHost: Partial<ExtensionAPI> = pi
    const host = partialHost as ExtensionAPI
    const partialUi: Partial<ExtensionUIContext> = ui
    const modelIdentity: Partial<NonNullable<ExtensionContext["model"]>> = {
      provider: "openai-codex",
      id: "gpt-6.1-sol",
    }
    const context = {
      mode: "tui",
      hasUI: false,
      cwd: "/projects/worker",
      model: modelIdentity as NonNullable<ExtensionContext["model"]>,
      isIdle: () => true,
      sessionManager: sessionManager as ExtensionContext["sessionManager"],
      ui: partialUi as ExtensionUIContext,
    } satisfies Partial<ExtensionContext>
    const ctx = context as ExtensionContext

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
    work = registerWorkManager(host, guard, model, undefined, runtime)

    const emit = async (name: string, event: unknown = {}) => {
      for (const callback of hooks.get(name) ?? []) await callback(event, ctx)
    }
    const command = async (text: string) => {
      const registered = commands.get("manager")
      assert.ok(registered)

      await registered(text, ctx)
    }

    return {
      pi: host,
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

test("default /manager launches native Pi but retired priorities cannot change continuation state or renew the worker", async t => {
  const f = fixture(t)
  await f.worker.emit("session_start")
  const allowance = f.worker.guard.admit()
  const before = structuredClone(f.worker.entries)

  await f.worker.command("")

  assert.equal(f.worker.executions.length, 2)

  await f.manager.emit("session_start")
  await f.manager.command("priorities 2 1")
  f.worker.tick()
  f.manager.tick()

  const priorities = readManagerPriorities(f.worker.entries)

  assert.ok(Either.isRight(priorities))
  assert.equal(priorities.right, undefined)
  assert.deepEqual(f.worker.entries, before)
  assert.deepEqual(f.worker.guard.admit(), allowance)
  assert.deepEqual(f.worker.modelCalls, [])
  assert.equal(f.manager.messages.length, 0)
  assert.ok(f.manager.notices.some(message => /retired/u.test(message)))
})

test("actual todo registration publishes priority capability while retired manager changes fail closed", async t => {
  const f = fixture(t)
  const support: unknown = await import(
    new URL("../../../test/pi-host-test-support.mjs", import.meta.url).href
  )

  assert.ok(
    typeof support === "object" &&
      support !== null &&
      "loadHostExtension" in support &&
      typeof support.loadHostExtension === "function",
  )

  const extension: unknown = await support.loadHostExtension(
    fileURLToPath(new URL("../todo/index.ts", import.meta.url)),
  )

  assert.ok(typeof extension === "function", "actual todo factory unavailable")

  extension(f.worker.pi)
  await f.worker.emit("session_start")
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
  const before = structuredClone(f.worker.entries)
  const requestsBefore = readdirSync(join(directory.right, "requests"))

  const result = await invokeManagerTodo(
    f.manager.pi,
    f.manager.ctx,
    { action: "priority", id: 2, priority: 1 },
    undefined,
    {
      agentDir: f.worker.root,
      timeoutMs: 1000,
      wait: async () => assert.fail("Retired manager requests must not poll"),
    },
  )

  assert.equal(result.isError, true)
  assert.deepEqual(result.details, { outcome: "unavailable" })
  assert.match(
    result.content.map(part => part.text).join("\n"),
    /Queued manager calls are retired/u,
  )
  assert.deepEqual(f.worker.entries, before)
  assert.deepEqual(
    readdirSync(join(directory.right, "requests")),
    requestsBefore,
  )
  assert.deepEqual(
    todoWorkSnapshot(f.worker.entries).pending.map(text => text.split(" ")[0]),
    ["#1", "#2"],
  )
  assert.deepEqual(f.worker.guard.admit(), allowance)
  assert.deepEqual(f.worker.modelCalls, [])

  await f.worker.emit("session_shutdown", { reason: "reload" })
})

test("task-state replacements survive rejected native manager control", async t => {
  const f = fixture(t)
  await f.worker.emit("session_start")
  await f.worker.command("")
  await f.manager.emit("session_start")
  await f.manager.command("priorities 2 1")

  const replacement = {
    todos: [
      { id: 1, text: "Different work after clearing", status: "pending" },
      { id: 2, text: "Another replacement", status: "pending" },
    ],
    nextId: 3,
  }
  f.worker.entries.push({
    type: "custom",
    id: "replacement-todos",
    customType: "todo.state",
    data: replacement,
  })
  f.worker.tick()

  const priorities = readManagerPriorities(f.worker.entries)

  assert.ok(Either.isRight(priorities))
  assert.equal(priorities.right, undefined)
  assert.deepEqual(f.worker.entries.at(-1)?.data, replacement)
  assert.ok(f.manager.notices.some(message => /retired/u.test(message)))
})

test("retired native priority relay preserves deferred state without a completion message", async t => {
  const f = fixture(t)
  await f.worker.emit("session_start")
  await f.worker.command("")
  await f.manager.emit("session_start")
  const before = structuredClone(f.worker.entries)

  await f.manager.command("priorities 3")
  f.worker.tick()
  f.manager.tick()

  const priorities = readManagerPriorities(f.worker.entries)

  assert.ok(Either.isRight(priorities))
  assert.equal(priorities.right, undefined)
  assert.deepEqual(f.worker.entries, before)
  assert.equal(f.manager.messages.length, 0)
  assert.ok(f.manager.notices.some(message => /retired/u.test(message)))
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
