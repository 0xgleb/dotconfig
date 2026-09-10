import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  makeBacklogWakeController,
  type BacklogWakeHost,
  type BacklogWakeInput,
} from "./backlog-wake.ts"
import { emptyBacklogState, ingestBacklogSource } from "./backlog.ts"
import { CAPABILITY_CIRCUIT_ENTRY } from "../shared/capability-state.ts"
import { CONTINUATION_PAUSE_ENTRY } from "../shared/continuation-pause.ts"

const item = Effect.runSync(
  ingestBacklogSource(emptyBacklogState, {
    newItemId: "task-1",
    project: "/workspace",
    source: { kind: "backlog-document", id: "roadmap:task-1" },
    observedAt: 1,
    priority: "normal",
    requirements: [{ text: "untrusted requirement must not be injected" }],
    authority: { kind: "routing-only" },
    dedupe: { kind: "source-only" },
    initialState: "ready",
  }),
).state
const input: Omit<BacklogWakeInput, "lastFingerprint"> = {
  state: item,
  snapshot: {
    version: 1,
    requests: [],
    leases: [
      {
        id: "lease-1",
        project: "/workspace",
        role: "operator",
        mode: "operational",
        status: "active",
        owner: { id: "agent-1", pid: 1 },
        policyDigest: "policy",
        acquiredAt: 0,
        heartbeatAt: 0,
        expiresAt: 90_000,
      },
    ],
  },
  agentId: "agent-1",
  project: "/workspace",
  now: 1000,
  lifecycle: "active",
  entries: [],
  toolsAvailable: true,
  availability: {
    notificationsEnabled: true,
    idle: true,
    pendingMessages: false,
    editorText: "",
    autoReloadPending: false,
  },
}
const runtime = () => {
  const handlers = new Map<string, () => void>()
  const messages: Parameters<BacklogWakeHost["sendMessage"]>[] = []
  let reject = false
  let onSend = () => {}
  const controller = makeBacklogWakeController({
    on: (event, handler) => {
      assert.equal(handlers.has(event), false)
      handlers.set(event, handler)
    },
    sendMessage: (...args) => {
      if (reject) throw new Error("host send failure")
      messages.push(args)
      onSend()
    },
  })
  return {
    event: (name: string) => {
      const handler = handlers.get(name)
      assert.ok(handler)
      handler()
    },
    rejectSend: (value: boolean) => {
      reject = value
    },
    afterSend: (action: () => void) => {
      onSend = action
    },
    controller,
    messages,
    run: (value = input) => Effect.runPromise(controller.reconcile(value)),
  }
}
const custom = (customType: string, data: unknown) => ({
  type: "custom",
  customType,
  data,
})

test("real controller owns startup, shutdown, deduplication and lifecycle reset", async () => {
  const app = runtime()
  await app.run()
  assert.equal(app.messages.length, 0)
  app.event("session_start")
  await app.run()
  await app.run()
  assert.equal(app.messages.length, 1)
  assert.deepEqual(app.messages[0]?.[1], {
    triggerTurn: true,
    deliverAs: "followUp",
  })
  assert.doesNotMatch(
    app.messages[0]?.[0].content ?? "",
    /untrusted requirement/,
  )
  app.event("session_shutdown")
  await app.run()
  assert.equal(app.messages.length, 1)
  app.event("session_start")
  await app.run()
  assert.equal(app.messages.length, 2)
})

test("a lazy operation created before lifecycle replacement cannot wake the replacement", async () => {
  const app = runtime()
  app.event("session_start")
  const old = app.controller.reconcile(input)
  app.event("session_shutdown")
  app.event("session_start")
  await Effect.runPromise(old)
  assert.equal(app.messages.length, 0)
  await app.run()
  assert.equal(app.messages.length, 1)
})

test("all availability and pause guards leave a future reconciliation possible", async () => {
  const unavailable = [
    { ...input, lifecycle: "retired" as const },
    { ...input, toolsAvailable: false },
    ...[
      { notificationsEnabled: false },
      { idle: false },
      { pendingMessages: true },
      { editorText: "draft" },
      { autoReloadPending: true },
    ].map(change => ({
      ...input,
      availability: { ...input.availability, ...change },
    })),
    {
      ...input,
      entries: [
        custom(CONTINUATION_PAUSE_ENTRY, { paused: true, updatedAt: 1 }),
      ],
    },
    {
      ...input,
      entries: [
        custom(CAPABILITY_CIRCUIT_ENTRY, {
          open: true,
          consecutiveBlockers: 2,
          updatedAt: 1,
        }),
      ],
    },
  ]
  for (const value of unavailable) {
    const app = runtime()
    app.event("session_start")
    await app.run(value)
    assert.equal(app.messages.length, 0)
    await app.run()
    assert.equal(app.messages.length, 1)
  }
})

test("malformed latest persisted state returns a typed failure without sending", async () => {
  for (const entry of [
    custom(CONTINUATION_PAUSE_ENTRY, {}),
    custom(CONTINUATION_PAUSE_ENTRY, { paused: false, updatedAt: -1 }),
    custom(CONTINUATION_PAUSE_ENTRY, { paused: false, updatedAt: 1.5 }),
    custom(CAPABILITY_CIRCUIT_ENTRY, {
      open: false,
      consecutiveBlockers: 2,
      updatedAt: 1,
    }),
  ]) {
    const app = runtime()
    app.event("session_start")
    const result = await Effect.runPromise(
      Effect.either(app.controller.reconcile({ ...input, entries: [entry] })),
    )
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "corrupt_state")
    assert.equal(app.messages.length, 0)
  }
})

test("lease reacquisition wakes but observation-only changes do not", async () => {
  const app = runtime()
  app.event("session_start")
  await app.run()
  await app.run({
    ...input,
    state: {
      ...item,
      items: item.items.map(value => ({
        ...value,
        revision: 99,
        updatedAt: 99,
      })),
      sources: item.sources.map(value => ({ ...value, observedAt: 99 })),
    },
  })
  assert.equal(app.messages.length, 1)
  await app.run({
    ...input,
    snapshot: {
      ...input.snapshot,
      leases: input.snapshot.leases.map(value => ({ ...value, id: "lease-2" })),
    },
  })
  assert.equal(app.messages.length, 2)
})

test("host send failure is typed and a later attempt remains eligible", async () => {
  const app = runtime()
  app.event("session_start")
  app.rejectSend(true)
  const failed = await Effect.runPromise(
    Effect.either(app.controller.reconcile(input)),
  )
  assert.ok(Either.isLeft(failed))
  assert.equal(failed.left.code, "io")
  assert.equal(app.messages.length, 0)
  app.rejectSend(false)
  await app.run()
  assert.equal(app.messages.length, 1)
})

test("a successful send in a retired lifecycle cannot mark its replacement delivered", async () => {
  const app = runtime()
  app.event("session_start")
  app.afterSend(() => {
    app.event("session_shutdown")
    app.event("session_start")
    app.afterSend(() => {})
  })
  await app.run()
  await app.run()
  assert.equal(app.messages.length, 2)
})
