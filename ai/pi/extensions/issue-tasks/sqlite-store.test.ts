import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
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
import test, { mock } from "node:test"
import { fileURLToPath } from "node:url"
import { Effect, Either, Option } from "effect"
import { makeSqliteRegistryStore } from "../agent-registry/sqlite-store.ts"
import { decodeIssueReference, type IssueReference } from "./identity.ts"
import {
  openSqliteTaskStore,
  type SqliteTaskStore,
  type TaskId,
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
  work: (store: SqliteTaskStore) => Promise<void>,
  busyTimeoutMs = 2_000,
) => {
  const store = await run(
    openSqliteTaskStore({ databasePath: path, busyTimeoutMs }),
  )
  try {
    await work(store)
  } finally {
    await run(store.close())
  }
}
const expectError = async <T, E extends { readonly code: string }>(
  operation: Effect.Effect<T, E>,
  code: E["code"],
) => {
  const result = await run(Effect.either(operation))
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, code)
}
const sql = <A>(path: string, work: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(path)
  try {
    return work(database)
  } finally {
    database.close()
  }
}
const ids: readonly [string, string, string] = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
]
const seedIssueRecord = (path: string, target = issue()): string =>
  sql(path, database => {
    const id = randomUUID()
    database
      .prepare(
        "INSERT INTO issue_plans (id, repository, issue_number, revision) VALUES (?, ?, ?, 0)",
      )
      .run(id, target.repository, target.number)
    return id
  })
const seedTask = (path: string, issueRowId: string, id: string, text: string) =>
  sql(path, database => {
    database
      .prepare(
        "INSERT INTO issue_plan_tasks (id, plan_id, text, status, blocker) VALUES (?, ?, ?, 'todo', NULL)",
      )
      .run(id, issueRowId, text)
  })
const appendTask = (store: SqliteTaskStore, target: IssueReference = issue()) =>
  store.apply(
    {
      issues: [target],
      operations: [
        {
          op: "add",
          issue: target,
          key: "fixture",
          text: "Persisted requirement",
        },
      ],
    },
    {
      actorId: "fixture-worker",
      requestId: randomUUID(),
      now: 1_000,
      cancellation: "forbidden",
    },
  )

test("single-task lookup returns issue revision, full task data and dependency addresses", async () =>
  fixture(async root => {
    const path = join(root, "tasks.sqlite")
    await withStore(path, async store => {
      const saved = await run(appendTask(store))
      const created = saved.created[0]
      assert.ok(created)

      const found = await run(store.readTask(issue(), created.id))

      assert.ok(Option.isSome(found))
      assert.deepEqual(found.value, {
        issue: issue(),
        revision: 1,
        task: {
          id: created.id,
          text: "Persisted requirement",
          status: "todo",
          blocker: null,
        },
        dependsOn: [],
      })
    })
  }))

test("single-task lookup keeps qualified owners distinct and returns missing without inference", async () =>
  fixture(async root => {
    const path = join(root, "tasks.sqlite")
    await withStore(path, async store => {
      const saved = await run(appendTask(store))
      const created = saved.created[0]
      assert.ok(created)

      assert.ok(
        Option.isNone(
          await run(store.readTask(issue("other/repo"), created.id)),
        ),
      )

      await run(appendTask(store, issue("other/repo")))

      assert.ok(
        Option.isNone(
          await run(store.readTask(issue("other/repo"), created.id)),
        ),
      )
      assert.ok(
        Option.isSome(
          await run(store.readTask(issue("0XGLEB/DOTCONFIG"), created.id)),
        ),
      )

      await run(store.close())

      await expectError(store.readTask(issue(), created.id), "closed")
    })
  }))

test("single-task lookup rejects malformed caller IDs even when the issue is absent", async () =>
  fixture(async root => {
    const path = join(root, "tasks.sqlite")
    await withStore(path, async store => {
      for (const id of [
        undefined,
        null,
        1,
        "not-a-uuid",
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      ])
        await expectError(
          store.readTask(issue(), id as TaskId),
          "invalid_input",
        )
    })
  }))

