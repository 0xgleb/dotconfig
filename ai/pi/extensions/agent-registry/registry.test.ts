import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { Cause, Deferred, Effect, Fiber, Option, Runtime } from "effect"
import {
  makeSqliteRegistryStore,
  type SqliteRegistryStore,
} from "./sqlite-store.ts"
import {
  prioritizedActiveReceiptLeases,
  reconcileSessionLease,
  RegistryError,
  registryReceiptAvailable,
  registrySyncNotification,
  runRegistryEffect,
  type AgentActivity,
  type AgentIdentity,
  type Lease,
  type RegistrySnapshot,
} from "./registry.ts"
import { runtimeAgentId } from "./runtime-identity.ts"
import type { AgentTokenUsage } from "./usage.ts"

const withStores: (
  run: (
    first: SqliteRegistryStore,
    second: SqliteRegistryStore,
    root: string,
  ) => Promise<void>,
) => Promise<void> = async run => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-registry-test-"))
  const first = makeSqliteRegistryStore(root)
  const second = makeSqliteRegistryStore(root)
  try {
    await run(first, second, root)
  } finally {
    first.close()
    second.close()
    await rm(root, { recursive: true, force: true })
  }
}

const workerPath = new URL(
  "./test-fixtures/registry-worker.ts",
  import.meta.url,
).pathname

const runWorker: (root: string, agentId: string) => Promise<string> = (
  root,
  agentId,
) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [workerPath, "claim", root, agentId],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => {
      stdout += String(chunk)
    })
    child.stderr.on("data", chunk => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", code => {
      if (code === 0) resolve(stdout.trim())
      else
        reject(
          new Error(`registry worker exited ${code}: ${stderr.slice(-1_000)}`),
        )
    })
  })

const agent: (id: string) => AgentIdentity = id => ({
  id,
  pid: id === "agent-a" ? 101 : 202,
  model: "openai-codex/gpt-5.6-sol",
})

const usage = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 10,
  totalTokens: 160,
} as const

test("registry Effect runner preserves typed operational failures", async () => {
  const failure = new RegistryError({
    code: "busy",
    message: "registry is busy",
  })
  await assert.rejects(runRegistryEffect(Effect.fail(failure)), error => {
    if (!Runtime.isFiberFailure(error)) return false
    const cause = error[Runtime.FiberFailureCauseId]
    return Option.getOrUndefined(Cause.failureOption(cause)) === failure
  })
})

test("registry sync failures notify once per outage and report recovery", () => {
  assert.equal(
    registrySyncNotification(false, "io: Could not read registry"),
    "Agent registry: io: Could not read registry",
  )
  assert.equal(registrySyncNotification(true, "io: disk I/O error"), undefined)
  assert.equal(registrySyncNotification(true), "Agent registry recovered.")
  assert.equal(registrySyncNotification(false), undefined)
})

test("registry receipt availability preserves active input and reload work", () => {
  const available = {
    notificationsEnabled: true,
    idle: true,
    pendingMessages: false,
    editorText: "",
    autoReloadPending: false,
  } as const
  assert.equal(registryReceiptAvailable(available), true)
  assert.equal(
    registryReceiptAvailable({ ...available, editorText: "owner draft" }),
    false,
  )
  assert.equal(
    registryReceiptAvailable({ ...available, pendingMessages: true }),
    false,
  )
  assert.equal(registryReceiptAvailable({ ...available, idle: false }), false)
  assert.equal(
    registryReceiptAvailable({ ...available, autoReloadPending: true }),
    false,
  )
  assert.equal(
    registryReceiptAvailable({ ...available, notificationsEnabled: false }),
    false,
  )
})

test("operational receipt leases are selected before task leases", () => {
  const lease = (
    id: string,
    mode: "task" | "operational",
    ownerId = "agent-a",
    status: "active" | "paused" = "active",
  ): Lease => ({
    id,
    project: "/project",
    role: id,
    mode,
    owner: agent(ownerId),
    policyDigest: "policy",
    acquiredAt: 1,
    heartbeatAt: 1,
    expiresAt: 100,
    status,
  })
  const snapshot: RegistrySnapshot = {
    version: 1,
    leases: [
      lease("task", "task"),
      lease("operational", "operational"),
      lease("paused", "operational", "agent-a", "paused"),
      lease("other-owner", "operational", "agent-b"),
    ],
    requests: [],
  }
  assert.deepEqual(
    prioritizedActiveReceiptLeases(snapshot, "agent-a").map(({ id }) => id),
    ["operational", "task"],
  )
})

test("registry uses WAL so fleet readers do not contend with ordinary writers", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(store.snapshot(0))
    const database = new DatabaseSync(join(root, "registry.sqlite"))
    try {
      const row = database.prepare("PRAGMA journal_mode").get()
      assert.equal(row?.journal_mode, "wal")
    } finally {
      database.close()
    }
  })
})

