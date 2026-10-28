import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Effect, Either, Option } from "effect"
import { decodeIssueReference } from "./identity.ts"
import {
  openSqlitePlanStore,
  type SqlitePlanStore,
  type TaskApplyContext,
} from "./sqlite-store.ts"

const run = Effect.runPromise
const parent = fileURLToPath(
  new URL("../../../../.tmp/issue-plans-tests/", import.meta.url),
)
const a = { repository: "0xgleb/dotconfig", number: 1 }
const b = { repository: "dataclique/yielduck", number: 1 }
const issue = (raw = a) => {
  const value = decodeIssueReference(raw)
  assert.ok(Either.isRight(value))
  return value.right
}
const context = (
  requestId: string,
  cancellation: TaskApplyContext["cancellation"] = "forbidden",
): TaskApplyContext => ({
  actorId: "fixture-worker",
  requestId,
  now: 1_000,
  cancellation,
})
const added = (key: string, target = a) => ({
  issue: target,
  task: { kind: "added", key },
})
const existing = (id: string, target = a) => ({
  issue: target,
  task: { kind: "existing", id },
})
const batch = (operations: readonly unknown[], issues = [a, b]) => ({
  issues,
  operations,
})
const fixture = async (work: (path: string, root: string) => Promise<void>) => {
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(parent, "apply-"))
  try {
    await work(join(root, "registry.sqlite"), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const withStore = async (
  path: string,
  work: (store: SqlitePlanStore) => Promise<void>,
) => {
  const store = await run(
    openSqlitePlanStore({ databasePath: path, busyTimeoutMs: 0 }),
  )
  try {
    await work(store)
  } finally {
    await run(store.close())
  }
}
const sql = (path: string, work: (database: DatabaseSync) => void) => {
  const database = new DatabaseSync(path)
  try {
    work(database)
  } finally {
    database.close()
  }
}
const errorCode = async <T, E extends { readonly code: string }>(
  effect: Effect.Effect<T, E>,
  expected: string,
) => {
  const value = await run(Effect.either(effect))
  assert.ok(Either.isLeft(value))
  assert.equal(value.left.code, expected)
}

test("an atomic multi-issue write persists stable tasks, edges, revisions and private history", async () =>
  fixture(async path => {
    let firstId = ""
    let secondId = ""
    await withStore(path, async store => {
      const saved = await run(
        store.apply(
          batch([
            { op: "add", issue: a, key: "first", text: "First requirement" },
            {
              op: "add",
              issue: b,
              key: "second",
              text: "Second requirement",
              dependsOn: [added("first")],
            },
            { op: "status", target: added("first"), status: "doing" },
            {
              op: "block",
              target: added("second", b),
              reason: "Awaiting external input",
            },
          ]),
          context("multi"),
        ),
      )
      assert.equal(saved.kind, "saved")
      assert.equal(saved.receipt, "committed")
      assert.equal(saved.eventCount, 4)
      assert.equal(saved.plans.length, 2)
      const first = saved.created.find(item => item.key === "first")
      const second = saved.created.find(item => item.key === "second")
      assert.ok(first && second)
      firstId = first.id
      secondId = second.id
      assert.notEqual(firstId, secondId)
      assert.deepEqual(
        saved.changed.map(row => row.revision),
        [1, 1],
      )
    })
    await withStore(path, async store => {
      const first = await run(store.readPlan(issue(), { limit: 10 }))
      const second = await run(store.readPlan(issue(b), { limit: 10 }))
      assert.ok(Option.isSome(first) && Option.isSome(second))
      assert.equal(first.value.tasks[0]?.id, firstId)
      assert.equal(first.value.tasks[0]?.status, "doing")
      assert.equal(second.value.tasks[0]?.id, secondId)
      assert.equal(second.value.tasks[0]?.blocker, "Awaiting external input")
    })
    sql(path, database => {
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
          .get()?.count,
        4,
      )
      assert.deepEqual(
        database
          .prepare("SELECT task_id, depends_on_id FROM issue_plan_dependencies")
          .all()
          .map(row => [row.task_id, row.depends_on_id]),
        [[secondId, firstId]],
      )
    })
  }))

test("a failed late target leaves no plan, task, receipt or history from the batch", async () =>
  fixture(async path => {
    await withStore(path, async store => {
      await errorCode(
        store.apply(
          batch([
            {
              op: "add",
              issue: a,
              key: "first",
              text: "Must not partially persist",
            },
            {
              op: "status",
              target: existing("20000000-0000-4000-8000-000000000999", b),
              status: "done",
            },
          ]),
          context("missing"),
        ),
        "missing_task",
      )
      assert.ok(
        Option.isNone(await run(store.readPlan(issue(), { limit: 10 }))),
      )
    })
    sql(path, database => {
      for (const table of [
        "issue_plans",
        "issue_plan_tasks",
        "issue_plan_batches",
        "issue_plan_history",
      ])
        assert.equal(
          database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
            ?.count,
          0,
        )
    })
  }))

test("cancellation policy is trusted context, not batch data, and failed cancellation rolls back additions", async () =>
  fixture(async path => {
    await withStore(path, async store => {
      const input = batch([
        { op: "add", issue: a, key: "new", text: "New task" },
        { op: "status", target: added("new"), status: "cancelled" },
      ])
      await errorCode(
        store.apply(input, context("worker-cancel")),
        "unauthorized",
      )
      assert.ok(
        Option.isNone(await run(store.readPlan(issue(), { limit: 10 }))),
      )
      const saved = await run(
        store.apply(input, context("owner-cancel", "owner-authorized")),
      )
      const task = saved.created[0]
      assert.ok(task)
      await errorCode(
        store.apply(
          batch([{ op: "status", target: existing(task.id), status: "todo" }]),
          context("worker-reopen"),
        ),
        "unauthorized",
      )
      await errorCode(
        store.apply(
          {
            ...batch([
              { op: "block", target: existing(task.id), reason: null },
            ]),
            authority: "owner",
          },
          context("forged"),
        ),
        "invalid_batch",
      )
    })
  }))

test("host request identities replay saved receipts but reject changed batches", async () =>
  fixture(async path => {
    const input = batch([
      { op: "add", issue: a, key: "once", text: "Only once" },
    ])
    let batchId = ""
    let taskId = ""
    await withStore(path, async store => {
      const saved = await run(store.apply(input, context("once")))
      batchId = saved.batchId
      const created = saved.created[0]
      assert.ok(created)
      taskId = created.id
    })
    await withStore(path, async store => {
      const replay = await run(
        store.apply(input, { ...context("once"), now: 2_000 }),
      )
      assert.equal(replay.receipt, "replayed")
      assert.equal(replay.batchId, batchId)
      assert.equal(replay.created[0]?.id, taskId)
      await errorCode(
        store.apply(
          batch([
            { op: "add", issue: a, key: "once", text: "Different intent" },
          ]),
          context("once"),
        ),
        "request_conflict",
      )
    })
    sql(path, database => {
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM issue_plan_tasks").get()
          ?.count,
        1,
      )
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
          .get()?.count,
        1,
      )
    })
  }))

