import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Effect, Either, Option } from "effect"
import { makeSqliteRegistryStore } from "../agent-registry/sqlite-store.ts"
import { decodeIssueReference } from "./identity.ts"
import {
  openSqlitePlanStore,
  type PlanId,
  type PlanStoreError,
  type SqlitePlanStore,
} from "./sqlite-store.ts"

const run = Effect.runPromise
const fixtureParent = fileURLToPath(
  new URL("../../../../.tmp/issue-plans-tests/", import.meta.url),
)
const issue = (repository = "0xgleb/dotconfig", number = 1) => {
  const result = decodeIssueReference({ repository, number })
  assert.ok(Either.isRight(result))
  return result.right
}
const fixture = async (work: (root: string) => Promise<void>) => {
  mkdirSync(fixtureParent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(fixtureParent, "case-"))
  try {
    await work(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const withStore = async (
  path: string,
  work: (store: SqlitePlanStore) => Promise<void>,
  busyTimeoutMs = 2_000,
) => {
  const store = await run(
    openSqlitePlanStore({ databasePath: path, busyTimeoutMs }),
  )
  try {
    await work(store)
  } finally {
    await run(store.close())
  }
}
const expectError = async <T>(
  operation: Effect.Effect<T, PlanStoreError>,
  code: PlanStoreError["code"],
) => {
  const result = await run(Effect.either(operation))
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, code)
}
const sql = (path: string, work: (database: DatabaseSync) => void) => {
  const database = new DatabaseSync(path)
  try {
    work(database)
  } finally {
    database.close()
  }
}
const ids: readonly [string, string, string] = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
]
const seed = (path: string, planId: PlanId, id: string, text: string) =>
  sql(path, database => {
    database
      .prepare(
        "INSERT INTO issue_plan_tasks (id, plan_id, text, status, blocker) VALUES (?, ?, ?, 'todo', NULL)",
      )
      .run(id, planId, text)
  })

for (const order of ["registry-first", "plans-first"]) {
  test(`plans coexist with the real registry: ${order}`, async () =>
    fixture(async root => {
      const path = join(root, "registry.sqlite")
      const registry = makeSqliteRegistryStore(root)
      const populateRegistry = () =>
        run(
          registry.enqueue({
            project: "/fixture/project",
            role: "worker",
            requesterId: "fixture-worker",
            text: "Retain registry data",
            now: 1_000,
          }),
        )
      try {
        const request =
          order === "registry-first" ? await populateRegistry() : undefined
        let persistedId: PlanId | undefined
        await withStore(path, async store => {
          const first = await run(store.ensurePlan(issue()))
          persistedId = first.id
          const second = await run(store.ensurePlan(issue()))
          assert.equal(second.id, first.id)
          assert.equal(second.revision, 0)
          if (order === "plans-first") await populateRegistry()
        })
        const snapshot = await run(registry.snapshot(1_000))
        assert.equal(snapshot.requests.length, 1)
        if (request) assert.equal(snapshot.requests[0]?.id, request.id)
        await withStore(path, async store => {
          const page = await run(store.readPlan(issue(), { limit: 10 }))
          assert.ok(Option.isSome(page))
          assert.equal(page.value.plan.id, persistedId)
          assert.deepEqual(page.value.tasks, [])
        })
        sql(path, database =>
          assert.equal(
            database.prepare("PRAGMA user_version").get()?.user_version,
            5,
          ),
        )
      } finally {
        registry.close()
      }
    }))
}

test("qualified plans and bounded task pages survive reopening without worker presence", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async store => {
      const first = await run(store.ensurePlan(issue()))
      const other = await run(store.ensurePlan(issue("dataclique/yielduck")))
      assert.notEqual(first.id, other.id)
      seed(path, first.id, ids[0], "First requirement")
      seed(path, first.id, ids[1], "Second requirement")
      seed(path, other.id, ids[2], "Different repository")
    })
    await withStore(path, async store => {
      const first = await run(store.readPlan(issue(), { limit: 1 }))
      assert.ok(Option.isSome(first))
      assert.deepEqual(
        first.value.tasks.map(task => task.text),
        ["First requirement"],
      )
      assert.ok(first.value.next)
      const next = await run(
        store.readPlan(issue(), { limit: 1, after: first.value.next }),
      )
      assert.ok(Option.isSome(next))
      assert.deepEqual(
        next.value.tasks.map(task => task.id),
        [ids[1]],
      )
      assert.equal(next.value.next, null)
      const other = await run(
        store.readPlan(issue("dataclique/yielduck"), { limit: 1 }),
      )
      assert.ok(Option.isSome(other))
      const foreign = other.value.tasks[0]
      assert.ok(foreign)
      await expectError(
        store.readPlan(issue(), { limit: 1, after: foreign.id }),
        "invalid_input",
      )
      const absent = await run(
        store.readPlan(issue("owner/missing"), { limit: 10 }),
      )
      assert.ok(Option.isNone(absent))
    })
  }))