test("a live Pi registry store keeps its WAL connection open between sync operations", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(store.snapshot(0))
    assert.equal(existsSync(join(root, "registry.sqlite-wal")), true)
    assert.equal(existsSync(join(root, "registry.sqlite-shm")), true)
  })
})

test("concurrent first use retains one closeable SQLite connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-registry-first-use-"))
  const store = makeSqliteRegistryStore(root)
  try {
    const reads = [store.snapshot(0), store.snapshot(0)] as const
    await Effect.runPromise(Effect.all(reads, { concurrency: "unbounded" }))
    assert.equal(existsSync(join(root, "registry.sqlite-wal")), true)
    store.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(existsSync(join(root, "registry.sqlite-wal")), false)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("current schema reads do not acquire write locks during fleet heartbeats", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(store.snapshot(0))
    const writer = new DatabaseSync(join(root, "registry.sqlite"))
    writer.exec("BEGIN IMMEDIATE")
    try {
      const snapshot = await Effect.runPromise(store.snapshot(1))
      assert.equal(snapshot.version, 1)
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
    }
  })
})

test("concurrent claims produce exactly one exclusive role owner", async () => {
  await withStores(async (first, second) => {
    const claims = await Promise.all([
      Effect.runPromise(
        first.claim({
          agent: agent("agent-a"),
          project: "/workspace/project",
          role: "staging-operator",
          mode: "operational",
          policyDigest: "policy-a",
          now: 1_000,
          ttlMs: 10_000,
        }),
      ),
      Effect.runPromise(
        second.claim({
          agent: agent("agent-b"),
          project: "/workspace/project",
          role: "staging-operator",
          mode: "operational",
          policyDigest: "policy-a",
          now: 1_000,
          ttlMs: 10_000,
        }),
      ),
    ])
    assert.equal(
      claims.filter(({ outcome }) => outcome === "claimed").length,
      1,
    )
    assert.equal(
      claims.filter(({ outcome }) => outcome === "already_owned").length,
      1,
    )
    const snapshot = await Effect.runPromise(first.snapshot(1_000))
    assert.equal(snapshot.leases.length, 1)
  })
})

test("separate Pi processes serialize concurrent claims", async () => {
  await withStores(async (_first, _second, root) => {
    const outputs = await Promise.all([
      runWorker(root, "process-a"),
      runWorker(root, "process-b"),
    ])
    const outcomes = outputs.map(output => JSON.parse(output).outcome).sort()
    assert.deepEqual(outcomes, ["already_owned", "claimed"])
  })
})

test("one registry connection serializes concurrent lifecycle mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-registry-concurrency-"))
  const began = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  let barrierArmed = false
  const transactionBeginSignal = Effect.suspend(() => {
    if (!barrierArmed) return Effect.void
    barrierArmed = false
    return Deferred.succeed(began, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    )
  })
  const store = makeSqliteRegistryStore(root, { transactionBeginSignal })
  try {
    await Effect.runPromise(store.snapshot(0))
    barrierArmed = true
    const first = Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "first parallel lifecycle mutation",
        now: 1_000,
      }),
    )
    await Effect.runPromise(Deferred.await(began))
    const second = Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "second parallel lifecycle mutation",
        now: 1_001,
      }),
    )
    await Effect.runPromise(Deferred.succeed(release, undefined))
    const requests = await Promise.all([first, second])
    assert.deepEqual(
      requests.map(request => request.status),
      ["queued", "queued"],
    )
    const persisted = await Effect.runPromise(store.snapshot(2_000))
    assert.deepEqual(
      persisted.requests.map(request => request.id).sort(),
      requests.map(request => request.id).sort(),
    )
  } finally {
    await Effect.runPromise(
      Deferred.succeed(release, undefined).pipe(Effect.ignore),
    )
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("interrupting a registry transaction rolls back before releasing access", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-registry-interruption-"))
  const began = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  let barrierArmed = false
  const transactionBeginSignal = Effect.suspend(() => {
    if (!barrierArmed) return Effect.void
    barrierArmed = false
    return Deferred.succeed(began, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    )
  })
  const store = makeSqliteRegistryStore(root, { transactionBeginSignal })
  try {
    await Effect.runPromise(store.snapshot(0))
    barrierArmed = true
    const interrupted = Effect.runFork(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "interrupted mutation",
        now: 1_000,
      }),
    )
    await Effect.runPromise(Deferred.await(began))
    await Effect.runPromise(Fiber.interrupt(interrupted))

    const request = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "after interruption",
        now: 2_000,
      }),
    )
    assert.equal(request.status, "queued")
    const persisted = await Effect.runPromise(store.snapshot(2_001))
    assert.deepEqual(
      persisted.requests.map(({ text }) => text),
      ["after interruption"],
    )
  } finally {
    await Effect.runPromise(
      Deferred.succeed(release, undefined).pipe(Effect.ignore),
    )
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("closing a registry store is terminal", async () => {
  await withStores(async store => {
    await Effect.runPromise(store.snapshot(0))
    store.close()
    await assert.rejects(
      Effect.runPromise(store.snapshot(1)),
      /registry store is closed/i,
    )
  })
})

test("a killed SQLite writer rolls back before another process proceeds", async () => {
  await withStores(async (store, _second, root) => {
    const child = spawn(
      process.execPath,
      [workerPath, "crash-transaction", root],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject)
      child.on("close", code =>
        reject(new Error(`crash worker exited before READY with ${code}`)),
      )
      child.stdout.on("data", chunk => {
        if (String(chunk).includes("READY")) resolve()
      })
    })
    const closed = new Promise<void>(resolve =>
      child.once("close", () => resolve()),
    )
    child.kill("SIGKILL")
    await closed
    const snapshot = await Effect.runPromise(store.snapshot(1_000))
    assert.equal(
      snapshot.leases.some(({ role }) => role === "crashed"),
      false,
    )
  })
})

