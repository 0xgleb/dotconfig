import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Deferred, Effect, Either, Fiber } from "effect"
import type { BranchTodoBacklogSnapshot } from "../shared/backlog-events.ts"
import {
  makeSqliteRegistryStore,
  type SqliteRegistryStoreOptions,
} from "./sqlite-store.ts"

const snapshot = (
  observedAt: number,
  status: "pending" | "completed",
): BranchTodoBacklogSnapshot => ({
  project: "/repo/a",
  sessionId: "session-1",
  observedAt,
  todos: [
    {
      canonicalId: "session-1:todo-1",
      sourceId: `session-1:todo-1:snapshot-${observedAt}`,
      requirements:
        status === "pending"
          ? ["Keep initial requirement"]
          : ["Keep initial requirement", "Preserve latest snapshot"],
      status,
    },
  ],
})

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
  "branch reconciliation yields to a competing local writer and preserves the latest snapshot once",
  { timeout: 15000 },
  async t => {
    const began = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    let starts = 0
    const f = fixture(t, {
      transactionBeginSignal: Effect.gen(function* () {
        starts += 1
        yield* Deferred.succeed(began, undefined)
        yield* Deferred.await(release)
      }),
    })
    await Effect.runPromise(f.first.snapshot(0))
    await Effect.runPromise(f.second.snapshot(0))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* Effect.fork(
          f.first.reconcileBranchTodos(snapshot(1000, "pending")),
        )
        yield* Deferred.await(began)
        const contender = yield* Effect.fork(
          Effect.either(
            f.second.reconcileBranchTodos(snapshot(2000, "completed")),
          ),
        )
        yield* Effect.sleep("10 millis")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(writer)
        return yield* Fiber.join(contender)
      }),
    )
    assert.ok(
      Either.isRight(result),
      Either.isLeft(result) ? result.left.message : "",
    )
    assert.equal(starts, 1)
    const state = result.right
    assert.equal(state.items.length, 1)
    assert.equal(state.items[0]?.state.kind, "terminal")
    assert.equal(state.sources.length, 2)
    assert.deepEqual(
      state.requirements.map(item => item.text),
      [
        "Keep initial requirement",
        "Keep initial requirement",
        "Preserve latest snapshot",
      ],
    )
  },
)

test(
  "persistent writer contention fails boundedly without changing branch backlog",
  { timeout: 15000 },
  async t => {
    const f = fixture(t)
    const prior = await Effect.runPromise(
      f.first.reconcileBranchTodos(snapshot(1000, "pending")),
    )
    await Effect.runPromise(f.second.snapshot(0))
    const writer = new DatabaseSync(join(f.root, "registry.sqlite"))
    writer.exec("BEGIN IMMEDIATE")
    const started = performance.now()
    try {
      const result = await Effect.runPromise(
        Effect.either(
          f.second.reconcileBranchTodos(snapshot(2000, "completed")),
        ),
      )
      assert.ok(Either.isLeft(result))
      assert.equal(result.left.code, "busy")
      assert.ok(performance.now() - started < 12000)
      assert.deepEqual(
        await Effect.runPromise(f.first.backlogSnapshot("/repo/a")),
        prior,
      )
    } finally {
      writer.exec("ROLLBACK")
      writer.close()
    }
    const recovered = await Effect.runPromise(
      f.second.reconcileBranchTodos(snapshot(2000, "completed")),
    )
    assert.equal(recovered.items[0]?.state.kind, "terminal")
    assert.equal(recovered.sources.length, 2)
  },
)

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
