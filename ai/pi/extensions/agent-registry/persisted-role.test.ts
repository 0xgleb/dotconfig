import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import { Effect, Either } from "effect"
import { makeSqliteRegistryStore } from "./sqlite-store.ts"
import { runtimeAgentId } from "./runtime-identity.ts"
import type { RegistryError } from "./registry.ts"

type Store = ReturnType<typeof makeSqliteRegistryStore>

const fixture = (t: test.TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "pi-persisted-role-"))
  const databasePath = join(root, "registry.sqlite")
  const stores: Store[] = []
  const open = () => {
    const store = makeSqliteRegistryStore(root)
    stores.push(store)

    return store
  }
  const store = open()

  t.after(async () => {
    for (const instance of stores) instance.close()
    await setImmediate()
    rmSync(root, { recursive: true })
  })

  return {
    store,
    project: join(root, "project"),
    reopen: async () => {
      store.close()
      await setImmediate()

      return open()
    },
    database: <T>(use: (database: DatabaseSync) => T): T => {
      const database = new DatabaseSync(databasePath)

      try {
        return use(database)
      } finally {
        database.close()
      }
    },
  }
}

const claim = (store: Store, project: string) =>
  Effect.runPromise(
    store.claim({
      agent: { id: "persisted-role-worker", pid: process.pid },
      project,
      role: "driver-worker",
      mode: "operational",
      policyDigest: "fixture-policy",
      now: 1000,
      ttlMs: 1000,
    }),
  )

const enqueue = (store: Store, project: string) =>
  Effect.runPromise(
    store.enqueue({
      project,
      role: "driver-worker",
      requesterId: "fixture-requester",
      text: "Historical coordination request",
      now: 1010,
    }),
  )

const expectCorruptRole = async <T>(
  operation: Effect.Effect<T, RegistryError>,
  recordId: string,
) => {
  const result = await Effect.runPromise(Effect.either(operation))

  assert.ok(
    Either.isLeft(result),
    "unsupported persisted role must fail closed",
  )
  assert.equal(result.left._tag, "RegistryError")
  assert.equal(result.left.code, "corrupt_state")
  assert.ok(result.left.message.includes(recordId), result.left.message)
}

test("legacy schema repair rolls back when persisted role validation fails", async t => {
  const f = fixture(t)
  const { lease } = await claim(f.store, f.project)

  f.database(database => {
    database.exec(`
      ALTER TABLE requests DROP COLUMN requester_acknowledged_at;
      ALTER TABLE requests DROP COLUMN requester_label;
      ALTER TABLE requests DROP COLUMN requester_cwd;
      PRAGMA user_version = 1;
    `)
    database
      .prepare("UPDATE leases SET role = 'developer' WHERE lease_id = ?")
      .run(lease.id)
  })
  const reopened = await f.reopen()

  await expectCorruptRole(reopened.snapshot(1500), lease.id)

  f.database(database => {
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 1)
    const columns = database
      .prepare("PRAGMA table_info(requests)")
      .all()
      .map(row => row.name)
    assert.equal(columns.includes("requester_acknowledged_at"), false)
    assert.equal(columns.includes("requester_label"), false)
    assert.equal(columns.includes("requester_cwd"), false)
    assert.equal(
      database
        .prepare("SELECT role FROM leases WHERE lease_id = ?")
        .get(lease.id)?.role,
      "developer",
    )
  })
})

for (const role of ["developer", "pi-support"])
  for (const expired of [false, true])
    test(`opening rejects ${expired ? "expired" : "active"} legacy lease role ${role}`, async t => {
      const f = fixture(t)
      const { lease } = await claim(f.store, f.project)

      f.database(database =>
        database
          .prepare("UPDATE leases SET role = ? WHERE lease_id = ?")
          .run(role, lease.id),
      )
      const before = f.database(database =>
        database
          .prepare("SELECT * FROM leases WHERE lease_id = ?")
          .get(lease.id),
      )
      const reopened = await f.reopen()

      await expectCorruptRole(
        reopened.snapshot(expired ? 3000 : 1500),
        lease.id,
      )

      assert.deepEqual(
        f.database(database =>
          database
            .prepare("SELECT * FROM leases WHERE lease_id = ?")
            .get(lease.id),
        ),
        before,
      )
    })