test("one agent holds multiple roles while a live lease cannot be stolen", async () => {
  await withStores(async store => {
    const owner = agent("agent-a")
    const first = await Effect.runPromise(
      store.claim({
        agent: owner,
        project: "/workspace/project",
        role: "engineering",
        mode: "task",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    const second = await Effect.runPromise(
      store.claim({
        agent: owner,
        project: "/workspace/project",
        role: "staging-operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    const rejected = await Effect.runPromise(
      store.claim({
        agent: agent("agent-b"),
        project: "/workspace/project",
        role: "engineering",
        mode: "task",
        policyDigest: "p1",
        now: 1_001,
        ttlMs: 10_000,
      }),
    )
    assert.equal(first.outcome, "claimed")
    assert.equal(second.outcome, "claimed")
    assert.equal(rejected.outcome, "already_owned")
  })
})

test("expired leases are reclaimable but stale owners cannot mutate requests", async () => {
  await withStores(async store => {
    const firstClaim = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 100,
      }),
    )
    assert.equal(firstClaim.outcome, "claimed")
    const leaseA =
      firstClaim.outcome === "claimed"
        ? firstClaim.lease
        : assert.fail("missing lease")

    const request = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "inspect health",
        now: 1_010,
      }),
    )
    await Effect.runPromise(
      store.claimRequest({
        requestId: request.id,
        leaseId: leaseA.id,
        agentId: "agent-a",
        now: 1_011,
      }),
    )
    const secondClaim = await Effect.runPromise(
      store.claim({
        agent: agent("agent-b"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_101,
        ttlMs: 100,
      }),
    )
    assert.equal(secondClaim.outcome, "claimed")
    const leaseB =
      secondClaim.outcome === "claimed"
        ? secondClaim.lease
        : assert.fail("missing replacement lease")

    await assert.rejects(
      Effect.runPromise(
        store.completeRequest({
          requestId: request.id,
          leaseId: leaseA.id,
          agentId: "agent-a",
          summary: "stale completion",
          now: 1_102,
        }),
      ),
      /stale|lease/i,
    )
    const claimed = await Effect.runPromise(
      store.claimRequest({
        requestId: request.id,
        leaseId: leaseB.id,
        agentId: "agent-b",
        now: 1_102,
      }),
    )
    assert.equal(claimed.status, "claimed")
  })
})

test("policy revision changes suspend rather than silently upgrade a lease", async () => {
  await withStores(async store => {
    const claimed = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "production-operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    const lease =
      claimed.outcome === "claimed"
        ? claimed.lease
        : assert.fail("missing lease")
    const heartbeat = await Effect.runPromise(
      store.heartbeat({
        leaseId: lease.id,
        agentId: "agent-a",
        policyDigest: "p2",
        now: 1_100,
        ttlMs: 10_000,
      }),
    )
    assert.equal(heartbeat.status, "suspended")
    assert.equal(heartbeat.reason, "policy_changed")
  })
})

test("session start rebinds an owned suspended lease to the newly loaded policy", async () => {
  await withStores(async store => {
    const initial = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    assert.equal(initial.outcome, "claimed")
    const suspended = await Effect.runPromise(
      store.heartbeat({
        leaseId: initial.lease.id,
        agentId: "agent-a",
        policyDigest: "p2",
        now: 1_010,
        ttlMs: 10_000,
      }),
    )
    assert.equal(suspended.status, "suspended")

    const rebound = await Effect.runPromise(
      reconcileSessionLease({
        store,
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p2",
        now: 1_020,
        ttlMs: 10_000,
      }),
    )
    assert.equal(rebound.outcome, "claimed")
    assert.notEqual(rebound.lease.id, initial.lease.id)
    assert.equal(rebound.lease.policyDigest, "p2")
    assert.equal(rebound.lease.status, "active")
  })
})

