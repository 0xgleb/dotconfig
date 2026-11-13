import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Deferred, Effect, Either, Fiber } from "effect"
import {
  makeSqliteRegistryStore,
  type SqliteRegistryStoreOptions,
} from "./sqlite-store.ts"

const fixture = (
  t: test.TestContext,
  options: SqliteRegistryStoreOptions = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "pi-registry-contention-"))
  const first = makeSqliteRegistryStore(root, options)
  const second = makeSqliteRegistryStore(root)
  t.after(async () => {
    first.close()
    second.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    rmSync(root, { recursive: true, force: true })
  })
  return { root, first, second }
}

test(
  "registry does not silently accept rollback journaling when WAL setup is locked",
  { timeout: 15000 },
  async t => {
    const f = fixture(t)
    await Effect.runPromise(f.first.snapshot(0))
    f.first.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    const writer = new DatabaseSync(join(f.root, "registry.sqlite"))
    assert.equal(
      writer.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode,
      "delete",
    )
    writer.exec("BEGIN IMMEDIATE")
    try {
      const result = await Effect.runPromise(
        Effect.either(f.second.snapshot(0)),
      )
      assert.ok(
        Either.isLeft(result),
        "WAL failure must be reported, not ignored",
      )
      assert.equal(result.left.code, "busy")
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
    }
    await Effect.runPromise(f.second.snapshot(0))
    const database = new DatabaseSync(join(f.root, "registry.sqlite"))
    try {
      assert.equal(
        database.prepare("PRAGMA journal_mode").get()?.journal_mode,
        "wal",
      )
    } finally {
      database.close()
    }
  },
)

test(
  "interrupted WAL initialization closes its uncached connection",
  { timeout: 15000 },
  async t => {
    const f = fixture(t)
    await Effect.runPromise(f.first.snapshot(0))
    f.first.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    const writer = new DatabaseSync(join(f.root, "registry.sqlite"))
    writer.prepare("PRAGMA journal_mode = DELETE").get()
    writer.exec("BEGIN IMMEDIATE")
    const attempted = await Effect.runPromise(Deferred.make<void>())
    const prepare = DatabaseSync.prototype.prepare
    const close = DatabaseSync.prototype.close
    let opening: DatabaseSync | undefined
    const closed: DatabaseSync[] = []
    t.mock.method(
      DatabaseSync.prototype,
      "prepare",
      function (this: DatabaseSync, sql: string) {
        if (sql === "PRAGMA journal_mode = WAL") {
          opening = this
          Effect.runSync(Deferred.succeed(attempted, undefined))
        }
        return prepare.call(this, sql)
      },
    )
    t.mock.method(
      DatabaseSync.prototype,
      "close",
      function (this: DatabaseSync) {
        closed.push(this)
        return close.call(this)
      },
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const startup = yield* Effect.fork(f.second.snapshot(0))
          yield* Deferred.await(attempted)
          yield* Fiber.interrupt(startup)
        }),
      )
      assert.ok(opening)
      assert.deepEqual(closed, [opening])
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
      if (opening && !closed.includes(opening)) close.call(opening)
    }
  },
)
