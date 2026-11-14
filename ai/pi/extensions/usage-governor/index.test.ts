import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent"
import {
  HUMAN_TURN_EVENT,
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
  const hooks = new Map<string, unknown>()
  const pi = {
    on: (name: string, handler: unknown) => {
      hooks.set(name, handler)
      return () => {
        hooks.delete(name)
      }
    },
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
    appendEntry: () => {},
  } satisfies Pick<
    ExtensionAPI,
    "on" | "events" | "registerTool" | "registerCommand" | "appendEntry"
  >
  factory(pi)

  const emit = (name: string, data: unknown) => {
    const listener = listeners.get(name)
    assert.ok(listener)
    listener(data)
  }
  const model = { provider: "fixture-provider", id: "fixture-model" }
  const context = {
    model,
    thinkingLevel: "high",
    modelRegistry: { find: () => model },
    ui: { setStatus: () => {} },
  }
  const start = async (event: unknown) => {
    const handler = hooks.get("before_agent_start")
    assert.ok(typeof handler === "function")
    await handler(event, context)
  }
  const input = (text: string) => {
    const handler = hooks.get("input")
    assert.ok(typeof handler === "function")
    handler({ type: "input", source: "extension", text, images: [] }, context)
  }
  return Object.assign(emit, { start, input })
}

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve))

const promptState = {
  systemPrompt: "",
  systemPromptOptions: {
    selectedTools: [],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    contextFiles: [],
    skills: [],
  },
}

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

test("legacy and current user-start hooks correlate the actual human turn", async t => {
  t.mock.method(Date, "now", () => 1000)
  const emit = await fixture()
  const prompt = "human fixture turn"
  const current = {
    type: "before_agent_start",
    messageType: "user",
    prompt,
    ...promptState,
  } satisfies BeforeAgentStartEvent
  for (const event of [
    { type: "before_agent_start", prompt, systemPrompt: "" },
    current,
  ]) {
    emit(HUMAN_TURN_EVENT, prompt)
    emit.input(prompt)
    await emit.start(event)
    const reports: (number | undefined)[] = []
    emit(OWNER_INTERVENTION_QUERY_EVENT, {
      report: (at: number | undefined) => {
        reports.push(at)
      },
    })
    assert.deepEqual(reports, [1000])
  }
})

test("custom-start hooks cannot impersonate or consume a pending human turn", async t => {
  t.mock.method(Date, "now", () => 1000)
  const emit = await fixture()
  const prompt = "pending human fixture"
  emit(HUMAN_TURN_EVENT, prompt)
  emit.input(prompt)
  const custom = {
    type: "before_agent_start",
    messageType: "custom",
    ...promptState,
    message: { customType: "fixture.wake", content: "fixture", display: false },
  } satisfies BeforeAgentStartEvent
  await emit.start(custom)
  const reports: (number | undefined)[] = []
  const query = {
    report: (at: number | undefined) => {
      reports.push(at)
    },
  }
  emit(OWNER_INTERVENTION_QUERY_EVENT, query)
  await emit.start({ type: "before_agent_start", prompt, systemPrompt: "" })
  emit(OWNER_INTERVENTION_QUERY_EVENT, query)
  assert.deepEqual(reports, [undefined, 1000])
})