test("single-task lookup resolves current dependency owners after transfer and reopen", async () =>
  fixture(async root => {
    const path = join(root, "tasks.sqlite")
    const other = issue("other/repo")
    const destination = issue("third/repo")
    let mainId: TaskId | undefined
    let dependencyId: TaskId | undefined

    await withStore(path, async store => {
      const saved = await run(
        store.apply(
          {
            issues: [issue(), other],
            operations: [
              {
                op: "add",
                issue: other,
                key: "dependency",
                text: "Dependency",
              },
              {
                op: "add",
                issue: issue(),
                key: "main",
                text: "Main",
                dependsOn: [
                  { issue: other, task: { kind: "added", key: "dependency" } },
                ],
              },
            ],
          },
          {
            actorId: "reader",
            requestId: "seed-links",
            now: 1_000,
            cancellation: "forbidden",
          },
        ),
      )
      mainId = saved.created.find(task => task.key === "main")?.id
      dependencyId = saved.created.find(task => task.key === "dependency")?.id
      assert.ok(mainId && dependencyId)

      const found = await run(store.readTask(issue(), mainId))

      assert.ok(Option.isSome(found))
      assert.deepEqual(found.value.dependsOn, [
        { issue: other, id: dependencyId },
      ])

      await run(
        store.apply(
          {
            issues: [other, destination],
            operations: [
              {
                op: "transfer",
                target: {
                  issue: other,
                  task: { kind: "existing", id: dependencyId },
                },
                toIssue: destination,
              },
            ],
          },
          {
            actorId: "reader",
            requestId: "move-dependency",
            now: 2_000,
            cancellation: "forbidden",
          },
        ),
      )
    })

    await withStore(path, async store => {
      assert.ok(mainId && dependencyId)

      const found = await run(store.readTask(issue(), mainId))

      assert.ok(Option.isSome(found))
      assert.equal(found.value.revision, 1)
      assert.deepEqual(found.value.dependsOn, [
        { issue: destination, id: dependencyId },
      ])
    })
  }))

test("single-task lookup rejects dangling dependency edges instead of dropping them", async () =>
  fixture(async root => {
    const path = join(root, "tasks.sqlite")
    await withStore(path, async store => {
      const saved = await run(appendTask(store))
      const created = saved.created[0]
      assert.ok(created)
      sql(path, database => {
        database.exec("PRAGMA foreign_keys = OFF")
        database
          .prepare(
            "INSERT INTO issue_plan_dependencies (task_id, depends_on_id) VALUES (?, ?)",
          )
          .run(created.id, ids[0])
      })

      await expectError(store.readTask(issue(), created.id), "corrupt_state")
    })
  }))

test("single-task lookup bounds dependency cardinality before decoding addresses", async () =>
  fixture(async root => {
    const path = join(root, "tasks.sqlite")
    await withStore(path, async store => {
      const saved = await run(appendTask(store))
      const created = saved.created[0]
      assert.ok(created)
      sql(path, database => {
        const owner = database
          .prepare("SELECT plan_id FROM issue_plan_tasks WHERE id = ?")
          .get(created.id)
        assert.ok(owner && typeof owner.plan_id === "string")
        const add = database.prepare(
          "INSERT INTO issue_plan_tasks (id, plan_id, text, status) VALUES (?, ?, 'Dependency', 'todo')",
        )
        const edge = database.prepare(
          "INSERT INTO issue_plan_dependencies (task_id, depends_on_id) VALUES (?, ?)",
        )
        database.exec("BEGIN")
        for (let index = 0; index < 1_000; index += 1) {
          const id = randomUUID()
          add.run(id, owner.plan_id)
          edge.run(created.id, id)
        }
        database.exec("COMMIT")
      })

      const boundary = await run(store.readTask(issue(), created.id))

      assert.ok(Option.isSome(boundary))
      assert.equal(boundary.value.dependsOn.length, 1_000)

      sql(path, database => {
        const owner = database
          .prepare("SELECT plan_id FROM issue_plan_tasks WHERE id = ?")
          .get(created.id)
        assert.ok(owner && typeof owner.plan_id === "string")
        const id = randomUUID()
        database
          .prepare(
            "INSERT INTO issue_plan_tasks (id, plan_id, text, status) VALUES (?, ?, 'Extra', 'todo')",
          )
          .run(id, owner.plan_id)
        database
          .prepare(
            "INSERT INTO issue_plan_dependencies (task_id, depends_on_id) VALUES (?, ?)",
          )
          .run(created.id, id)
      })

      await expectError(store.readTask(issue(), created.id), "capacity")
    })
  }))