for (const corruption of ["task identities", "event count"] as const) {
  test(`request replay rejects a saved receipt with corrupted ${corruption}`, async () =>
    fixture(async path => {
      const input = batch([
        { op: "add", issue: a, key: "once", text: "One task" },
      ])
      await withStore(path, async store => {
        await run(store.apply(input, context("corrupt-receipt")))
      })
      sql(path, database => {
        const json = database
          .prepare("SELECT result_json FROM issue_plan_batches")
          .get()?.result_json
        assert.ok(typeof json === "string")
        const saved: unknown = JSON.parse(json)
        assert.ok(typeof saved === "object" && saved !== null)

        if (corruption === "event count") {
          assert.ok("eventCount" in saved)
          saved.eventCount = 0
        } else {
          assert.ok("changed" in saved && "created" in saved)
          for (const rows of [saved.changed, saved.created]) {
            assert.ok(Array.isArray(rows))
            const first: unknown = rows[0]
            assert.ok(
              typeof first === "object" && first !== null && "id" in first,
            )
            first.id = "20000000-0000-4000-8000-000000000999"
          }
        }
        database
          .prepare("UPDATE issue_plan_batches SET result_json = ?")
          .run(JSON.stringify(saved))
      })
      await withStore(path, async store => {
        await errorCode(
          store.apply(input, context("corrupt-receipt")),
          "corrupt_state",
        )
      })
    }))
}

