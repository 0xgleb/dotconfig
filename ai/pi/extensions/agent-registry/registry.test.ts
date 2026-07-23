import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { makeSqliteRegistryStore } from "./sqlite-store.ts";
import {
  reconcileSessionLease,
  RegistryError,
  runRegistryEffect,
  type AgentIdentity,
  type RegistryStore,
} from "./registry.ts";

const withStores: (
  run: (first: RegistryStore, second: RegistryStore, root: string) => Promise<void>,
) => Promise<void> = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-registry-test-"));
  try {
    await run(makeSqliteRegistryStore(root), makeSqliteRegistryStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const workerPath = new URL("./test-fixtures/registry-worker.ts", import.meta.url).pathname;

const runWorker: (root: string, agentId: string) => Promise<string> = (root, agentId) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, "claim", root, agentId], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`registry worker exited ${code}: ${stderr.slice(-1_000)}`));
    });
  });

const agent: (id: string) => AgentIdentity = (id) => ({
  id,
  pid: id === "agent-a" ? 101 : 202,
  model: "openai-codex/gpt-5.6-sol",
});

test("registry Effect runner preserves typed operational failures", async () => {
  const failure = new RegistryError({ code: "busy", message: "registry is busy" });
  await assert.rejects(runRegistryEffect(Effect.fail(failure)), (error) => error === failure);
});

test("current schema reads do not acquire write locks during fleet heartbeats", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(store.snapshot(0));
    const writer = new DatabaseSync(join(root, "registry.sqlite"));
    writer.exec("BEGIN IMMEDIATE");
    try {
      const snapshot = await Effect.runPromise(store.snapshot(1));
      assert.equal(snapshot.version, 1);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});

test("concurrent claims produce exactly one exclusive role owner", async () => {
  await withStores(async (first, second) => {
    const claims = await Promise.all([
      Effect.runPromise(
        first.claim({ agent: agent("agent-a"), project: "/workspace/project", role: "staging-operator", mode: "operational", policyDigest: "policy-a", now: 1_000, ttlMs: 10_000 }),
      ),
      Effect.runPromise(
        second.claim({ agent: agent("agent-b"), project: "/workspace/project", role: "staging-operator", mode: "operational", policyDigest: "policy-a", now: 1_000, ttlMs: 10_000 }),
      ),
    ]);
    assert.equal(claims.filter(({ outcome }) => outcome === "claimed").length, 1);
    assert.equal(claims.filter(({ outcome }) => outcome === "already_owned").length, 1);
    const snapshot = await Effect.runPromise(first.snapshot(1_000));
    assert.equal(snapshot.leases.length, 1);
  });
});

test("separate Pi processes serialize concurrent claims", async () => {
  await withStores(async (_first, _second, root) => {
    const outputs = await Promise.all([runWorker(root, "process-a"), runWorker(root, "process-b")]);
    const outcomes = outputs.map((output) => JSON.parse(output).outcome).sort();
    assert.deepEqual(outcomes, ["already_owned", "claimed"]);
  });
});

test("a killed SQLite writer rolls back before another process proceeds", async () => {
  await withStores(async (store, _second, root) => {
    const child = spawn(process.execPath, [workerPath, "crash-transaction", root], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => reject(new Error(`crash worker exited before READY with ${code}`)));
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("READY")) resolve();
      });
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
    const snapshot = await Effect.runPromise(store.snapshot(1_000));
    assert.equal(snapshot.leases.some(({ role }) => role === "crashed"), false);
  });
});

