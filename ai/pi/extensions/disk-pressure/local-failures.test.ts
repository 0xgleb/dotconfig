import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { Effect, Either } from "effect"

import { AGENTOPS_INCIDENT_EVENT } from "../shared/agentops-events.ts"
import { MemoryCapacityError } from "../shared/memory-capacity.ts"
import { RESOURCE_PREFLIGHT_REQUEST_EVENT } from "../shared/resource-preflight.ts"
import * as resource from "./core.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const resourceRuntime = (
  disk: bigint,
  memory: () => Effect.Effect<bigint, MemoryCapacityError>,
) => {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const routed: unknown[] = []
  const notifications: { message: string; level: unknown }[] = []
  const messages: { message: unknown; options: unknown }[] = []
  const bindings = {
    ...resource,
    Effect,
    Either,
    AGENTOPS_INCIDENT_EVENT,
    RESOURCE_PREFLIGHT_REQUEST_EVENT,
    STATUS_KEY: "disk-pressure",
    INCIDENT_PATH: "/fixture/incident.json",
    INCIDENT_TTL_MS: 600_000,
    availableMemoryBytes: memory,
    freeBytes: () => disk,
    updateStatus: () => undefined,
    registerRuntimeVersion: () => undefined,
    clearResourceIncident: () => Effect.void,
    claimResourceIncident: () => Effect.succeed(true),
    cleanupStalePiTempLogs: () => [],
    cleanupNewResultSymlinks: () => [],
    resultSymlinkNames: () => new Set<string>(),
    processAggregateText: () => "fixture aggregate",
    tmpdir: () => "/fixture/tmp",
    isToolCallEventType: (name: string, event: { toolName: string }) =>
      name === event.toolName,
  }
  const start = source.indexOf("export default ")
  assert.ok(start >= 0)
  const initialize: (api: unknown) => void = new Function(
    ...Object.keys(bindings),
    `return (${stripTypeScriptTypes(source.slice(start + "export default ".length), { mode: "strip" })});`,
  )(...Object.values(bindings))
  initialize({
    events: {
      on: () => undefined,
      emit: (_name: string, payload: unknown) => routed.push(payload),
    },
    on: (name: string, hook: (event: unknown, ctx: unknown) => unknown) =>
      hooks.set(name, hook),
    sendMessage: (message: unknown, options: unknown) =>
      messages.push({ message, options }),
  })
  const ctx = {
    cwd: "/fixture/project",
    sessionManager: { getSessionId: () => "fixture-session" },
    ui: {
      notify: (message: string, level: unknown) =>
        notifications.push({ message, level }),
      setStatus: () => undefined,
    },
  }
  const dispatch = async (name: string, event: unknown) => {
    const hook = hooks.get(name)
    assert.ok(hook, `Missing ${name} hook`)
    return await hook(event, ctx)
  }
  return { dispatch, routed, notifications, messages }
}

const buildCall = {
  type: "tool_call",
  toolName: "bash",
  toolCallId: "fixture-build",
  input: { command: "cargo nextest run" },
}

test("critical disk stays visible and blocks expensive work without support routing", async () => {
  const runtime = resourceRuntime(resource.CRITICAL_FREE_BYTES - 1n, () =>
    Effect.succeed(resource.WARNING_FREE_MEMORY_BYTES),
  )
  await runtime.dispatch("session_start", {})
  assert.match(
    runtime.notifications[0]?.message ?? "",
    /Disk pressure critical/,
  )
  assert.deepEqual(await runtime.dispatch("tool_call", buildCall), {
    block: true,
    reason: `Disk pressure guard: only ${resource.formatFreeBytes(resource.CRITICAL_FREE_BYTES - 1n)} free; reserve ${resource.formatFreeBytes(resource.CRITICAL_FREE_BYTES)} before expensive builds. Follow standing exact cleanup authority: inspect candidate roots with dust or Nushell \`du\`, preserve configured live outputs, remove only verified inactive rebuildable or agent-owned artifacts, independently verify the exact path after uncertain execution, then continue the blocked gate. Do not poll repeatedly, delete unrelated data, or ask again for authority already granted.`,
  })
  assert.deepEqual(runtime.routed, [])
  assert.deepEqual(runtime.messages, [])
})

test("critical memory retains the bounded in-session remediation turn and block", async () => {
  const runtime = resourceRuntime(resource.WARNING_FREE_BYTES, () =>
    Effect.succeed(resource.CRITICAL_FREE_MEMORY_BYTES - 1n),
  )
  const decision = await runtime.dispatch("tool_call", buildCall)
  assert.ok(
    typeof decision === "object" &&
      decision !== null &&
      "block" in decision &&
      "reason" in decision &&
      typeof decision.reason === "string",
  )
  assert.equal(decision.block, true)
  assert.match(decision.reason, /Memory pressure incident/)
  assert.equal(runtime.notifications.length, 1)
  assert.equal(runtime.messages.length, 1)
  assert.deepEqual(runtime.messages[0]?.options, {
    triggerTurn: true,
    deliverAs: "steer",
  })
  const message = runtime.messages[0]?.message
  assert.ok(
    typeof message === "object" && message !== null && "customType" in message,
  )
  assert.equal(message.customType, "resource-pressure.incident")
  assert.deepEqual(runtime.routed, [])
})

test("unknown capacity remains fail-closed without enqueueing support", async () => {
  const runtime = resourceRuntime(resource.WARNING_FREE_BYTES, () =>
    Effect.fail(
      new MemoryCapacityError({ message: "fixture capacity failure" }),
    ),
  )
  const decision = await runtime.dispatch("tool_call", buildCall)
  assert.ok(
    typeof decision === "object" &&
      decision !== null &&
      "block" in decision &&
      "reason" in decision &&
      typeof decision.reason === "string",
  )
  assert.equal(decision.block, true)
  assert.match(decision.reason, /fixture capacity failure/)
  assert.deepEqual(runtime.routed, [])
  assert.deepEqual(runtime.messages, [])
})

test("post-build capacity failure retains its local warning", async () => {
  let reads = 0
  const runtime = resourceRuntime(resource.WARNING_FREE_BYTES, () => {
    reads += 1
    return reads === 1
      ? Effect.succeed(resource.WARNING_FREE_MEMORY_BYTES)
      : Effect.fail(
          new MemoryCapacityError({ message: "fixture cleanup failure" }),
        )
  })
  assert.equal(await runtime.dispatch("tool_call", buildCall), undefined)
  await runtime.dispatch("tool_result", { toolCallId: "fixture-build" })
  assert.deepEqual(runtime.notifications, [
    {
      message: "Post-build cleanup failed safely: fixture cleanup failure",
      level: "warning",
    },
  ])
  assert.deepEqual(runtime.routed, [])
})
