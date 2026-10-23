import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect, Either } from "effect"
import { makeRemoteBridgeStore } from "./sqlite-store.ts"
import { BRIDGE_PROTOCOL_VERSION } from "./protocol.ts"

const fixture = (t: test.TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "pi-manager-presence-"))
  t.after(() => rmSync(root, { recursive: true }))
  const path = join(root, "bridge.sqlite")
  return { path, store: makeRemoteBridgeStore(path) }
}
const input = {
  id: "manager",
  label: "Native manager",
  cwd: "/manager/global",
  accepting: true,
  workDelivery: "native-pi" as const,
  nativeManager: true as const,
  now: 1000,
  ttlMs: 15000,
}

test("native manager presence round-trips and ordinary worker heartbeat clears it", async t => {
  const { store } = fixture(t)
  const manager = await Effect.runPromise(store.heartbeatAgent(input))
  assert.equal(manager.nativeManager, true)
  assert.equal(
    (await Effect.runPromise(store.listAgents(1001)))[0]?.nativeManager,
    true,
  )
  const { nativeManager: _, ...worker } = input
  await Effect.runPromise(store.heartbeatAgent({ ...worker, now: 1100 }))
  assert.equal(
    (await Effect.runPromise(store.listAgents(1101)))[0]?.nativeManager,
    undefined,
  )
})

for (const oldWriterNow of [1000, 1100]) {
  test(`an old producer invalidates manager presence even at the same timestamp: ${oldWriterNow}`, async t => {
    const { store, path } = fixture(t)
    await Effect.runPromise(store.heartbeatAgent(input))
    const database = new DatabaseSync(path)
    try {
      database
        .prepare(
          "UPDATE bridge_agents SET heartbeat_at = ?, expires_at = ? WHERE agent_id = ?",
        )
        .run(oldWriterNow, oldWriterNow + 15000, "manager")
      assert.equal(
        database.prepare("PRAGMA user_version").get()?.user_version,
        BRIDGE_PROTOCOL_VERSION,
      )
    } finally {
      database.close()
    }
    const rows = await Effect.runPromise(store.listAgents(1101))
    assert.equal(rows[0]?.nativeManager, undefined)
    assert.equal(rows[0]?.workDelivery, "native-pi")
  })
}

test("manager presence cannot be registered by a non-native delivery lane", async t => {
  const { store } = fixture(t)
  const result = await Effect.runPromise(
    Effect.either(store.heartbeatAgent({ ...input, workDelivery: "cli-poll" })),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "invalid_input")
})

test("a native manager reasserts presence after every heartbeat, including equal timestamps", async t => {
  const { store, path } = fixture(t)
  for (const now of [1000, 1000, 1100])
    assert.equal(
      (await Effect.runPromise(store.heartbeatAgent({ ...input, now })))
        .nativeManager,
      true,
    )
  const database = new DatabaseSync(path)
  try {
    // Old readers still see the same delivery enum and usable row shape.
    assert.equal(
      database
        .prepare("SELECT work_delivery FROM bridge_agents WHERE agent_id = ?")
        .get("manager")?.work_delivery,
      "native-pi",
    )
  } finally {
    database.close()
  }
})

test("v6 repairs a missing manager column and trigger without losing legacy rows", async t => {
  const { store, path } = fixture(t)
  const { nativeManager: _, ...worker } = input
  await Effect.runPromise(store.heartbeatAgent(worker))
  const database = new DatabaseSync(path)
  try {
    database.exec("DROP TRIGGER bridge_agents_invalidate_manager")
    database.exec("ALTER TABLE bridge_agents DROP COLUMN manager_heartbeat_at")
  } finally {
    database.close()
  }
  for (const now of [1001, 1002]) {
    const rows = await Effect.runPromise(store.listAgents(now))
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, "manager")
    assert.equal(rows[0]?.nativeManager, undefined)
  }
  assert.equal(
    (await Effect.runPromise(store.heartbeatAgent({ ...input, now: 1100 })))
      .nativeManager,
    true,
  )
})

for (const mutation of [
  "UPDATE bridge_agents SET manager_heartbeat_at = 2000",
  "UPDATE bridge_agents SET work_delivery = 'cli-poll'",
]) {
  test(`malformed manager observations fail closed: ${mutation}`, async t => {
    const { store, path } = fixture(t)
    await Effect.runPromise(store.heartbeatAgent(input))
    const database = new DatabaseSync(path)
    try {
      database.exec(mutation)
    } finally {
      database.close()
    }
    const result = await Effect.runPromise(
      Effect.either(store.listAgents(1001)),
    )
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "corrupt_state")
  })
}

test("a malformed manager invalidation trigger is rejected rather than trusted", async t => {
  const { store, path } = fixture(t)
  await Effect.runPromise(store.heartbeatAgent(input))
  const database = new DatabaseSync(path)
  try {
    database.exec("DROP TRIGGER bridge_agents_invalidate_manager")
    database.exec(
      "CREATE TRIGGER bridge_agents_invalidate_manager AFTER UPDATE OF heartbeat_at ON bridge_agents BEGIN SELECT 1; END",
    )
  } finally {
    database.close()
  }
  const result = await Effect.runPromise(Effect.either(store.listAgents(1001)))
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "corrupt_state")
})