test("one agent holds multiple roles while a live lease cannot be stolen", async () => {
  await withStores(async (store) => {
    const owner = agent("agent-a");
    const first = await Effect.runPromise(
      store.claim({ agent: owner, project: "/workspace/project", role: "engineering", mode: "task", policyDigest: "p1", now: 1_000, ttlMs: 10_000 }),
    );
    const second = await Effect.runPromise(
      store.claim({ agent: owner, project: "/workspace/project", role: "staging-operator", mode: "operational", policyDigest: "p1", now: 1_000, ttlMs: 10_000 }),
    );
    const rejected = await Effect.runPromise(
      store.claim({ agent: agent("agent-b"), project: "/workspace/project", role: "engineering", mode: "task", policyDigest: "p1", now: 1_001, ttlMs: 10_000 }),
    );
    assert.equal(first.outcome, "claimed");
    assert.equal(second.outcome, "claimed");
    assert.equal(rejected.outcome, "already_owned");
  });
});

test("expired leases are reclaimable but stale owners cannot mutate requests", async () => {
  await withStores(async (store) => {
    const firstClaim = await Effect.runPromise(
      store.claim({ agent: agent("agent-a"), project: "/workspace/project", role: "operator", mode: "operational", policyDigest: "p1", now: 1_000, ttlMs: 100 }),
    );
    assert.equal(firstClaim.outcome, "claimed");
    const leaseA = firstClaim.outcome === "claimed" ? firstClaim.lease : assert.fail("missing lease");

    const request = await Effect.runPromise(
      store.enqueue({ project: "/workspace/project", role: "operator", requesterId: "requester", text: "inspect health", now: 1_010 }),
    );
    await Effect.runPromise(
      store.claimRequest({ requestId: request.id, leaseId: leaseA.id, agentId: "agent-a", now: 1_011 }),
    );
    const secondClaim = await Effect.runPromise(
      store.claim({ agent: agent("agent-b"), project: "/workspace/project", role: "operator", mode: "operational", policyDigest: "p1", now: 1_101, ttlMs: 100 }),
    );
    assert.equal(secondClaim.outcome, "claimed");
    const leaseB = secondClaim.outcome === "claimed" ? secondClaim.lease : assert.fail("missing replacement lease");

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
    );
    const claimed = await Effect.runPromise(
      store.claimRequest({ requestId: request.id, leaseId: leaseB.id, agentId: "agent-b", now: 1_102 }),
    );
    assert.equal(claimed.status, "claimed");
  });
});

test("policy revision changes suspend rather than silently upgrade a lease", async () => {
  await withStores(async (store) => {
    const claimed = await Effect.runPromise(
      store.claim({ agent: agent("agent-a"), project: "/workspace/project", role: "production-operator", mode: "operational", policyDigest: "p1", now: 1_000, ttlMs: 10_000 }),
    );
    const lease = claimed.outcome === "claimed" ? claimed.lease : assert.fail("missing lease");
    const heartbeat = await Effect.runPromise(
      store.heartbeat({ leaseId: lease.id, agentId: "agent-a", policyDigest: "p2", now: 1_100, ttlMs: 10_000 }),
    );
    assert.equal(heartbeat.status, "suspended");
    assert.equal(heartbeat.reason, "policy_changed");
  });
});

test("session start rebinds an owned suspended lease to the newly loaded policy", async () => {
  await withStores(async (store) => {
    const initial = await Effect.runPromise(
      store.claim({ agent: agent("agent-a"), project: "/workspace/project", role: "operator", mode: "operational", policyDigest: "p1", now: 1_000, ttlMs: 10_000 }),
    );
    assert.equal(initial.outcome, "claimed");
    const suspended = await Effect.runPromise(
      store.heartbeat({ leaseId: initial.lease.id, agentId: "agent-a", policyDigest: "p2", now: 1_010, ttlMs: 10_000 }),
    );
    assert.equal(suspended.status, "suspended");

    const rebound = await Effect.runPromise(
      reconcileSessionLease({ store, agent: agent("agent-a"), project: "/workspace/project", role: "operator", mode: "operational", policyDigest: "p2", now: 1_020, ttlMs: 10_000 }),
    );
    assert.equal(rebound.outcome, "claimed");
    assert.notEqual(rebound.lease.id, initial.lease.id);
    assert.equal(rebound.lease.policyDigest, "p2");
    assert.equal(rebound.lease.status, "active");
  });
});