test("manual pause stops authorization and can resume only before expiry under the same policy", async () => {
  await withStores(async store => {
    const claimed = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 100,
      }),
    )
    const lease =
      claimed.outcome === "claimed"
        ? claimed.lease
        : assert.fail("missing lease")
    const paused = await Effect.runPromise(
      store.pause({ leaseId: lease.id, agentId: "agent-a", now: 1_010 }),
    )
    assert.equal(paused.status, "paused")
    const queued = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "wait",
        now: 1_011,
      }),
    )
    await assert.rejects(
      Effect.runPromise(
        store.claimRequest({
          requestId: queued.id,
          leaseId: lease.id,
          agentId: "agent-a",
          now: 1_012,
        }),
      ),
      /stale|invalid lease/i,
    )
    const resumed = await Effect.runPromise(
      store.resume({
        leaseId: lease.id,
        agentId: "agent-a",
        policyDigest: "p1",
        now: 1_020,
        ttlMs: 100,
      }),
    )
    assert.equal(resumed.status, "active")
  })
})

test("operational leases remain live with an empty inbox until explicit release", async () => {
  await withStores(async store => {
    const claimed = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    const lease =
      claimed.outcome === "claimed"
        ? claimed.lease
        : assert.fail("missing lease")
    assert.equal(
      (await Effect.runPromise(store.snapshot(2_000))).leases[0]?.status,
      "active",
    )
    await Effect.runPromise(
      store.release({ leaseId: lease.id, agentId: "agent-a", now: 2_001 }),
    )
    assert.equal(
      (await Effect.runPromise(store.snapshot(2_001))).leases.length,
      0,
    )
  })
})