test("single-task lookup rejects noncanonical dependency owner metadata", async () =>
  fixture(async root => {
    const path = join(root, "tasks.sqlite")
    const other = issue("other/repo")
    await withStore(path, async store => {
      const saved = await run(
        store.apply(
          {
            issues: [issue(), other],
            operations: [
              {
                op: "add",
                issue: other,
                key: "dependency",
                text: "Dependency",
              },
              {
                op: "add",
                issue: issue(),
                key: "main",
                text: "Main",
                dependsOn: [
                  { issue: other, task: { kind: "added", key: "dependency" } },
                ],
              },
            ],
          },
          {
            actorId: "reader",
            requestId: "bad-dependency-owner",
            now: 1_000,
            cancellation: "forbidden",
          },
        ),
      )
      const main = saved.created.find(task => task.key === "main")
      assert.ok(main)

      sql(path, database =>
        database
          .prepare(
            "UPDATE issue_plans SET repository = 'OTHER/REPO' WHERE repository = ?",
          )
          .run(other.repository),
      )

      await expectError(store.readTask(issue(), main.id), "corrupt_state")
    })
  }))

for (const order of ["registry-first", "tasks-first"]) {
  test(`issue tasks coexist with the real registry: ${order}`, async () =>
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
        let persistedTaskId: string | undefined
        await withStore(path, async store => {
          const write = appendTask(store)
          const first = await run(write)
          const second = await run(write)
          persistedTaskId = first.created[0]?.id
          assert.ok(persistedTaskId)
          assert.equal(second.receipt, "replayed")
          assert.deepEqual(second.created, first.created)
          assert.deepEqual(second.issues, [{ issue: issue(), revision: 1 }])
          if (order === "tasks-first") await populateRegistry()
        })
        const snapshot = await run(registry.snapshot(1_000))
        assert.equal(snapshot.requests.length, 1)
        if (request) assert.equal(snapshot.requests[0]?.id, request.id)
        await withStore(path, async store => {
          const page = await run(store.readTasks(issue(), { limit: 10 }))
          assert.ok(Option.isSome(page))
          assert.deepEqual(page.value.issue, issue())
          assert.equal(page.value.revision, 1)
          assert.equal(page.value.tasks[0]?.id, persistedTaskId)
        })
        sql(path, database => {
          assert.equal(
            database.prepare("PRAGMA user_version").get()?.user_version,
            5,
          )
          assert.equal(
            database.prepare("SELECT COUNT(*) AS count FROM issue_plans").get()
              ?.count,
            1,
          )
        })
      } finally {
        registry.close()
      }
    }))
}

test("qualified issue task pages survive reopening without worker presence", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async () => {
      const first = seedIssueRecord(path)
      const other = seedIssueRecord(path, issue("dataclique/yielduck"))
      seedTask(path, first, ids[0], "First requirement")
      seedTask(path, first, ids[1], "Second requirement")
      seedTask(path, other, ids[2], "Different repository")
    })
    await withStore(path, async store => {
      const first = await run(store.readTasks(issue(), { limit: 1 }))
      assert.ok(Option.isSome(first))
      assert.deepEqual(
        first.value.tasks.map(task => task.text),
        ["First requirement"],
      )
      assert.ok(first.value.next)
      const next = await run(
        store.readTasks(issue(), { limit: 1, after: first.value.next }),
      )
      assert.ok(Option.isSome(next))
      assert.deepEqual(
        next.value.tasks.map(task => task.id),
        [ids[1]],
      )
      assert.equal(next.value.next, null)
      const other = await run(
        store.readTasks(issue("dataclique/yielduck"), { limit: 1 }),
      )
      assert.ok(Option.isSome(other))
      const foreign = other.value.tasks[0]
      assert.ok(foreign)
      await expectError(
        store.readTasks(issue(), { limit: 1, after: foreign.id }),
        "invalid_input",
      )
      assert.ok(
        Option.isNone(
          await run(store.readTasks(issue("owner/missing"), { limit: 10 })),
        ),
      )
    })
  }))