test("a separate process reads the same persisted plan", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async store => {
      const plan = await run(store.ensurePlan(issue()))
      seed(path, plan.id, ids[0], "Visible across processes")
      const worker = fileURLToPath(
        new URL("./sqlite-store.worker.ts", import.meta.url),
      )
      const output = execFileSync(process.execPath, [worker, path], {
        encoding: "utf8",
        timeout: 10_000,
      })
      assert.deepEqual(JSON.parse(output), {
        planId: plan.id,
        taskIds: [ids[0]],
        text: "Visible across processes",
      })
    })
  }))

test("malformed persisted task identity fails instead of returning a partial plan", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async store => {
      const plan = await run(store.ensurePlan(issue()))
      seed(path, plan.id, ids[0], "Valid first row")
      seed(
        path,
        plan.id,
        "malformed-uuid",
        "A foreign writer inserted this row",
      )
      await expectError(store.readPlan(issue(), { limit: 1 }), "corrupt_state")
      sql(path, database =>
        database
          .prepare("DELETE FROM issue_plan_tasks WHERE id = ?")
          .run("malformed-uuid"),
      )
      const recovered = await run(store.readPlan(issue(), { limit: 1 }))
      assert.ok(Option.isSome(recovered))
      assert.deepEqual(
        recovered.value.tasks.map(task => task.id),
        [ids[0]],
      )
    })
  }))

test("future feature schema is rejected without changing registry version", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async store => {
      await run(store.ensurePlan(issue()))
      sql(path, database =>
        database.exec(
          "UPDATE issue_plan_schema SET version = 3; PRAGMA user_version = 5;",
        ),
      )
      await expectError(
        store.readPlan(issue(), { limit: 10 }),
        "unsupported_schema",
      )
      await expectError(
        store.ensurePlan(issue("owner/other")),
        "unsupported_schema",
      )
    })
    await expectError(
      openSqlitePlanStore({ databasePath: path }),
      "unsupported_schema",
    )
    sql(path, database => {
      assert.equal(
        database.prepare("PRAGMA user_version").get()?.user_version,
        5,
      )
      assert.equal(
        database.prepare("SELECT version FROM issue_plan_schema").get()
          ?.version,
        3,
      )
    })
  }))

test("page bounds and closed connections fail explicitly", async () =>
  fixture(async root => {
    const store = await run(
      openSqlitePlanStore({ databasePath: join(root, "registry.sqlite") }),
    )
    try {
      for (const limit of [0, -1, 101, 1.5, Number.NaN])
        await expectError(store.readPlan(issue(), { limit }), "invalid_input")
    } finally {
      await run(store.close())
    }
    await expectError(store.readPlan(issue(), { limit: 10 }), "closed")
    await run(store.close())
  }))

test("symlink database paths are rejected before touching their target", async () =>
  fixture(async root => {
    const target = join(root, "target.txt")
    writeFileSync(target, "untouched fixture", { mode: 0o600 })
    const path = join(root, "registry.sqlite")
    symlinkSync(target, path)
    await expectError(
      openSqlitePlanStore({ databasePath: path }),
      "invalid_path",
    )
    assert.equal(readFileSync(target, "utf8"), "untouched fixture")
  }))

test("writer lock exhaustion is typed and never creates a partial plan", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async () => {})
    const lock = new DatabaseSync(path)
    try {
      lock.exec("BEGIN IMMEDIATE")
      await withStore(
        path,
        async store => {
          await expectError(store.ensurePlan(issue()), "busy")
          lock.exec("ROLLBACK")
          const result = await run(store.readPlan(issue(), { limit: 10 }))
          assert.ok(Option.isNone(result))
        },
        0,
      )
    } finally {
      lock.close()
    }
  }))

test("partial feature initialization is rejected rather than guessed or replaced", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async store => {
      await run(store.ensurePlan(issue()))
    })
    sql(path, database => database.exec("DROP TABLE issue_plan_schema"))
    await expectError(
      openSqlitePlanStore({ databasePath: path }),
      "unsupported_schema",
    )
    sql(path, database =>
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM issue_plans").get()
          ?.count,
        1,
      ),
    )
  }))