test("administrative clear is atomic and preserves only the selected project tree", async () => {
  await withStores(async store => {
    const yielduck = "/workspace/dataclique/yielduck"
    await Effect.runPromise(
      store.heartbeatAgent({
        agent: agent("agent-a"),
        cwd: yielduck,
        label: "Yielduck",
        usage,
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    await Effect.runPromise(
      store.heartbeatAgent({
        agent: agent("agent-b"),
        cwd: "/workspace/config",
        label: "Config",
        usage,
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: `${yielduck}/worker`,
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    await Effect.runPromise(
      store.claim({
        agent: agent("agent-b"),
        project: "/workspace/config",
        role: "pi-support",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    await Effect.runPromise(
      store.enqueue({
        project: yielduck,
        role: "operator",
        requesterId: "requester",
        text: "preserve",
        now: 1_010,
      }),
    )
    await Effect.runPromise(
      store.enqueue({
        project: "/workspace/config",
        role: "pi-support",
        requesterId: "requester",
        text: "clear",
        now: 1_011,
      }),
    )

    const cleared = await Effect.runPromise(
      store.clearExceptProject({ preservedProject: yielduck, now: 1_020 }),
    )
    assert.deepEqual(cleared, { agents: 1, leases: 1, requests: 1 })
    const snapshot = await Effect.runPromise(store.snapshot(1_020))
    assert.deepEqual(
      snapshot.agents?.map(({ cwd }) => cwd),
      [yielduck],
    )
    assert.deepEqual(
      snapshot.leases.map(({ project }) => project),
      [`${yielduck}/worker`],
    )
    assert.deepEqual(
      snapshot.requests.map(({ project }) => project),
      [yielduck],
    )
  })
})

test("administrative clear does not preserve lookalike path prefixes", async () => {
  await withStores(async store => {
    await Effect.runPromise(
      store.enqueue({
        project: "/workspace/yielduck-evil",
        role: "operator",
        requesterId: "requester",
        text: "remove",
        now: 1_000,
      }),
    )
    await Effect.runPromise(
      store.clearExceptProject({
        preservedProject: "/workspace/yielduck",
        now: 1_001,
      }),
    )
    assert.equal(
      (await Effect.runPromise(store.snapshot(1_001))).requests.length,
      0,
    )
  })
})

test("every Pi session publishes ephemeral fleet presence without claiming a role", async () => {
  await withStores(async store => {
    const presence = await Effect.runPromise(
      store.heartbeatAgent({
        agent: {
          ...agent("observer-a"),
          runtimeVersions: { questions: "2026.07.23.2" },
        },
        cwd: "/workspace/review",
        label: "PR reviewer",
        usage,
        activities: [
          {
            todoId: 7,
            status: "in_progress",
            text: "Review active pull request",
          },
        ],
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    assert.equal(presence.label, "PR reviewer")
    assert.equal(presence.cwd, "/workspace/review")
    assert.deepEqual(presence.usage, usage)
    assert.deepEqual(presence.activities, [
      { todoId: 7, status: "in_progress", text: "Review active pull request" },
    ])
    const snapshot = await Effect.runPromise(store.snapshot(1_001))
    assert.equal(snapshot.agents?.length, 1)
    assert.deepEqual(snapshot.agents?.[0]?.identity.runtimeVersions, {
      questions: "2026.07.23.2",
    })
    assert.deepEqual(snapshot.agents?.[0]?.usage, usage)
    assert.deepEqual(snapshot.agents?.[0]?.activities, [
      { todoId: 7, status: "in_progress", text: "Review active pull request" },
    ])
    assert.equal(snapshot.leases.length, 0)
    assert.equal(
      (await Effect.runPromise(store.snapshot(11_001))).agents?.length,
      0,
    )
  })
})

test("two live processes resumed from one session keep distinct presence and migrate the original lease owner", async () => {
  await withStores(async store => {
    const sessionId = "shared-session"
    const firstLegacy = { id: sessionId, pid: 111 }
    const secondLegacy = { id: sessionId, pid: 222 }
    const firstRuntimeId = runtimeAgentId(sessionId, firstLegacy.pid)
    const secondRuntimeId = runtimeAgentId(sessionId, secondLegacy.pid)
    const heartbeat = async (identity: AgentIdentity, now: number) =>
      Effect.runPromise(
        store.heartbeatAgent({
          agent: identity,
          cwd: "/workspace/st0x",
          label: "st0x",
          usage,
          now,
          ttlMs: 10_000,
        }),
      )

    await heartbeat(firstLegacy, 1_000)
    const claimed = await Effect.runPromise(
      store.claim({
        agent: firstLegacy,
        project: "/workspace/st0x",
        role: "reviewer",
        mode: "operational",
        policyDigest: "p1",
        now: 1_001,
        ttlMs: 10_000,
      }),
    )
    const lease =
      claimed.outcome === "claimed"
        ? claimed.lease
        : assert.fail("missing lease")
    const queued = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/st0x",
        role: "reviewer",
        requesterId: "requester-session",
        text: "review current PR",
        now: 1_002,
      }),
    )
    await Effect.runPromise(
      store.claimRequest({
        requestId: queued.id,
        leaseId: lease.id,
        agentId: sessionId,
        now: 1_003,
      }),
    )

    await heartbeat(secondLegacy, 1_004)
    await heartbeat({ id: secondRuntimeId, pid: secondLegacy.pid }, 1_005)
    await heartbeat({ id: firstRuntimeId, pid: firstLegacy.pid }, 1_006)

    const snapshot = await Effect.runPromise(store.snapshot(1_007))
    assert.deepEqual(
      snapshot.agents.map(({ identity }) => identity.id).sort(),
      [firstRuntimeId, secondRuntimeId].sort(),
    )
    assert.equal(snapshot.leases[0]?.owner.id, firstRuntimeId)
    assert.equal(snapshot.requests[0]?.status, "claimed")
    if (snapshot.requests[0]?.status !== "claimed")
      assert.fail("request must remain claimed")
    assert.equal(snapshot.requests[0].agentId, firstRuntimeId)
    assert.equal(snapshot.requests[0].requesterId, "requester-session")
  })
})

test("lease heartbeats publish bounded component versions for fleet diagnostics", async () => {
  await withStores(async store => {
    const claimed = await Effect.runPromise(
      store.claim({
        agent: {
          ...agent("agent-a"),
          runtimeVersions: { "classified-workflows": "2026.07.23.1" },
        },
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    const updated = await Effect.runPromise(
      store.heartbeat({
        leaseId: claimed.lease.id,
        agentId: "agent-a",
        policyDigest: "p1",
        runtimeVersions: {
          "classified-workflows": "2026.07.23.2",
          "todo": "2026.07.23.2",
        },
        now: 2_000,
        ttlMs: 10_000,
      }),
    )
    assert.deepEqual(updated.owner.runtimeVersions, {
      "classified-workflows": "2026.07.23.2",
      "todo": "2026.07.23.2",
    })
    const snapshot = await Effect.runPromise(store.snapshot(2_001))
    assert.deepEqual(
      snapshot.leases[0]?.owner.runtimeVersions,
      updated.owner.runtimeVersions,
    )
  })
})

test("request receipt is durable, lease-bound, and distinct from explicit acknowledgement", async () => {
  await withStores(async store => {
    const claimedLease = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 100,
      }),
    )
    const lease =
      claimedLease.outcome === "claimed"
        ? claimedLease.lease
        : assert.fail("missing lease")
    const queued = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "inspect health",
        now: 1_010,
      }),
    )

    const received = await Effect.runPromise(
      store.receiveRequest({
        requestId: queued.id,
        leaseId: lease.id,
        agentId: "agent-a",
        now: 1_020,
      }),
    )
    assert.equal(received.status, "queued")
    assert.equal(received.recipientReceivedAt, 1_020)
    assert.equal(received.recipientAgentId, "agent-a")
    assert.equal(received.recipientLeaseId, lease.id)

    const duplicate = await Effect.runPromise(
      store.receiveRequest({
        requestId: queued.id,
        leaseId: lease.id,
        agentId: "agent-a",
        now: 1_021,
      }),
    )
    assert.equal(duplicate.recipientReceivedAt, 1_020)

    await assert.rejects(
      Effect.runPromise(
        store.receiveRequest({
          requestId: queued.id,
          leaseId: lease.id,
          agentId: "agent-a",
          now: 1_101,
        }),
      ),
      /stale|lease/i,
    )

    const replacementClaim = await Effect.runPromise(
      store.claim({
        agent: agent("agent-b"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_101,
        ttlMs: 100,
      }),
    )
    const replacement =
      replacementClaim.outcome === "claimed"
        ? replacementClaim.lease
        : assert.fail("missing replacement lease")
    const rereceived = await Effect.runPromise(
      store.receiveRequest({
        requestId: queued.id,
        leaseId: replacement.id,
        agentId: "agent-b",
        now: 1_102,
      }),
    )
    assert.equal(rereceived.recipientReceivedAt, 1_102)
    assert.equal(rereceived.recipientAgentId, "agent-b")
    assert.equal(rereceived.recipientLeaseId, replacement.id)

    const acknowledged = await Effect.runPromise(
      store.claimRequest({
        requestId: queued.id,
        leaseId: replacement.id,
        agentId: "agent-b",
        now: 1_103,
      }),
    )
    assert.equal(acknowledged.status, "claimed")
    assert.equal(acknowledged.recipientReceivedAt, 1_102)
  })
})

test("a live lease cannot receive a request for another role", async () => {
  await withStores(async store => {
    const claimedLease = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 100,
      }),
    )
    const lease =
      claimedLease.outcome === "claimed"
        ? claimedLease.lease
        : assert.fail("missing lease")
    const queued = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "reviewer",
        requesterId: "requester",
        text: "review",
        now: 1_010,
      }),
    )
    await assert.rejects(
      Effect.runPromise(
        store.receiveRequest({
          requestId: queued.id,
          leaseId: lease.id,
          agentId: "agent-a",
          now: 1_020,
        }),
      ),
      /does not own the request role/i,
    )
  })
})

test("acknowledged request history stays durable without entering operational snapshots", async () => {
  await withStores(async (store, _second, root) => {
    const claimedLease = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "pi-support",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    const lease =
      claimedLease.outcome === "claimed"
        ? claimedLease.lease
        : assert.fail("missing lease")
    const queued = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "pi-support",
        requesterId: "requester",
        requesterLabel: "st0x PR reviewer",
        requesterCwd: "/workspace/st0x.rest.api",
        text: "fix classifier",
        now: 1_010,
      }),
    )
    const claimed = await Effect.runPromise(
      store.claimRequest({
        requestId: queued.id,
        leaseId: lease.id,
        agentId: "agent-a",
        now: 1_020,
      }),
    )
    assert.equal(claimed.status, "claimed")
    const completed = await Effect.runPromise(
      store.completeRequest({
        requestId: queued.id,
        leaseId: lease.id,
        agentId: "agent-a",
        summary: "fixed and tested",
        now: 1_030,
      }),
    )
    assert.equal(completed.status, "completed")
    const awaitingAcknowledgement = await Effect.runPromise(
      store.snapshot(1_030),
    )
    assert.equal(awaitingAcknowledgement.requests[0]?.status, "completed")
    assert.equal(
      awaitingAcknowledgement.requests[0]?.requesterAcknowledgedAt,
      undefined,
    )
    const acknowledged = await Effect.runPromise(
      store.acknowledgeRequest({
        requestId: queued.id,
        requesterId: "requester",
        now: 1_040,
      }),
    )
    assert.equal(acknowledged.requesterAcknowledgedAt, 1_040)
    const snapshot = await Effect.runPromise(store.snapshot(1_040))
    assert.deepEqual(snapshot.requests, [])

    const persisted = new DatabaseSync(join(root, "registry.sqlite"), {
      readOnly: true,
    })
      .prepare(
        "SELECT status, requester_acknowledged_at, requester_label, requester_cwd FROM requests WHERE request_id = ?",
      )
      .get(queued.id)
    assert.equal(persisted?.status, "completed")
    assert.equal(persisted?.requester_acknowledged_at, 1_040)
    assert.equal(persisted?.requester_label, "st0x PR reviewer")
    assert.equal(persisted?.requester_cwd, "/workspace/st0x.rest.api")
  })
})