test("manual pause stops authorization and can resume only before expiry under the same policy", async () => {
  await withStores(async (store) => {
    const claimed = await Effect.runPromise(
      store.claim({ agent: agent("agent-a"), project: "/workspace/project", role: "operator", mode: "operational", policyDigest: "p1", now: 1_000, ttlMs: 100 }),
    );
    const lease = claimed.outcome === "claimed" ? claimed.lease : assert.fail("missing lease");
    const paused = await Effect.runPromise(store.pause({ leaseId: lease.id, agentId: "agent-a", now: 1_010 }));
    assert.equal(paused.status, "paused");
    const queued = await Effect.runPromise(
      store.enqueue({ project: "/workspace/project", role: "operator", requesterId: "requester", text: "wait", now: 1_011 }),
    );
    await assert.rejects(
      Effect.runPromise(store.claimRequest({ requestId: queued.id, leaseId: lease.id, agentId: "agent-a", now: 1_012 })),
      /stale|invalid lease/i,
    );
    const resumed = await Effect.runPromise(
      store.resume({ leaseId: lease.id, agentId: "agent-a", policyDigest: "p1", now: 1_020, ttlMs: 100 }),
    );
    assert.equal(resumed.status, "active");
  });
});

test("operational leases remain live with an empty inbox until explicit release", async () => {
  await withStores(async (store) => {
    const claimed = await Effect.runPromise(
      store.claim({ agent: agent("agent-a"), project: "/workspace/project", role: "operator", mode: "operational", policyDigest: "p1", now: 1_000, ttlMs: 10_000 }),
    );
    const lease = claimed.outcome === "claimed" ? claimed.lease : assert.fail("missing lease");
    assert.equal((await Effect.runPromise(store.snapshot(2_000))).leases[0]?.status, "active");
    await Effect.runPromise(store.release({ leaseId: lease.id, agentId: "agent-a", now: 2_001 }));
    assert.equal((await Effect.runPromise(store.snapshot(2_001))).leases.length, 0);
  });
});

test("every Pi session publishes ephemeral fleet presence without claiming a role", async () => {
  await withStores(async (store) => {
    const presence = await Effect.runPromise(
      store.heartbeatAgent({
        agent: { ...agent("observer-a"), runtimeVersions: { questions: "2026.07.23.2" } },
        cwd: "/workspace/review",
        label: "PR reviewer",
        now: 1_000,
        ttlMs: 10_000,
      }),
    );
    assert.equal(presence.label, "PR reviewer");
    assert.equal(presence.cwd, "/workspace/review");
    const snapshot = await Effect.runPromise(store.snapshot(1_001));
    assert.equal(snapshot.agents?.length, 1);
    assert.deepEqual(snapshot.agents?.[0]?.identity.runtimeVersions, { questions: "2026.07.23.2" });
    assert.equal(snapshot.leases.length, 0);
    assert.equal((await Effect.runPromise(store.snapshot(11_001))).agents?.length, 0);
  });
});

test("lease heartbeats publish bounded component versions for fleet diagnostics", async () => {
  await withStores(async (store) => {
    const claimed = await Effect.runPromise(
      store.claim({
        agent: { ...agent("agent-a"), runtimeVersions: { "classified-workflows": "2026.07.23.1" } },
        project: "/workspace/project",
        role: "operator",
        mode: "operational",
        policyDigest: "p1",
        now: 1_000,
        ttlMs: 10_000,
      }),
    );
    const updated = await Effect.runPromise(
      store.heartbeat({
        leaseId: claimed.lease.id,
        agentId: "agent-a",
        policyDigest: "p1",
        runtimeVersions: { "classified-workflows": "2026.07.23.2", todo: "2026.07.23.2" },
        now: 2_000,
        ttlMs: 10_000,
      }),
    );
    assert.deepEqual(updated.owner.runtimeVersions, {
      "classified-workflows": "2026.07.23.2",
      todo: "2026.07.23.2",
    });
    const snapshot = await Effect.runPromise(store.snapshot(2_001));
    assert.deepEqual(snapshot.leases[0]?.owner.runtimeVersions, updated.owner.runtimeVersions);
  });
});

