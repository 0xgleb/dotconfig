import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { Effect, Either } from "effect"
import { makeBacklogWakeController } from "./backlog-wake.ts"
import {
  emptyBacklogState,
  ingestBacklogSource,
  type BacklogState,
} from "./backlog.ts"
import {
  prioritizedActiveReceiptLeases,
  registryReceiptAvailable,
  registrySyncNotification,
  type RegistrySnapshot,
} from "./registry.ts"
import {
  CONTINUATION_PAUSE_ENTRY,
  isContinuationPaused,
} from "../shared/continuation-pause.ts"
import { CAPABILITY_CIRCUIT_ENTRY } from "../classified-workflows/capability-circuit.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const start = source.indexOf("  const sync = async")
const end = source.indexOf("  const autoClaimOperationalRole", start)
assert.ok(start >= 0 && end > start)
const syncSource = source
  .slice(start, end)
  .replace("ctx: ExtensionContext,", "ctx,")
const agent = { id: "agent-1", pid: 1 }
const snapshot: RegistrySnapshot = {
  version: 1,
  leases: [
    {
      id: "lease-1",
      project: "/workspace",
      role: "operator",
      mode: "operational",
      status: "active",
      owner: agent,
      policyDigest: "policy",
      acquiredAt: 0,
      heartbeatAt: 0,
      expiresAt: 90_000,
    },
  ],
  requests: [],
}
const backlog = Effect.runSync(
  ingestBacklogSource(emptyBacklogState, {
    newItemId: "item-1",
    project: "/workspace",
    source: { kind: "tracker-item", id: "issue:42" },
    observedAt: 1,
    priority: "normal",
    requirements: [{ text: "Inspect the declared task" }],
    authority: { kind: "routing-only" },
    dedupe: { kind: "source-only" },
    initialState: "ready",
  }),
).state

interface Controls {
  snapshot: RegistrySnapshot
  backlog: BacklogState
  entries: unknown[]
  idle: boolean
  pending: boolean
  editor: string
  reload: boolean
  tools: string[]
  now: number
  failSend: boolean
  afterBacklog: () => Promise<void>
  afterProjection: () => Promise<void>
}

const runtime = (initial: Partial<Controls> = {}) => {
  const controls: Controls = {
    snapshot,
    backlog,
    entries: [],
    idle: true,
    pending: false,
    editor: "",
    reload: false,
    tools: ["read"],
    now: 1000,
    failSend: false,
    afterBacklog: async () => {},
    afterProjection: async () => {},
    ...initial,
  }
  const messages: Array<
    [{ content: string; details: { kind: string } }, unknown]
  > = []
  const errors: unknown[] = []
  const ctx = {
    cwd: "/workspace",
    isIdle: () => controls.idle,
    hasPendingMessages: () => controls.pending,
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => controls.entries,
    },
    ui: {
      getEditorText: () => controls.editor,
      setStatus: () => {},
      notify: (text: string, kind: string) => {
        if (kind === "error" || kind === "warning") errors.push(text)
      },
    },
  }
  const dependencies = {
    ctx,
    agent,
    controls,
    messages,
    errors,
    Effect,
    Either,
    makeBacklogWakeController,
    prioritizedActiveReceiptLeases,
    registryReceiptAvailable,
    registrySyncNotification,
    isContinuationPaused,
  }
  const install = new Function(
    "dependencies",
    `
    const { ctx, agent, controls, messages, errors, Effect, Either, makeBacklogWakeController, prioritizedActiveReceiptLeases, registryReceiptAvailable, registrySyncNotification, isContinuationPaused } = dependencies;
    const Date = { now: () => controls.now };
    let latestCtx = ctx;
    let activeLifecycleEpoch = 1;
    let syncing = false;
    let latestSnapshot;
    let registryFailureActive = false;
    const notifiedRequests = new Set();
    const lifecycleHandlers = new Map();
    const pi = { on: (event, handler) => lifecycleHandlers.set(event, handler), getSessionName: () => "test", sendMessage: (...args) => { if (controls.failSend) throw new Error("send failed"); messages.push(args); }, getActiveTools: () => controls.tools };
    const backlogWake = makeBacklogWakeController(pi);
    lifecycleHandlers.get("session_start")();
    const identity = () => agent;
    const currentPolicyDigest = () => "policy";
    const sessionTokenUsage = () => ({});
    const activities = () => [];
    const LEASE_TTL_MS = 90000;
    const MAX_RECEIPTS_PER_NOTIFICATION = 8;
    const MESSAGE_TYPE = "agent-registry.message";
    const run = operation => Effect.isEffect(operation) ? Effect.runPromise(operation) : Promise.resolve(operation);
    const store = {
      heartbeatAgent: () => Effect.void, snapshot: () => Effect.succeed(controls.snapshot), heartbeat: () => Effect.void,
      pause: () => Effect.void, resume: () => Effect.void,
      backlogSnapshot: () => Effect.promise(async () => { await controls.afterBacklog(); return controls.backlog; }),
      receiveRequest: () => Effect.void,
    };
    const ownedLeases = (value, id) => value.leases.filter(lease => lease.owner.id === id);
    const terminalOutcomeBelongsToContext = () => false;
    const autoReloadPending = () => controls.reload;
    const emitBacklogProjection = () => controls.afterProjection();
    const render = () => {};
    const safeErrorMessage = error => String(error);
    const registryFailureFrom = () => undefined;
    const requestNotificationText = () => "receipt";
    const requestNotificationDetails = () => ({ kind: "request-receipt" });
    const persistNotifiedRequests = () => {};
    ${syncSource}
    return { sync: (enabled = true) => sync(ctx, enabled), retire: () => { activeLifecycleEpoch = undefined; latestCtx = undefined; } };
  `,
  )
  const installed: {
    sync: (enabled?: boolean) => Promise<void>
    retire: () => void
  } = install(dependencies)
  return { ...installed, messages, errors, controls }
}