test("dot-quoted SQL JSONPath keys remain relayable while credential file paths stay protected", async () => {
  await withStores(async store => {
    const claimedLease = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "pi-support",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    const lease =
      claimedLease.outcome === "claimed"
        ? claimedLease.lease
        : assert.fail("missing lease")
    const protectedLookingKey = ["credentials", "json"].join(".")
    const quote = String.fromCharCode(34)
    const diagnostic = `SQL JSONPath $.state.${quote}${protectedLookingKey}${quote} triggered a false path match`
    const queued = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "pi-support",
        requesterId: "requester",
        text: diagnostic,
        now: 1_010,
      }),
    )
    await Effect.runPromise(
      store.claimRequest({
        requestId: queued.id,
        leaseId: lease.id,
        agentId: "agent-a",
        now: 1_020,
      }),
    )
    const completed = await Effect.runPromise(
      store.completeRequest({
        requestId: queued.id,
        leaseId: lease.id,
        agentId: "agent-a",
        summary: diagnostic,
        now: 1_030,
      }),
    )
    assert.equal(completed.summary, diagnostic)
  })
})

test("terminal request transitions are first-writer-wins", async () => {
  await withStores(async store => {
    const claimedLease = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    const lease =
      claimedLease.outcome === "claimed"
        ? claimedLease.lease
        : assert.fail("missing lease")
    const queued = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "race",
        now: 1_010,
      }),
    )
    await Effect.runPromise(
      store.claimRequest({
        requestId: queued.id,
        leaseId: lease.id,
        agentId: "agent-a",
        now: 1_020,
      }),
    )
    const cancelled = await Effect.runPromise(
      store.cancelRequest({
        requestId: queued.id,
        requesterId: "requester",
        now: 1_030,
      }),
    )
    assert.equal(cancelled.status, "cancelled")
    await assert.rejects(
      Effect.runPromise(
        store.completeRequest({
          requestId: queued.id,
          leaseId: lease.id,
          agentId: "agent-a",
          summary: "too late",
          now: 1_030,
        }),
      ),
      /terminal|claimed|transition/i,
    )
  })
})