test("caller revision tokens and blank persisted blockers are not accepted", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async store => {
      const plan = await run(store.ensurePlan(issue("0xGleb/DotConfig")))
      assert.equal((await run(store.ensurePlan(issue()))).id, plan.id)
      const extraIssue = { ...issue(), expectedRevisions: {} }
      const extraPage = { limit: 10, expectedRevisions: {} }
      await expectError(store.ensurePlan(extraIssue), "invalid_input")
      await expectError(store.readPlan(issue(), extraPage), "invalid_input")
      seed(path, plan.id, ids[0], "Retain the full requirement")
      sql(path, database =>
        database
          .prepare("UPDATE issue_plan_tasks SET blocker = ? WHERE id = ?")
          .run("   ", ids[0]),
      )
      await expectError(store.readPlan(issue(), { limit: 10 }), "corrupt_state")
    })
  }))

test("a matching-column schema without issue uniqueness is rejected", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async store => {
      await run(store.ensurePlan(issue()))
    })
    sql(path, database => {
      database.exec(`
      DROP TABLE issue_plans;
      CREATE TABLE issue_plans (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL CHECK (issue_number BETWEEN 1 AND 9007199254740991),
        revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991)
      ) STRICT;
    `)
      const insert = database.prepare(
        "INSERT INTO issue_plans (id, repository, issue_number, revision) VALUES (?, '0xgleb/dotconfig', 1, 0)",
      )
      insert.run(ids[0])
      insert.run(ids[1])
    })
    const opened = await run(
      Effect.either(openSqlitePlanStore({ databasePath: path })),
    )
    if (Either.isRight(opened)) await run(opened.right.close())
    assert.ok(Either.isLeft(opened))
    assert.equal(opened.left.code, "unsupported_schema")
    sql(path, database =>
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM issue_plans").get()
          ?.count,
        2,
      ),
    )
  }))

for (const object of [
  "CREATE VIEW issue_plans AS SELECT 1 AS id",
  "CREATE INDEX issue_plan_tasks_by_plan ON fixture_subject (id)",
  "CREATE TRIGGER issue_plans AFTER INSERT ON fixture_subject BEGIN SELECT 1; END",
  "CREATE VIEW ISSUE_PLANS AS SELECT 1 AS id",
  "CREATE INDEX ISSUE_PLAN_TASKS_BY_PLAN ON fixture_subject (id)",
  "CREATE TRIGGER ISSUE_PLANS AFTER INSERT ON fixture_subject BEGIN SELECT 1; END",
]) {
  test(`namespace collision is rejected without journal mutation: ${object.split(" ").slice(1, 3).join(" ")}`, async () =>
    fixture(async root => {
      const path = join(root, "registry.sqlite")
      writeFileSync(path, "", { mode: 0o600 })
      sql(path, database => {
        database.exec("CREATE TABLE fixture_subject (id INTEGER)")
        database.exec(object)
        assert.equal(
          database.prepare("PRAGMA journal_mode").get()?.journal_mode,
          "delete",
        )
      })
      const opened = await run(
        Effect.either(openSqlitePlanStore({ databasePath: path })),
      )
      if (Either.isRight(opened)) await run(opened.right.close())
      sql(path, database =>
        assert.equal(
          database.prepare("PRAGMA journal_mode").get()?.journal_mode,
          "delete",
        ),
      )
      assert.ok(Either.isLeft(opened))
      assert.equal(opened.left.code, "unsupported_schema")
    }))
}

for (const incompatible of ["future", "incomplete"]) {
  test(`rejected ${incompatible} schema does not change persistent journal mode`, async () =>
    fixture(async root => {
      const path = join(root, "registry.sqlite")
      await withStore(path, async store => {
        await run(store.ensurePlan(issue()))
      })
      sql(path, database => {
        assert.equal(
          database.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode,
          "delete",
        )
        database.exec(
          incompatible === "future"
            ? "UPDATE issue_plan_schema SET version = 3"
            : "DROP TABLE issue_plan_schema",
        )
      })
      await expectError(
        openSqlitePlanStore({ databasePath: path }),
        "unsupported_schema",
      )
      sql(path, database =>
        assert.equal(
          database.prepare("PRAGMA journal_mode").get()?.journal_mode,
          "delete",
        ),
      )
    }))
}