for (const table of [
  "issue_plan_batches",
  "issue_plans",
  "issue_plan_tasks",
  "issue_plan_history",
  "issue_plan_dependencies",
] as const) {
  test(`a suppressed ${table} insert rolls the entire task batch back`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        sql(path, database => {
          database.exec(
            `CREATE TRIGGER fixture_suppress_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END;`,
          )
        })
        await errorCode(
          store.apply(
            batch([
              { op: "add", issue: a, key: "first", text: "First" },
              {
                op: "add",
                issue: b,
                key: "second",
                text: "Second",
                dependsOn: [added("first")],
              },
            ]),
            context("suppressed-insert"),
          ),
          "corrupt_state",
        )
        assert.ok(
          Option.isNone(await run(store.readPlan(issue(), { limit: 10 }))),
        )
        assert.ok(
          Option.isNone(await run(store.readPlan(issue(b), { limit: 10 }))),
        )
      })
      sql(path, database => {
        for (const name of [
          "issue_plans",
          "issue_plan_tasks",
          "issue_plan_batches",
          "issue_plan_dependencies",
          "issue_plan_history",
        ]) {
          assert.equal(
            database.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()
              ?.count,
            0,
          )
        }
      })
    }))
}

for (const [table, mutation] of [
  [
    "issue_plans",
    "UPDATE issue_plans SET revision = revision + 1 WHERE id = NEW.id",
  ],
  [
    "issue_plan_tasks",
    "UPDATE issue_plan_tasks SET text = 'Silently changed' WHERE id = NEW.id",
  ],
  [
    "issue_plan_history",
    "DELETE FROM issue_plan_history WHERE batch_id = NEW.batch_id AND operation_index = NEW.operation_index",
  ],
  [
    "issue_plan_dependencies",
    "DELETE FROM issue_plan_dependencies WHERE task_id = NEW.task_id AND depends_on_id = NEW.depends_on_id",
  ],
] as const) {
  test(`post-write reconciliation rejects a changed ${table} projection`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        sql(path, database => {
          database.exec(
            `CREATE TRIGGER fixture_change_projection AFTER INSERT ON ${table} BEGIN ${mutation}; END;`,
          )
        })
        await errorCode(
          store.apply(
            batch([
              { op: "add", issue: a, key: "first", text: "First" },
              {
                op: "add",
                issue: b,
                key: "second",
                text: "Second",
                dependsOn: [added("first")],
              },
            ]),
            context("changed-projection"),
          ),
          "corrupt_state",
        )
        assert.ok(
          Option.isNone(await run(store.readPlan(issue(), { limit: 10 }))),
        )
        assert.ok(
          Option.isNone(await run(store.readPlan(issue(b), { limit: 10 }))),
        )
      })
      sql(path, database => {
        for (const name of [
          "issue_plans",
          "issue_plan_tasks",
          "issue_plan_batches",
          "issue_plan_dependencies",
          "issue_plan_history",
        ]) {
          assert.equal(
            database.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()
              ?.count,
            0,
          )
        }
      })
    }))
}