const custom = (customType: string, data: unknown) => ({
  type: "custom",
  customType,
  data,
})

test("actual registry sync wakes an operational owner for existing external backlog without a new receipt", async () => {
  const app = runtime()
  await app.sync()
  assert.deepEqual(app.errors, [])
  assert.equal(app.messages.length, 1)
  assert.deepEqual(app.messages[0]?.[1], {
    triggerTurn: true,
    deliverAs: "followUp",
  })
  assert.match(
    app.messages[0]?.[0].content ?? "",
    /does not claim work, authorize backlog content/,
  )
  assert.doesNotMatch(
    app.messages[0]?.[0].content ?? "",
    /Inspect the declared task/,
  )
  await app.sync()
  assert.equal(
    app.messages.length,
    1,
    "unchanged backlog must not create a polling loop",
  )
})

test("transient busy, queue, draft and reload guards defer rather than consume the wake", async () => {
  for (const initial of [
    { idle: false },
    { pending: true },
    { editor: "draft" },
    { reload: true },
    { tools: [] },
  ]) {
    const app = runtime(initial)
    await app.sync()
    assert.deepEqual(app.messages, [])
    Object.assign(app.controls, {
      idle: true,
      pending: false,
      editor: "",
      reload: false,
      tools: ["read"],
    })
    await app.sync()
    assert.equal(app.messages.length, 1)
    assert.deepEqual(app.errors, [])
  }
})

test("startup notification suppression does not consume the backlog wake", async () => {
  const app = runtime()
  await app.sync(false)
  assert.deepEqual(app.messages, [])
  await app.sync()
  assert.equal(app.messages.length, 1)
})

test("manual pause and capability circuit prevent automatic backlog turns", async () => {
  for (const entry of [
    custom(CONTINUATION_PAUSE_ENTRY, { paused: true, updatedAt: 1 }),
    custom(CAPABILITY_CIRCUIT_ENTRY, {
      open: true,
      consecutiveBlockers: 2,
      updatedAt: 1,
    }),
  ]) {
    const app = runtime({ entries: [entry] })
    await app.sync()
    assert.deepEqual(app.messages, [])
    app.controls.entries = []
    await app.sync()
    assert.equal(app.messages.length, 1)
  }
})