for (const role of ["developer", "pi-support"])
  for (const acknowledged of [false, true])
    test(`opening rejects ${acknowledged ? "acknowledged" : "queued"} legacy request role ${role}`, async t => {
      const f = fixture(t)
      await claim(f.store, f.project)
      const request = await enqueue(f.store, f.project)

      if (acknowledged) {
        await Effect.runPromise(
          f.store.cancelRequest({
            requestId: request.id,
            requesterId: "fixture-requester",
            now: 1020,
          }),
        )
        await Effect.runPromise(
          f.store.acknowledgeRequest({
            requestId: request.id,
            requesterId: "fixture-requester",
            now: 1030,
          }),
        )
      }

      f.database(database =>
        database
          .prepare("UPDATE requests SET role = ? WHERE request_id = ?")
          .run(role, request.id),
      )
      const before = f.database(database =>
        database
          .prepare("SELECT * FROM requests WHERE request_id = ?")
          .get(request.id),
      )
      const reopened = await f.reopen()

      await expectCorruptRole(reopened.snapshot(1500), request.id)

      assert.deepEqual(
        f.database(database =>
          database
            .prepare("SELECT * FROM requests WHERE request_id = ?")
            .get(request.id),
        ),
        before,
      )
    })

test("a cached snapshot cannot hide an unsupported expired lease", async t => {
  const f = fixture(t)
  const { lease } = await claim(f.store, f.project)

  f.database(database =>
    database
      .prepare("UPDATE leases SET role = 'developer' WHERE lease_id = ?")
      .run(lease.id),
  )

  await expectCorruptRole(f.store.snapshot(3000), lease.id)
})

test("a cached snapshot cannot hide an unsupported acknowledged request", async t => {
  const f = fixture(t)
  await claim(f.store, f.project)
  const request = await enqueue(f.store, f.project)
  await Effect.runPromise(
    f.store.cancelRequest({
      requestId: request.id,
      requesterId: "fixture-requester",
      now: 1020,
    }),
  )
  await Effect.runPromise(
    f.store.acknowledgeRequest({
      requestId: request.id,
      requesterId: "fixture-requester",
      now: 1030,
    }),
  )

  f.database(database =>
    database
      .prepare("UPDATE requests SET role = 'developer' WHERE request_id = ?")
      .run(request.id),
  )

  await expectCorruptRole(f.store.snapshot(1500), request.id)
})

test("an already-open store cannot heartbeat a lease with a legacy role", async t => {
  const f = fixture(t)
  const { lease } = await claim(f.store, f.project)

  f.database(database =>
    database
      .prepare("UPDATE leases SET role = 'developer' WHERE lease_id = ?")
      .run(lease.id),
  )

  await expectCorruptRole(
    f.store.heartbeat({
      leaseId: lease.id,
      agentId: lease.owner.id,
      policyDigest: "fixture-policy",
      now: 1100,
      ttlMs: 5000,
    }),
    lease.id,
  )

  assert.equal(
    f.database(database =>
      database
        .prepare("SELECT expires_at FROM leases WHERE lease_id = ?")
        .get(lease.id),
    )?.expires_at,
    2000,
  )
})

test("an already-open store cannot resume a lease with a legacy role", async t => {
  const f = fixture(t)
  const { lease } = await claim(f.store, f.project)
  await Effect.runPromise(
    f.store.pause({ leaseId: lease.id, agentId: lease.owner.id, now: 1010 }),
  )

  f.database(database =>
    database
      .prepare("UPDATE leases SET role = 'developer' WHERE lease_id = ?")
      .run(lease.id),
  )

  await expectCorruptRole(
    f.store.resume({
      leaseId: lease.id,
      agentId: lease.owner.id,
      policyDigest: "fixture-policy",
      now: 1100,
      ttlMs: 5000,
    }),
    lease.id,
  )

  assert.equal(
    f.database(database =>
      database
        .prepare("SELECT status FROM leases WHERE lease_id = ?")
        .get(lease.id),
    )?.status,
    "paused",
  )
})

test("matching legacy request and lease labels cannot authorize receipt", async t => {
  const f = fixture(t)
  const { lease } = await claim(f.store, f.project)
  const request = await enqueue(f.store, f.project)

  f.database(database => {
    database
      .prepare("UPDATE leases SET role = 'developer' WHERE lease_id = ?")
      .run(lease.id)
    database
      .prepare("UPDATE requests SET role = 'developer' WHERE request_id = ?")
      .run(request.id)
  })

  await expectCorruptRole(
    f.store.receiveRequest({
      requestId: request.id,
      leaseId: lease.id,
      agentId: lease.owner.id,
      now: 1100,
    }),
    lease.id,
  )

  assert.equal(
    f.database(database =>
      database
        .prepare(
          "SELECT recipient_received_at FROM requests WHERE request_id = ?",
        )
        .get(request.id),
    )?.recipient_received_at,
    null,
  )
})

test("an already-open store cannot acknowledge an unsupported historical role", async t => {
  const f = fixture(t)
  await claim(f.store, f.project)
  const request = await enqueue(f.store, f.project)
  await Effect.runPromise(
    f.store.cancelRequest({
      requestId: request.id,
      requesterId: "fixture-requester",
      now: 1020,
    }),
  )

  f.database(database =>
    database
      .prepare("UPDATE requests SET role = 'developer' WHERE request_id = ?")
      .run(request.id),
  )

  await expectCorruptRole(
    f.store.acknowledgeRequest({
      requestId: request.id,
      requesterId: "fixture-requester",
      now: 1100,
    }),
    request.id,
  )

  assert.equal(
    f.database(database =>
      database
        .prepare(
          "SELECT requester_acknowledged_at FROM requests WHERE request_id = ?",
        )
        .get(request.id),
    )?.requester_acknowledged_at,
    null,
  )
})

