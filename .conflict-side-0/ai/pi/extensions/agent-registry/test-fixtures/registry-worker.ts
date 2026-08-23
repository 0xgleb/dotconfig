import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { makeSqliteRegistryStore } from "../sqlite-store.ts";

const [mode, root, agentId] = process.argv.slice(2);
if (!mode || !root) throw new Error("worker mode and root required");

if (mode === "claim") {
  const store = makeSqliteRegistryStore(root);
  const result = await Effect.runPromise(
    store.claim({
      agent: { id: agentId || `worker-${process.pid}`, pid: process.pid },
      project: "/workspace/project",
      role: "operator",
      mode: "operational",
      policyDigest: "p1",
      now: 1_000,
      ttlMs: 10_000,
    }),
  );
  process.stdout.write(`${JSON.stringify({ outcome: result.outcome })}\n`);
} else if (mode === "crash-transaction") {
  const store = makeSqliteRegistryStore(root);
  await Effect.runPromise(store.snapshot(0));
  const database = new DatabaseSync(join(root, "registry.sqlite"));
  database.exec("PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE");
  database
    .prepare(`INSERT INTO leases (
      project, role, lease_id, mode, owner_id, owner_pid, policy_digest,
      acquired_at, heartbeat_at, expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("/workspace/project", "crashed", "crashed-lease", "task", "crashed", process.pid, "p1", 1, 1, 10_000, "active");
  process.stdout.write("READY\n");
  await new Promise(() => undefined);
} else {
  throw new Error(`unknown worker mode ${mode}`);
}
