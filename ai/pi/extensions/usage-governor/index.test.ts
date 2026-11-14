import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  OWNER_INTERVENTION_QUERY_EVENT,
  OWNER_INTERVENTION_RELAY_EVENT,
} from "../shared/usage-governor-events.ts"

const fixture = async () => {
  const support: unknown = await import(
    new URL("../../../test/pi-host-test-support.mjs", import.meta.url).href
  )
  assert.ok(
    typeof support === "object" &&
      support !== null &&
      "loadHostExtension" in support &&
      typeof support.loadHostExtension === "function",
  )
  const factory: unknown = await support.loadHostExtension(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  )
  assert.ok(typeof factory === "function")

  const listeners = new Map<string, (data: unknown) => void>()
  const pi = {
    on: () => () => {},
    events: {
      on: (name: string, listener: (data: unknown) => void) => {
        listeners.set(name, listener)
        return () => {
          listeners.delete(name)
        }
      },
      emit: () => {},
    },
    registerTool: () => {},
    registerCommand: () => {},
  } satisfies Pick<
    ExtensionAPI,
    "on" | "events" | "registerTool" | "registerCommand"
  >
  factory(pi)

  return (name: string, data: unknown) => {
    const listener = listeners.get(name)
    assert.ok(listener)
    listener(data)
  }
}

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve))

test("owner-intervention queries ignore malformed reporters at the real extension boundary", async () => {
  const emit = await fixture()
  for (const data of [undefined, null, 1, "query", [], {}, { report: 1 }]) {
    assert.doesNotThrow(() => emit(OWNER_INTERVENTION_QUERY_EVENT, data))
  }
})

test("owner-intervention queries report an absent human interaction while idle", async () => {
  const emit = await fixture()
  const reports: (number | undefined)[] = []
  emit(OWNER_INTERVENTION_QUERY_EVENT, {
    report: (at: number | undefined) => {
      reports.push(at)
    },
  })
  assert.deepEqual(reports, [undefined])
})

test("malformed owner-intervention relays cannot send a control-plane request", async t => {
  const requests: unknown[] = []
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) => {
      requests.push(init?.body)
      return new Response(null, { status: 200 })
    },
  )
  const emit = await fixture()
  const valid = {
    targetAgentId: "fixture-agent",
    targetCwd: "/fixture/target",
    ownerInteractionAt: 1000,
  }
  for (const data of [
    undefined,
    null,
    [],
    {},
    { ...valid, targetAgentId: 1 },
    { ...valid, targetCwd: null },
    { ...valid, ownerInteractionAt: "1000" },
    { ...valid, ownerInteractionAt: Number.NaN },
    { ...valid, ownerInteractionAt: -1 },
  ])
    emit(OWNER_INTERVENTION_RELAY_EVENT, data)
  await nextTick()
  assert.deepEqual(requests, [])
})

test("valid owner-intervention relays forward only the supported fields", async t => {
  const requests: unknown[] = []
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) => {
      assert.equal(typeof init?.body, "string")
      requests.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 200 })
    },
  )
  const emit = await fixture()
  const relay = {
    targetAgentId: "fixture-agent",
    targetCwd: "/fixture/target",
    ownerInteractionAt: 1000,
  }
  emit(OWNER_INTERVENTION_RELAY_EVENT, {
    ...relay,
    unrelated: "untrusted-extra",
  })
  await nextTick()
  assert.deepEqual(requests, [relay])
})