test("expired leases are purged before capacity checks and expiration arithmetic stays safe", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(store.snapshot(0))
    const database = new DatabaseSync(join(root, "registry.sqlite"))
    const insert = database.prepare(`INSERT INTO leases (
      project, role, lease_id, mode, owner_id, owner_pid, policy_digest,
      acquired_at, heartbeat_at, expires_at, status
    ) VALUES (?, ?, ?, 'task', 'old', 1, 'p1', 0, 0, 1, 'active')`)
    database.exec("BEGIN IMMEDIATE")
    for (let index = 0; index < 1_024; index += 1) {
      insert.run(`/workspace/${index}`, `role-${index}`, `lease-${index}`)
    }
    database.exec("COMMIT")
    database.close()

    const claimed = await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/new",
        role: "operator",
        mode: "task",
        policyDigest: "p1",
        now: 2,
        ttlMs: 100,
      }),
    )
    assert.equal(claimed.outcome, "claimed")
    await assert.rejects(
      Effect.runPromise(
        store.claim({
          agent: agent("agent-b"),
          project: "/workspace/unsafe",
          role: "operator",
          mode: "task",
          policyDigest: "p1",
          now: Number.MAX_SAFE_INTEGER,
          ttlMs: 1,
        }),
      ),
      /safe time range/i,
    )
  })
})

