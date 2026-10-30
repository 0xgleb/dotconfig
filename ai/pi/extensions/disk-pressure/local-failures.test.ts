import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, type BigIntStatsFs } from "node:fs"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent"
import * as resource from "./core.ts"

const require = createRequire(import.meta.url)
const fs: typeof import("node:fs") = require("node:fs")
const os: typeof import("node:os") = require("node:os")
const processes: typeof import("node:child_process") = require("node:child_process")
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
const support: unknown = await import(
  new URL("../../../test/pi-host-test-support.mjs", import.meta.url).href
)

assert.ok(record(support) && typeof support.loadHostExtension === "function")

const loadHostExtension = support.loadHostExtension

type Hook = (event: unknown, ctx: ExtensionContext) => unknown
const resourceRuntime = async (
  t: test.TestContext,
  disk: bigint,
  memory: () => bigint | undefined,
) => {
  const root = mkdtempSync(join(tmpdir(), "pi-pressure-fixture-"))
  const incidentPath = join(
    root,
    ".local",
    "state",
    "pi",
    "resource-pressure",
    "incident.json",
  )
  const hooks = new Map<string, Set<Hook>>()
  const notifications: { message: string; level: unknown }[] = []
  const messages: unknown[] = []
  const events: string[] = []
  const commands: { command: string; args: unknown; options: unknown }[] = []
  const probes: unknown[] = []
  const baseStats: BigIntStatsFs = {
    type: 0n,
    bsize: 1n,
    blocks: disk,
    bfree: disk,
    bavail: disk,
    files: 0n,
    ffree: 0n,
  }
  const probeResult = (stdout: string) => ({
    pid: 0,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  })
  const homeMock = t.mock.method(os, "homedir", () => root)
  const tempMock = t.mock.method(os, "tmpdir", () => root)
  const diskMock = t.mock.method(
    fs,
    "statfsSync",
    (path: unknown, options: unknown) => {
      probes.push({ path, options })

      return { ...baseStats, bsize: 1n, bavail: disk }
    },
  )
  const freeMemoryMock = t.mock.method(os, "freemem", () => {
    const available = memory()
    if (available === undefined)
      throw new Error("fixture external probe failure")

    return Number(available)
  })
  const processMock = t.mock.method(
    processes,
    "spawnSync",
    (command: string, args: unknown, options: unknown) => {
      commands.push({ command, args, options })

      if (command === "ps") return probeResult("1024 fixture-worker\n")
      if (command !== "/usr/bin/memory_pressure")
        return probeResult("unexpected probe")

      const available = memory()
      return probeResult(
        available === undefined
          ? "unknown output"
          : [
              `The system has ${available * 100n} (pages with a page size of 16384).`,
              "System-wide memory free percentage: 1%",
            ].join("\n"),
      )
    },
  )
  syncBuiltinESMExports()

  const ui = {
    notify: (message, level) => {
      notifications.push({ message, level })
    },
    setStatus: () => {},
  } satisfies Pick<ExtensionUIContext, "notify" | "setStatus">
  const sessionManager = {
    getSessionId: () => "fixture-session",
  } satisfies Pick<ExtensionContext["sessionManager"], "getSessionId">
  const partialUi: Partial<ExtensionUIContext> = ui
  const partialSession: Partial<ExtensionContext["sessionManager"]> =
    sessionManager
  const context = {
    cwd: root,
    ui: partialUi as ExtensionUIContext,
    sessionManager: partialSession as ExtensionContext["sessionManager"],
  } satisfies Partial<ExtensionContext>
  const ctx = context as ExtensionContext
  const dispatch = async (name: string, event: unknown) => {
    const callbacks = hooks.get(name)
    assert.ok(callbacks?.size, `Missing real ${name} registration`)

    const results = []
    for (const callback of callbacks) results.push(await callback(event, ctx))

    assert.equal(results.length, 1)

    return results[0]
  }

  t.after(async () => {
    try {
      if (hooks.has("session_shutdown")) await dispatch("session_shutdown", {})
    } finally {
      for (const mocked of [
        homeMock,
        tempMock,
        diskMock,
        freeMemoryMock,
        processMock,
      ])
        mocked.mock.restore()
      syncBuiltinESMExports()

      rmSync(root, { recursive: true })
    }
  })

  const on: ExtensionAPI["on"] = (name, callback) => {
    const callbacks = hooks.get(name) ?? new Set()
    callbacks.add(callback as unknown as Hook)
    hooks.set(name, callbacks)

    return () => {
      callbacks.delete(callback as unknown as Hook)
    }
  }
  const pi = {
    on,
    events: {
      on: () => () => {},
      emit: (name: string) => {
        events.push(name)
      },
    },
    sendMessage: (message, options) => {
      messages.push({ message, options })
    },
  } satisfies Pick<ExtensionAPI, "on" | "events" | "sendMessage">
  const factory: unknown = await loadHostExtension(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  )

  assert.ok(typeof factory === "function")

  const partialHost: Partial<ExtensionAPI> = pi
  factory(partialHost as ExtensionAPI)

  assert.deepEqual([...hooks.keys()].sort(), [
    "session_shutdown",
    "session_start",
    "tool_call",
    "tool_result",
  ])

  return {
    dispatch,
    notifications,
    messages,
    events,
    root,
    incidentPath,
    assertIsolated: () => {
      assert.ok(probes.length > 0)
      for (const probe of probes)
        assert.deepEqual(probe, { path: root, options: { bigint: true } })
      for (const probe of commands)
        assert.deepEqual(
          probe,
          probe.command === "ps"
            ? {
                command: "ps",
                args: ["-axo", "rss=,comm="],
                options: {
                  encoding: "utf8",
                  maxBuffer: 512 * 1_024,
                  timeout: 5_000,
                },
              }
            : {
                command: "/usr/bin/memory_pressure",
                args: ["-Q"],
                options: {
                  encoding: "utf8",
                  maxBuffer: 16 * 1_024,
                  timeout: 5_000,
                },
              },
        )
      assert.deepEqual(events, [])
    },
  }
}