test("release cannot silently delete an unsupported cached lease", async t => {
  const f = fixture(t)
  const { lease } = await claim(f.store, f.project)

  f.database(database =>
    database
      .prepare("UPDATE leases SET role = 'developer' WHERE lease_id = ?")
      .run(lease.id),
  )

  await expectCorruptRole(
    f.store.release({ leaseId: lease.id, agentId: lease.owner.id, now: 1100 }),
    lease.id,
  )

  assert.ok(
    f.database(database =>
      database
        .prepare("SELECT lease_id FROM leases WHERE lease_id = ?")
        .get(lease.id),
    ),
  )
})

test("claim cannot purge an unsupported expired lease before validation", async t => {
  const f = fixture(t)
  const { lease } = await claim(f.store, f.project)

  f.database(database =>
    database
      .prepare("UPDATE leases SET role = 'developer' WHERE lease_id = ?")
      .run(lease.id),
  )

  await expectCorruptRole(
    f.store.claim({
      agent: { id: "another-role-worker", pid: process.pid },
      project: f.project,
      role: "manager",
      mode: "task",
      policyDigest: "fixture-policy",
      now: 3000,
      ttlMs: 1000,
    }),
    lease.id,
  )

  assert.ok(
    f.database(database =>
      database
        .prepare("SELECT lease_id FROM leases WHERE lease_id = ?")
        .get(lease.id),
    ),
  )
})

test("runtime identity maintenance cannot reassign an unsupported lease", async t => {
  const f = fixture(t)
  const sessionId = "restored-role-session"
  const { lease } = await Effect.runPromise(
    f.store.claim({
      agent: { id: sessionId, pid: process.pid },
      project: f.project,
      role: "driver-worker",
      mode: "operational",
      policyDigest: "fixture-policy",
      now: 1000,
      ttlMs: 1000,
    }),
  )

  f.database(database =>
    database
      .prepare("UPDATE leases SET role = 'developer' WHERE lease_id = ?")
      .run(lease.id),
  )

  await expectCorruptRole(
    f.store.heartbeatAgent({
      agent: { id: runtimeAgentId(sessionId, process.pid), pid: process.pid },
      cwd: f.project,
      label: "Fixture worker",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
      now: 1100,
      ttlMs: 5000,
    }),
    lease.id,
  )

  assert.equal(
    f.database(database =>
      database
        .prepare("SELECT owner_id FROM leases WHERE lease_id = ?")
        .get(lease.id),
    )?.owner_id,
    sessionId,
  )
})

test("administrative clear cannot silently discard an unsupported role", async t => {
  const f = fixture(t)
  const { lease } = await claim(f.store, f.project)

  f.database(database =>
    database
      .prepare("UPDATE leases SET role = 'developer' WHERE lease_id = ?")
      .run(lease.id),
  )

  await expectCorruptRole(
    f.store.clearExceptProject({
      preservedProject: join(f.project, "preserved"),
      now: 1100,
    }),
    lease.id,
  )

  assert.ok(
    f.database(database =>
      database
        .prepare("SELECT lease_id FROM leases WHERE lease_id = ?")
        .get(lease.id),
    ),
  )
})

test("a prior live lease check cannot mask an unsupported role", async t => {
  const f = fixture(t)
  const { lease: prior } = await claim(f.store, f.project)
  const request = await enqueue(f.store, f.project)
  const { lease: receiver } = await Effect.runPromise(
    f.store.claim({
      agent: { id: "replacement-role-worker", pid: process.pid },
      project: f.project,
      role: "review-worker",
      mode: "operational",
      policyDigest: "fixture-policy",
      now: 1015,
      ttlMs: 5000,
    }),
  )
  await Effect.runPromise(
    f.store.claimRequest({
      requestId: request.id,
      leaseId: prior.id,
      agentId: prior.owner.id,
      now: 1020,
    }),
  )

  f.database(database => {
    database
      .prepare("UPDATE leases SET role = 'developer' WHERE lease_id = ?")
      .run(prior.id)
    database
      .prepare("UPDATE leases SET role = 'driver-worker' WHERE lease_id = ?")
      .run(receiver.id)
  })

  await expectCorruptRole(
    f.store.claimRequest({
      requestId: request.id,
      leaseId: receiver.id,
      agentId: receiver.owner.id,
      now: 1100,
    }),
    prior.id,
  )

  assert.equal(
    f.database(database =>
      database
        .prepare("SELECT agent_id FROM requests WHERE request_id = ?")
        .get(request.id),
    )?.agent_id,
    prior.owner.id,
  )
})
