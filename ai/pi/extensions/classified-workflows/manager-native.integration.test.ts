import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import os, { tmpdir } from "node:os"
import { syncBuiltinESMExports } from "node:module"
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

type CapturedHook = (event: unknown, ctx: ExtensionContext) => unknown
type CapturedCommand = (args: string, ctx: ExtensionContext) => Promise<void>

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
          tool.name === "manager_control",
          "native manager control registers its supported tool",
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

test("default /manager launches native Pi without renewing the worker", async t => {
  const f = fixture(t)
  await f.worker.emit("session_start")
  const allowance = f.worker.guard.admit()
  const before = structuredClone(f.worker.entries)

  await f.worker.command("")

  assert.equal(f.worker.executions.length, 2)

  await f.manager.emit("session_start")
  assert.deepEqual(f.worker.guard.admit(), allowance)
  assert.deepEqual(f.worker.modelCalls, [])
})

test("manager chat's own allowance expiry cannot create a worker summary or false scope error", async t => {
  const f = fixture(t)
  await f.worker.emit("session_start")
  await f.worker.command("")
  await f.manager.emit("session_start")
  await f.manager.command("history")
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