test("request lifecycle is durable and terminal transitions require the current lease", async () => {
  await withStores(async (store) => {
    const claimedLease = await Effect.runPromise(
      store.claim({ agent: agent("agent-a"), project: "/workspace/project", role: "pi-support", mode: "operational", policyDigest: "p1", now: 1_000, ttlMs: 10_000 }),
    );
    const lease = claimedLease.outcome === "claimed" ? claimedLease.lease : assert.fail("missing lease");
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
    );
    const claimed = await Effect.runPromise(
      store.claimRequest({ requestId: queued.id, leaseId: lease.id, agentId: "agent-a", now: 1_020 }),
    );
    assert.equal(claimed.status, "claimed");
    const completed = await Effect.runPromise(
      store.completeRequest({ requestId: queued.id, leaseId: lease.id, agentId: "agent-a", summary: "fixed and tested", now: 1_030 }),
    );
    assert.equal(completed.status, "completed");
    const acknowledged = await Effect.runPromise(
      store.acknowledgeRequest({ requestId: queued.id, requesterId: "requester", now: 1_040 }),
    );
    assert.equal(acknowledged.requesterAcknowledgedAt, 1_040);
    const snapshot = await Effect.runPromise(store.snapshot(1_040));
    assert.equal(snapshot.requests[0]?.status, "completed");
    assert.equal(snapshot.requests[0]?.requesterAcknowledgedAt, 1_040);
    assert.equal(snapshot.requests[0]?.requesterLabel, "st0x PR reviewer");
    assert.equal(snapshot.requests[0]?.requesterCwd, "/workspace/st0x.rest.api");
  });
});

test("terminal request transitions are first-writer-wins", async () => {
  await withStores(async (store) => {
    const claimedLease = await Effect.runPromise(
      store.claim({ agent: agent("agent-a"), project: "/workspace/project", role: "operator", mode: "operational", policyDigest: "p1", now: 1_000, ttlMs: 10_000 }),
    );
    const lease = claimedLease.outcome === "claimed" ? claimedLease.lease : assert.fail("missing lease");
    const queued = await Effect.runPromise(
      store.enqueue({ project: "/workspace/project", role: "operator", requesterId: "requester", text: "race", now: 1_010 }),
    );
    await Effect.runPromise(
      store.claimRequest({ requestId: queued.id, leaseId: lease.id, agentId: "agent-a", now: 1_020 }),
    );
    const cancelled = await Effect.runPromise(
      store.cancelRequest({ requestId: queued.id, requesterId: "requester", now: 1_030 }),
    );
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(
      Effect.runPromise(
        store.completeRequest({ requestId: queued.id, leaseId: lease.id, agentId: "agent-a", summary: "too late", now: 1_030 }),
      ),
      /terminal|claimed|transition/i,
    );
  });
});

test("expired leases are purged before capacity checks and expiration arithmetic stays safe", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(store.snapshot(0));
    const database = new DatabaseSync(join(root, "registry.sqlite"));
    const insert = database.prepare(`INSERT INTO leases (
      project, role, lease_id, mode, owner_id, owner_pid, policy_digest,
      acquired_at, heartbeat_at, expires_at, status
    ) VALUES (?, ?, ?, 'task', 'old', 1, 'p1', 0, 0, 1, 'active')`);
    database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 1_024; index += 1) {
      insert.run(`/workspace/${index}`, `role-${index}`, `lease-${index}`);
    }
    database.exec("COMMIT");
    database.close();

    const claimed = await Effect.runPromise(
      store.claim({ agent: agent("agent-a"), project: "/workspace/new", role: "operator", mode: "task", policyDigest: "p1", now: 2, ttlMs: 100 }),
    );
    assert.equal(claimed.outcome, "claimed");
    await assert.rejects(
      Effect.runPromise(
        store.claim({ agent: agent("agent-b"), project: "/workspace/unsafe", role: "operator", mode: "task", policyDigest: "p1", now: Number.MAX_SAFE_INTEGER, ttlMs: 1 }),
      ),
      /safe time range/i,
    );
  });
});