test("a separate process reads the same persisted issue tasks", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async () => {
      const row = seedIssueRecord(path)
      seedTask(path, row, ids[0], "Visible across processes")
      const worker = fileURLToPath(
        new URL("./sqlite-store.worker.ts", import.meta.url),
      )
      const output = execFileSync(process.execPath, [worker, path], {
        encoding: "utf8",
        timeout: 10_000,
      })
      assert.deepEqual(JSON.parse(output), {
        issue: issue(),
        revision: 0,
        taskIds: [ids[0]],
        text: "Visible across processes",
      })
    })
  }))

test("malformed persisted task identity fails instead of returning partial tasks", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async store => {
      const row = seedIssueRecord(path)
      seedTask(path, row, ids[0], "Valid first row")
      seedTask(
        path,
        row,
        "malformed-uuid",
        "A foreign writer inserted this row",
      )
      await expectError(store.readTasks(issue(), { limit: 1 }), "corrupt_state")
      sql(path, database =>
        database
          .prepare("DELETE FROM issue_plan_tasks WHERE id = ?")
          .run("malformed-uuid"),
      )
      const recovered = await run(store.readTasks(issue(), { limit: 1 }))
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
      await run(appendTask(store))
      sql(path, database =>
        database.exec(
          "UPDATE issue_plan_schema SET version = 5; PRAGMA user_version = 5;",
        ),
      )
      await expectError(
        store.readTasks(issue(), { limit: 10 }),
        "unsupported_schema",
      )
      await expectError(
        appendTask(store, issue("owner/other")),
        "unsupported_schema",
      )
    })
    await expectError(
      openSqliteTaskStore({ databasePath: path }),
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
        5,
      )
    })
  }))

test("page bounds and closed connections fail explicitly", async () =>
  fixture(async root => {
    const store = await run(
      openSqliteTaskStore({ databasePath: join(root, "registry.sqlite") }),
    )
    try {
      for (const limit of [0, -1, 101, 1.5, Number.NaN])
        await expectError(store.readTasks(issue(), { limit }), "invalid_input")
    } finally {
      await run(store.close())
    }
    await expectError(store.readTasks(issue(), { limit: 10 }), "closed")
    await expectError(appendTask(store), "closed")
    await run(store.close())
  }))

test("symlink database paths are rejected before touching their target", async () =>
  fixture(async root => {
    const target = join(root, "target.txt")
    writeFileSync(target, "untouched fixture", { mode: 0o600 })
    const path = join(root, "registry.sqlite")
    symlinkSync(target, path)
    await expectError(
      openSqliteTaskStore({ databasePath: path }),
      "invalid_path",
    )
    assert.equal(readFileSync(target, "utf8"), "untouched fixture")
  }))

test("writer lock exhaustion is typed and never creates partial issue tasks", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async () => {})
    const lock = new DatabaseSync(path)
    try {
      lock.exec("BEGIN IMMEDIATE")
      await withStore(
        path,
        async store => {
          await expectError(appendTask(store), "busy")
          lock.exec("ROLLBACK")
          assert.ok(
            Option.isNone(await run(store.readTasks(issue(), { limit: 10 }))),
          )
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
    await withStore(path, async () => {
      seedIssueRecord(path)
    })
    sql(path, database => database.exec("DROP TABLE issue_plan_schema"))
    await expectError(
      openSqliteTaskStore({ databasePath: path }),
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
      const first = await run(
        store.apply(
          {
            issues: [{ repository: "0xGleb/DotConfig", number: 1 }],
            operations: [
              {
                op: "add",
                issue: { repository: "0xGleb/DotConfig", number: 1 },
                key: "first",
                text: "Canonical issue",
              },
            ],
          },
          {
            actorId: "fixture",
            requestId: "canonical",
            now: 1_000,
            cancellation: "forbidden",
          },
        ),
      )
      assert.deepEqual(first.issues, [{ issue: issue(), revision: 1 }])
      await run(appendTask(store))
      sql(path, database =>
        assert.equal(
          database.prepare("SELECT COUNT(*) AS count FROM issue_plans").get()
            ?.count,
          1,
        ),
      )
      const extraIssue = { ...issue(), expectedRevisions: {} }
      const extraPage = { limit: 10, expectedRevisions: {} }
      await expectError(
        store.readTasks(extraIssue, { limit: 10 }),
        "invalid_input",
      )
      await expectError(store.readTasks(issue(), extraPage), "invalid_input")
      const id = first.created[0]?.id
      assert.ok(id)
      sql(path, database =>
        database
          .prepare("UPDATE issue_plan_tasks SET blocker = ? WHERE id = ?")
          .run("   ", id),
      )
      await expectError(
        store.readTasks(issue(), { limit: 10 }),
        "corrupt_state",
      )
    })
  }))