test("malformed persisted pause and capability state fail closed with diagnostics", async () => {
  for (const entry of [
    custom(CONTINUATION_PAUSE_ENTRY, { paused: "false", updatedAt: 1 }),
    custom(CAPABILITY_CIRCUIT_ENTRY, {
      open: false,
      consecutiveBlockers: 2,
      updatedAt: 1,
    }),
  ]) {
    const app = runtime({ entries: [entry] })
    await app.sync()
    assert.deepEqual(app.messages, [])
    assert.equal(app.errors.length, 1)
  }
})

test("task, foreign, paused, wrong-project and expired leases cannot wake the operator", async () => {
  const lease = snapshot.leases[0]
  assert.ok(lease)
  for (const changed of [
    { ...lease, mode: "task" as const },
    { ...lease, owner: { id: "other", pid: 2 } },
    { ...lease, status: "paused" as const },
    { ...lease, project: "/other" },
    { ...lease, expiresAt: 999 },
  ]) {
    const app = runtime({ snapshot: { ...snapshot, leases: [changed] } })
    await app.sync()
    assert.deepEqual(app.messages, [])
  }
})

test("blocked, unreconciled, foreign-assigned and branch-todo-only work does not trigger", async () => {
  const item = backlog.items[0]
  assert.ok(item)
  for (const state of [
    { kind: "blocked", reason: "waiting" } as const,
    { kind: "unreconciled" } as const,
    { kind: "assigned", agentId: "other", leaseId: "foreign" } as const,
  ]) {
    const app = runtime({
      backlog: { ...backlog, items: [{ ...item, state }] },
    })
    await app.sync()
    assert.deepEqual(app.messages, [])
  }
  const local = runtime({
    backlog: {
      ...backlog,
      sources: backlog.sources.map(entry => ({
        ...entry,
        kind: "branch-todo",
      })),
    },
  })
  await local.sync()
  assert.deepEqual(local.messages, [])
})

test("observation and revision churn is ignored but same-count new work wakes", async () => {
  const app = runtime()
  await app.sync()
  app.controls.backlog = {
    ...backlog,
    items: backlog.items.map(item => ({
      ...item,
      revision: 900,
      updatedAt: 900,
    })),
    sources: backlog.sources.map(entry => ({ ...entry, observedAt: 900 })),
  }
  await app.sync()
  assert.equal(app.messages.length, 1)
  app.controls.backlog = {
    ...backlog,
    items: backlog.items.map(item => ({ ...item, id: "replacement" })),
    sources: backlog.sources.map(entry => ({
      ...entry,
      itemId: "replacement",
    })),
  }
  await app.sync()
  assert.equal(app.messages.length, 2)
})

test("a reacquired operational lease reconciles unchanged backlog", async () => {
  const app = runtime()
  await app.sync()
  app.controls.snapshot = {
    ...snapshot,
    leases: snapshot.leases.map(lease => ({
      ...lease,
      id: "replacement-lease",
    })),
  }
  await app.sync()
  assert.equal(app.messages.length, 2)
})

test("send failure does not consume a wake", async () => {
  const app = runtime({ failSend: true })
  await app.sync()
  assert.equal(app.errors.length, 1)
  assert.deepEqual(app.messages, [])
  app.controls.failSend = false
  await app.sync()
  assert.equal(app.messages.length, 1)
})

test("shutdown or pause during awaited work cannot start a late turn", async () => {
  for (const hook of ["afterBacklog", "afterProjection"] as const) {
    const app = runtime()
    app.controls[hook] = async () => {
      app.retire()
    }
    await app.sync()
    assert.deepEqual(app.messages, [])
    assert.deepEqual(app.errors, [])
  }
  const paused = runtime()
  paused.controls.afterProjection = async () => {
    paused.controls.entries = [
      custom(CONTINUATION_PAUSE_ENTRY, { paused: true, updatedAt: 1 }),
    ]
  }
  await paused.sync()
  assert.deepEqual(paused.messages, [])
})

test("a receipt and backlog reconciliation cannot both wake in one sync", async () => {
  const app = runtime({
    snapshot: {
      ...snapshot,
      requests: [
        {
          id: "request-1",
          project: "/workspace",
          role: "operator",
          requesterId: "source",
          text: "inspect",
          priority: "urgent",
          status: "queued",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
  })
  await app.sync()
  assert.deepEqual(app.errors, [])
  assert.equal(app.messages.length, 1)
  assert.equal(app.messages[0]?.[0].details.kind, "request-receipt")
})