const buildCall = {
  type: "tool_call",
  toolName: "bash",
  toolCallId: "fixture-build",
  input: { command: "cargo nextest run" },
}

test("critical disk stays visible and blocks expensive work locally", async t => {
  const runtime = await resourceRuntime(
    t,
    resource.CRITICAL_FREE_BYTES - 1n,
    () => resource.WARNING_FREE_MEMORY_BYTES,
  )

  await runtime.dispatch("session_start", {})
  const decision = await runtime.dispatch("tool_call", buildCall)

  assert.match(
    runtime.notifications[0]?.message ?? "",
    /Disk pressure critical/u,
  )
  assert.deepEqual(decision, {
    block: true,
    reason: `Disk pressure guard: only ${resource.formatFreeBytes(resource.CRITICAL_FREE_BYTES - 1n)} free; reserve ${resource.formatFreeBytes(resource.CRITICAL_FREE_BYTES)} before expensive builds. Follow standing exact cleanup authority: inspect candidate roots with dust or Nushell \`du\`, preserve configured live outputs, remove only verified inactive rebuildable or agent-owned artifacts, independently verify the exact path after uncertain execution, then continue the blocked gate. Do not poll repeatedly, delete unrelated data, or ask again for authority already granted.`,
  })
  assert.deepEqual(runtime.messages, [])
  runtime.assertIsolated()
})

test("critical memory persists one deduplicated in-session remediation incident", async t => {
  const runtime = await resourceRuntime(
    t,
    resource.WARNING_FREE_BYTES,
    () => resource.CRITICAL_FREE_MEMORY_BYTES - 1n,
  )

  const decision = await runtime.dispatch("tool_call", buildCall)
  const persisted = readFileSync(runtime.incidentPath, "utf8")
  const repeated = await runtime.dispatch("tool_call", buildCall)

  assert.ok(
    record(decision) &&
      decision.block === true &&
      typeof decision.reason === "string",
  )
  assert.match(decision.reason, /Memory pressure incident/u)
  assert.deepEqual(repeated, decision)
  assert.equal(runtime.notifications.length, 1)
  assert.equal(runtime.messages.length, 1)
  const message = runtime.messages[0]
  assert.ok(record(message) && record(message.message))
  assert.equal(message.message.customType, "resource-pressure.incident")
  assert.deepEqual(message.options, { triggerTurn: true, deliverAs: "steer" })
  const incident: unknown = JSON.parse(persisted)
  assert.ok(
    record(incident) &&
      incident.sessionId === "fixture-session" &&
      typeof incident.createdAt === "number",
  )
  assert.equal(readFileSync(runtime.incidentPath, "utf8"), persisted)
  runtime.assertIsolated()
})

test("unknown capacity remains fail-closed without a remediation turn", async t => {
  const runtime = await resourceRuntime(
    t,
    resource.WARNING_FREE_BYTES,
    () => undefined,
  )

  const decision = await runtime.dispatch("tool_call", buildCall)

  assert.ok(
    record(decision) &&
      decision.block === true &&
      typeof decision.reason === "string",
  )
  assert.match(decision.reason, /could not verify safe build capacity/u)
  assert.match(decision.reason, /probe failed|unknown format/u)
  assert.deepEqual(runtime.messages, [])
  runtime.assertIsolated()
})

test("post-build capacity failure retains its local warning", async t => {
  let reads = 0
  const runtime = await resourceRuntime(t, resource.WARNING_FREE_BYTES, () =>
    ++reads === 1 ? resource.WARNING_FREE_MEMORY_BYTES : undefined,
  )

  assert.equal(await runtime.dispatch("tool_call", buildCall), undefined)
  await runtime.dispatch("tool_result", { toolCallId: "fixture-build" })

  assert.equal(runtime.notifications.length, 1)
  assert.equal(runtime.notifications[0]?.level, "warning")
  assert.match(
    runtime.notifications[0]?.message ?? "",
    /Post-build cleanup failed safely:.*(?:probe failed|unknown format)/u,
  )
  assert.deepEqual(runtime.messages, [])
  runtime.assertIsolated()
})