test("replaying an older receipt survives later legitimate task changes", async () =>
  fixture(async path => {
    const input = batch([{ op: "add", issue: a, key: "first", text: "First" }])
    await withStore(path, async store => {
      const saved = await run(store.apply(input, context("original")))
      const created = saved.created[0]
      assert.ok(created)
      const changed = await run(
        store.apply(
          batch([
            { op: "status", target: existing(created.id), status: "doing" },
          ]),
          context("later"),
        ),
      )
      assert.equal(changed.plans[0]?.revision, 2)

      const replayed = await run(store.apply(input, context("original")))
      assert.deepEqual(replayed, { ...saved, receipt: "replayed" })
      const page = await run(store.readPlan(issue(), { limit: 10 }))
      assert.ok(Option.isSome(page))
      assert.equal(page.value.tasks[0]?.status, "doing")
      assert.equal(page.value.plan.revision, 2)
    })
  }))

test("concurrent writers load current state under the same SQLite write lock", async () =>
  fixture(async path => {
    const first = await run(
      openSqlitePlanStore({ databasePath: path, busyTimeoutMs: 0 }),
    )
    const second = await run(
      openSqlitePlanStore({ databasePath: path, busyTimeoutMs: 0 }),
    )
    try {
      await Promise.all([
        run(
          first.apply(
            batch([
              { op: "add", issue: a, key: "first", text: "First writer" },
            ]),
            context("writer-one"),
          ),
        ),
        run(
          second.apply(
            batch([
              { op: "add", issue: a, key: "second", text: "Second writer" },
            ]),
            context("writer-two"),
          ),
        ),
      ])
      const page = await run(first.readPlan(issue(), { limit: 10 }))
      assert.ok(Option.isSome(page))
      assert.equal(page.value.tasks.length, 2)
      assert.equal(page.value.plan.revision, 2)
    } finally {
      await run(first.close())
      await run(second.close())
    }
  }))

test("a cyclic final batch is rejected without changing tasks or history", async () =>
  fixture(async path => {
    await withStore(path, async store => {
      const saved = await run(
        store.apply(
          batch([
            { op: "add", issue: a, key: "first", text: "First" },
            {
              op: "add",
              issue: b,
              key: "second",
              text: "Second",
              dependsOn: [added("first")],
            },
          ]),
          context("seed"),
        ),
      )
      const first = saved.created.find(item => item.key === "first")
      const second = saved.created.find(item => item.key === "second")
      assert.ok(first && second)
      await errorCode(
        store.apply(
          batch([
            {
              op: "edit",
              target: existing(first.id),
              dependsOn: [existing(second.id, b)],
            },
          ]),
          context("cycle"),
        ),
        "cycle",
      )
      const page = await run(store.readPlan(issue(), { limit: 10 }))
      assert.ok(Option.isSome(page))
      assert.equal(page.value.plan.revision, 1)
    })
    sql(path, database =>
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
          .get()?.count,
        2,
      ),
    )
  }))

test("a new schema upgrades the real version-one namespace without changing registry ownership", async () =>
  fixture(async path => {
    await withStore(path, async store => {
      await run(store.ensurePlan(issue()))
    })
    sql(path, database =>
      database.exec(
        "DROP TABLE IF EXISTS issue_plan_history; DROP TABLE IF EXISTS issue_plan_dependencies; DROP TABLE IF EXISTS issue_plan_batches; UPDATE issue_plan_schema SET version = 1; PRAGMA user_version = 5;",
      ),
    )
    await withStore(path, async store => {
      const saved = await run(
        store.apply(
          batch([{ op: "add", issue: a, key: "after", text: "After upgrade" }]),
          context("upgrade"),
        ),
      )
      assert.equal(saved.created.length, 1)
    })
    sql(path, database => {
      assert.equal(
        database.prepare("SELECT version FROM issue_plan_schema").get()
          ?.version,
        2,
      )
      assert.equal(
        database.prepare("PRAGMA user_version").get()?.user_version,
        5,
      )
    })
  }))