test("store construction defers filesystem failures into the Effect error channel", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-agent-registry-bad-root-"))
  const root = join(parent, "not-a-directory")
  await writeFile(root, "occupied")
  try {
    const store = makeSqliteRegistryStore(root)
    try {
      await assert.rejects(
        Effect.runPromise(store.snapshot(0)),
        /Could not read registry/i,
      )
    } finally {
      store.close()
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("legacy v1 databases migrate requester acknowledgements and source identity before sync", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(store.snapshot(0))
    store.close()
    const legacy = new DatabaseSync(join(root, "registry.sqlite"))
    legacy.exec(`
      ALTER TABLE requests DROP COLUMN requester_acknowledged_at;
      ALTER TABLE requests DROP COLUMN requester_label;
      ALTER TABLE requests DROP COLUMN requester_cwd;
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const reopened = makeSqliteRegistryStore(root)
    try {
      await Effect.runPromise(reopened.snapshot(1))
      const migrated = new DatabaseSync(join(root, "registry.sqlite"), {
        readOnly: true,
      })
      assert.equal(
        migrated.prepare("PRAGMA user_version").get()?.user_version,
        5,
      )
      const columns = migrated
        .prepare("PRAGMA table_info(requests)")
        .all()
        .map(column => column.name)
      assert.ok(columns.includes("requester_acknowledged_at"))
      assert.ok(columns.includes("requester_label"))
      assert.ok(columns.includes("requester_cwd"))
      assert.ok(columns.includes("recipient_received_at"))
      assert.ok(columns.includes("recipient_agent_id"))
      assert.ok(columns.includes("recipient_lease_id"))
      assert.ok(columns.includes("priority"))
      const leaseColumns = migrated
        .prepare("PRAGMA table_info(leases)")
        .all()
        .map(column => column.name)
      assert.ok(leaseColumns.includes("runtime_versions"))
      assert.ok(
        migrated
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'",
          )
          .get(),
      )
      migrated.close()
    } finally {
      reopened.close()
    }
  })
})

test("rolling v3 state migrates additively to agent activities", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(store.snapshot(0))
    store.close()
    const transitional = new DatabaseSync(join(root, "registry.sqlite"))
    transitional.exec("PRAGMA user_version = 3;")
    transitional.close()

    const reopened = makeSqliteRegistryStore(root)
    try {
      await Effect.runPromise(reopened.snapshot(1))
      const compatible = new DatabaseSync(join(root, "registry.sqlite"), {
        readOnly: true,
      })
      assert.equal(
        compatible.prepare("PRAGMA user_version").get()?.user_version,
        5,
      )
      const columns = compatible
        .prepare("PRAGMA table_info(requests)")
        .all()
        .map(column => column.name)
      assert.ok(columns.includes("requester_label"))
      assert.ok(columns.includes("requester_cwd"))
      const agentColumns = compatible
        .prepare("PRAGMA table_info(agents)")
        .all()
        .map(column => column.name)
      assert.ok(agentColumns.includes("activities"))
      compatible.close()
    } finally {
      reopened.close()
    }
  })
})

test("request priority defaults to normal and urgent survives persistence", async () => {
  await withStores(async store => {
    const normal = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "normal",
        now: 1_000,
      }),
    )
    const urgent = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "urgent",
        priority: "urgent",
        now: 1_001,
      }),
    )
    assert.equal(normal.priority, "normal")
    assert.equal(urgent.priority, "urgent")
    const snapshot = await Effect.runPromise(store.snapshot(1_002))
    assert.equal(
      snapshot.requests.find(({ id }) => id === normal.id)?.priority,
      "normal",
    )
    assert.equal(
      snapshot.requests.find(({ id }) => id === urgent.id)?.priority,
      "urgent",
    )
  })
})

test("partial request receipt metadata fails closed", async () => {
  await withStores(async (store, _second, root) => {
    const queued = await Effect.runPromise(
      store.enqueue({
        project: "/workspace/project",
        role: "operator",
        requesterId: "requester",
        text: "inspect",
        now: 1_000,
      }),
    )
    const database = new DatabaseSync(join(root, "registry.sqlite"))
    database
      .prepare(
        "UPDATE requests SET recipient_received_at = ? WHERE request_id = ?",
      )
      .run(1_001, queued.id)
    database.close()
    await assert.rejects(
      Effect.runPromise(store.snapshot(1_002)),
      /request receipt is malformed/i,
    )
  })
})

test("malformed input and unknown schema versions fail closed", async () => {
  await withStores(async (store, _second, root) => {
    await assert.rejects(
      Effect.runPromise(
        store.claim({
          agent: agent("agent-a"),
          project: "/workspace/project",
          role: "../../prod",
          mode: "task",
          policyDigest: "p1",
          now: 1_000,
          ttlMs: 10_000,
        }),
      ),
      /role must match/i,
    )
    await assert.rejects(
      Effect.runPromise(
        store.claim({
          agent: null as unknown as AgentIdentity,
          project: "/workspace/project",
          role: "operator",
          mode: "task",
          policyDigest: "p1",
          now: 1_000,
          ttlMs: 10_000,
        }),
      ),
      /agent identity is malformed/i,
    )
    await assert.rejects(
      Effect.runPromise(
        store.heartbeatAgent({
          agent: agent("agent-a"),
          cwd: "/workspace/project",
          label: "agent-a",
          usage: {
            wrong: 1,
            fields: 2,
            can: 3,
            still: 4,
            pass: 5,
          } as unknown as AgentTokenUsage,
          activities: {} as unknown as readonly AgentActivity[],
          now: 1_000,
          ttlMs: 10_000,
        }),
      ),
      /token usage is malformed/i,
    )
    await assert.rejects(
      Effect.runPromise(
        store.enqueue({
          project: "/workspace/project",
          role: "operator",
          requesterId: "requester",
          text: "read .env.production",
          now: 1_000,
        }),
      ),
      /protected credential-shaped path/i,
    )
    await assert.rejects(
      Effect.runPromise(
        store.enqueue({
          project: "/workspace/project",
          role: "operator",
          requesterId: "requester",
          text: "wake",
          priority: "critical" as "urgent",
          now: 1_000,
        }),
      ),
      /priority is malformed/i,
    )
    await Effect.runPromise(store.snapshot(1_000))
    store.close()
    const database = new DatabaseSync(join(root, "registry.sqlite"))
    database.exec("PRAGMA user_version = 99")
    database.close()
    const reopened = makeSqliteRegistryStore(root)
    try {
      await assert.rejects(
        Effect.runPromise(reopened.snapshot(1_000)),
        /schema version 99/i,
      )
    } finally {
      reopened.close()
    }
  })
})

test("SQLite adapter commits complete versioned state", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(
      store.claim({
        agent: agent("agent-a"),
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    )
    const database = new DatabaseSync(join(root, "registry.sqlite"), {
      readOnly: true,
    })
    try {
      assert.equal(
        database.prepare("PRAGMA user_version").get()?.user_version,
        5,
      )
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM leases").get()?.count,
        1,
      )
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM requests").get()?.count,
        0,
      )
    } finally {
      database.close()
    }
  })
})