for (const corruption of ["noncanonical-only", "canonical-duplicate"]) {
  test(`reads and writes reject corrupted qualified issue identity: ${corruption}`, async () =>
    fixture(async root => {
      const path = join(root, "registry.sqlite")
      await withStore(path, async store => {
        seedIssueRecord(path)
        sql(path, database => {
          if (corruption === "noncanonical-only")
            database
              .prepare("UPDATE issue_plans SET repository = ?")
              .run("0xGleb/DotConfig")
          else
            database
              .prepare(
                "INSERT INTO issue_plans (id, repository, issue_number, revision) VALUES (?, ?, 1, 0)",
              )
              .run(randomUUID(), "0xGleb/DotConfig")
        })
        await expectError(
          store.readTasks(issue(), { limit: 10 }),
          "corrupt_state",
        )
        await expectError(appendTask(store), "corrupt_state")
      })
    }))
}

test("production qualified-issue lookups use a bounded index for existing and absent issues", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    const repository = "fixture/large"
    await withStore(path, async store => {
      sql(path, database => {
        database.exec("BEGIN IMMEDIATE")
        const insert = database.prepare(
          "INSERT INTO issue_plans (id, repository, issue_number, revision) VALUES (?, ?, ?, 0)",
        )
        for (let number = 1; number <= 10_000; number++)
          insert.run(randomUUID(), repository, number)
        database.exec("COMMIT")
      })
      const lookups: string[] = []
      const prepare = DatabaseSync.prototype.prepare
      const tracked = mock.method(
        DatabaseSync.prototype,
        "prepare",
        function (this: DatabaseSync, query: string) {
          if (query.includes("FROM issue_plans WHERE repository ="))
            lookups.push(query)
          return prepare.call(this, query)
        },
      )
      try {
        assert.ok(
          Option.isSome(
            await run(store.readTasks(issue(repository, 5_000), { limit: 1 })),
          ),
        )
        assert.ok(
          Option.isNone(
            await run(store.readTasks(issue(repository, 10_001), { limit: 1 })),
          ),
        )
        await run(appendTask(store, issue(repository, 5_000)))
        await run(appendTask(store, issue(repository, 10_001)))
      } finally {
        tracked.mock.restore()
      }
      assert.ok(lookups.length >= 4)
      sql(path, database => {
        for (const query of new Set(lookups)) {
          for (const number of [5_000, 10_001]) {
            const plan = database
              .prepare(`EXPLAIN QUERY PLAN ${query}`)
              .all(repository, number)
            assert.ok(
              plan.some(
                row =>
                  typeof row.detail === "string" &&
                  row.detail.includes(
                    "SEARCH issue_plans USING INDEX issue_plan_issues_nocase",
                  ),
              ),
            )
          }
        }
      })
    })
  }))

test("a matching-column schema without issue uniqueness is rejected", async () =>
  fixture(async root => {
    const path = join(root, "registry.sqlite")
    await withStore(path, async () => {})
    sql(path, database => {
      database.exec(`DROP TABLE issue_plans;
        CREATE TABLE issue_plans (
          id TEXT PRIMARY KEY,
          repository TEXT NOT NULL,
          issue_number INTEGER NOT NULL CHECK (issue_number BETWEEN 1 AND 9007199254740991),
          revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991)
        ) STRICT;`)
      const insert = database.prepare(
        "INSERT INTO issue_plans (id, repository, issue_number, revision) VALUES (?, '0xgleb/dotconfig', 1, 0)",
      )
      insert.run(ids[0])
      insert.run(ids[1])
    })
    const opened = await run(
      Effect.either(openSqliteTaskStore({ databasePath: path })),
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
        Effect.either(openSqliteTaskStore({ databasePath: path })),
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
      await withStore(path, async () => {})
      sql(path, database => {
        assert.equal(
          database.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode,
          "delete",
        )
        database.exec(
          incompatible === "future"
            ? "UPDATE issue_plan_schema SET version = 5"
            : "DROP TABLE issue_plan_schema",
        )
      })
      await expectError(
        openSqliteTaskStore({ databasePath: path }),
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