test("store construction defers filesystem failures into the Effect error channel", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-agent-registry-bad-root-"));
  const root = join(parent, "not-a-directory");
  await writeFile(root, "occupied");
  try {
    const store = makeSqliteRegistryStore(root);
    await assert.rejects(Effect.runPromise(store.snapshot(0)), /Could not read registry/i);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("legacy v1 databases migrate requester acknowledgements and source identity before sync", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(store.snapshot(0));
    const legacy = new DatabaseSync(join(root, "registry.sqlite"));
    legacy.exec(`
      ALTER TABLE requests DROP COLUMN requester_acknowledged_at;
      ALTER TABLE requests DROP COLUMN requester_label;
      ALTER TABLE requests DROP COLUMN requester_cwd;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    await Effect.runPromise(store.snapshot(1));
    const migrated = new DatabaseSync(join(root, "registry.sqlite"), { readOnly: true });
    assert.equal(migrated.prepare("PRAGMA user_version").get()?.user_version, 2);
    const columns = migrated.prepare("PRAGMA table_info(requests)").all().map((column) => column.name);
    assert.ok(columns.includes("requester_acknowledged_at"));
    assert.ok(columns.includes("requester_label"));
    assert.ok(columns.includes("requester_cwd"));
    const leaseColumns = migrated.prepare("PRAGMA table_info(leases)").all().map((column) => column.name);
    assert.ok(leaseColumns.includes("runtime_versions"));
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get());
    migrated.close();
  });
});

test("additive source identity remains readable by rolling v2 sessions", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(store.snapshot(0));
    const transitional = new DatabaseSync(join(root, "registry.sqlite"));
    transitional.exec("PRAGMA user_version = 3;");
    transitional.close();

    await Effect.runPromise(store.snapshot(1));
    const compatible = new DatabaseSync(join(root, "registry.sqlite"), { readOnly: true });
    assert.equal(compatible.prepare("PRAGMA user_version").get()?.user_version, 2);
    const columns = compatible.prepare("PRAGMA table_info(requests)").all().map((column) => column.name);
    assert.ok(columns.includes("requester_label"));
    assert.ok(columns.includes("requester_cwd"));
    compatible.close();
  });
});

test("malformed input and unknown schema versions fail closed", async () => {
  await withStores(async (store, _second, root) => {
    await assert.rejects(
      Effect.runPromise(
        store.claim({ agent: agent("agent-a"), project: "/workspace/project", role: "../../prod", mode: "task", policyDigest: "p1", now: 1_000, ttlMs: 10_000 }),
      ),
      /role must match/i,
    );
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
    );
    await Effect.runPromise(store.snapshot(1_000));
    const database = new DatabaseSync(join(root, "registry.sqlite"));
    database.exec("PRAGMA user_version = 99");
    database.close();
    await assert.rejects(Effect.runPromise(store.snapshot(1_000)), /schema version 99/i);
  });
});

test("SQLite adapter commits complete versioned state", async () => {
  await withStores(async (store, _second, root) => {
    await Effect.runPromise(
      store.claim({ agent: agent("agent-a"), project: "/workspace/project", role: "operator", mode: "operational", policyDigest: "p1", now: 1_000, ttlMs: 10_000 }),
    );
    const database = new DatabaseSync(join(root, "registry.sqlite"), { readOnly: true });
    try {
      assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 2);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM leases").get()?.count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM requests").get()?.count, 0);
    } finally {
      database.close();
    }
  });
});
