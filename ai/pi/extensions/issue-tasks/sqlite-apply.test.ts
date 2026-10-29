import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Cause, Deferred, Effect, Either, Exit, Fiber, Option } from "effect"
import { makeSqliteRegistryStore } from "../agent-registry/sqlite-store.ts"
import { decodeIssueReference } from "./identity.ts"
import {
  openSqliteTaskStore,
  type SqliteTaskStore,
  type TaskApplyContext,
} from "./sqlite-store.ts"

import { MAX_TRANSITION_TEXT } from "./transition.ts"
import type { MutationBatchId } from "./model.ts"

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
const withStore = async <A>(
  path: string,
  work: (store: SqliteTaskStore) => Promise<A>,
): Promise<A> => {
  const store = await run(
    openSqliteTaskStore({ databasePath: path, busyTimeoutMs: 0 }),
  )
  try {
    return await work(store)
  } finally {
    await run(store.close())
  }
}
const sql = <A>(path: string, work: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(path)
  try {
    return work(database)
  } finally {
    database.close()
  }
}
const receiptJson = (path: string, id: MutationBatchId): string =>
  sql(path, database => {
    const row = database
      .prepare("SELECT result_json FROM issue_plan_batches WHERE id = ?")
      .get(id)
    assert.ok(row && typeof row.result_json === "string")
    return row.result_json
  })
const writeReceiptJson = (path: string, id: MutationBatchId, json: string) =>
  sql(path, database =>
    database
      .prepare("UPDATE issue_plan_batches SET result_json = ? WHERE id = ?")
      .run(json, id),
  )
const forgeReceiptFields = (
  path: string,
  id: MutationBatchId,
  fields: readonly string[],
  index = 0,
) => {
  const original = receiptJson(path, id)
  const receipt: unknown = JSON.parse(original)
  assert.ok(
    typeof receipt === "object" && receipt !== null && "changed" in receipt,
  )
  assert.ok(Array.isArray(receipt.changed))
  const changed: unknown = receipt.changed[index]
  assert.ok(
    typeof changed === "object" && changed !== null && "fields" in changed,
  )
  changed.fields = fields
  const tampered = JSON.stringify(receipt)
  writeReceiptJson(path, id, tampered)
  return { original, tampered }
}

// Keep the published c2cb44c1 v2 declaration independent of current history DDL.
const restoreVersionTwoHistory = (path: string) =>
  sql(path, database =>
    database.exec(`
    BEGIN IMMEDIATE;
    DROP INDEX IF EXISTS issue_plan_issues_nocase;
    ALTER TABLE issue_plan_history RENAME TO fixture_previous_history;
    CREATE TABLE issue_plan_history (
      sequence INTEGER PRIMARY KEY CHECK (sequence BETWEEN 1 AND 9007199254740991),
      batch_id TEXT NOT NULL REFERENCES issue_plan_batches(id),
      plan_id TEXT NOT NULL REFERENCES issue_plans(id),
      task_id TEXT NOT NULL REFERENCES issue_plan_tasks(id),
      operation_index INTEGER NOT NULL CHECK (operation_index BETWEEN 0 AND 999),
      kind TEXT NOT NULL CHECK (kind IN ('add', 'edit', 'status', 'block')),
      recorded_at INTEGER NOT NULL CHECK (recorded_at BETWEEN 0 AND 9007199254740991),
      payload_json TEXT NOT NULL,
      UNIQUE (batch_id, operation_index)
    ) STRICT;
    INSERT INTO issue_plan_history SELECT * FROM fixture_previous_history;
    DROP TABLE fixture_previous_history;
    CREATE INDEX issue_plan_history_by_task ON issue_plan_history (task_id, sequence);
    UPDATE issue_plan_schema SET version = 2;
    COMMIT;
  `),
  )

const errorCode = async <T, E extends { readonly code: string }>(
  effect: Effect.Effect<T, E>,
  expected: string,
) => {
  const value = await run(Effect.either(effect))
  assert.ok(Either.isLeft(value))
  assert.equal(value.left.code, expected)
}

test("issue-addressed task writes and reads expose issue revisions without an independent container", async () =>
  fixture(async path => {
    await withStore(path, async store => {
      const saved = await run(
        store.apply(
          batch(
            [{ op: "add", issue: a, key: "only", text: "Issue requirement" }],
            [a],
          ),
          context("issue-only-contract"),
        ),
      )
      const created = saved.created[0]
      assert.ok(created)
      assert.deepEqual(saved, {
        kind: "saved",
        receipt: "committed",
        batchId: saved.batchId,
        issues: [{ issue: a, revision: 1 }],
        changed: [
          {
            issue: a,
            id: created.id,
            revision: 1,
            fields: ["text", "status", "blocker", "dependsOn"],
          },
        ],
        created: [{ issue: a, key: "only", id: created.id }],
        eventCount: 1,
      })
      const page = await run(store.readTasks(issue(), { limit: 10 }))
      assert.ok(Option.isSome(page))
      assert.deepEqual(page.value, {
        issue: a,
        revision: 1,
        tasks: [
          {
            id: created.id,
            text: "Issue requirement",
            status: "todo",
            blocker: null,
          },
        ],
        next: null,
      })
      assert.equal("ensurePlan" in store, false)
    })
  }))

for (const change of ["add", "edit", "block"]) {
  test(`final task text budget admits the boundary and rejects overflowing ${change}`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        const largeText = "x".repeat(131_072)
        assert.equal(largeText.length * 64, MAX_TRANSITION_TEXT)
        const ids: string[] = []
        for (let index = 0; index < 64; index++) {
          const seeded = await run(
            store.apply(
              batch(
                [
                  {
                    op: "add",
                    issue: a,
                    key: "seed",
                    text: index === 63 ? largeText.slice(2) : largeText,
                  },
                ],
                [a],
              ),
              context(`text-seed-${index}`),
            ),
          )
          const created = seeded.created[0]
          assert.ok(created)
          ids.push(created.id)
        }
        const small = await run(
          store.apply(
            batch([{ op: "add", issue: a, key: "small", text: "x" }], [a]),
            context("text-small"),
          ),
        )
        const target = small.created[0]
        assert.ok(target)
        ids.push(target.id)
        const noOps = (targets: readonly string[]) =>
          targets.map(id => ({
            op: "status",
            target: existing(id),
            status: "todo",
          }))
        const boundaryOperation =
          change === "add"
            ? { op: "add", issue: a, key: "boundary", text: "x" }
            : change === "edit"
              ? { op: "edit", target: existing(target.id), text: "xx" }
              : { op: "block", target: existing(target.id), reason: "x" }
        const boundary = await run(
          store.apply(
            batch([...noOps(ids), boundaryOperation], [a]),
            context("text-boundary"),
          ),
        )
        const loadedIds = [
          ...ids,
          ...boundary.created.map(created => created.id),
        ]
        const overflowOperation =
          change === "add"
            ? { op: "add", issue: a, key: "overflow", text: "x" }
            : change === "edit"
              ? { op: "edit", target: existing(target.id), text: "xxx" }
              : { op: "block", target: existing(target.id), reason: "xx" }
        await errorCode(
          store.apply(
            batch([...noOps(loadedIds), overflowOperation], [a]),
            context("text-overflow"),
          ),
          "capacity",
        )
        const after = await run(store.readTasks(issue(), { limit: 100 }))
        assert.ok(Option.isSome(after))
        assert.equal(after.value.revision, boundary.issues[0]?.revision)
        assert.equal(after.value.tasks.length, loadedIds.length)
        const unchanged = after.value.tasks.find(row => row.id === target.id)
        assert.ok(unchanged)
        assert.equal(unchanged.text, change === "edit" ? "xx" : "x")
        assert.equal(unchanged.blocker, change === "block" ? "x" : null)
      })
    }))
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
      assert.equal(saved.issues.length, 2)
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
      const first = await run(store.readTasks(issue(), { limit: 10 }))
      const second = await run(store.readTasks(issue(b), { limit: 10 }))
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

test("cross-issue transfer preserves task identity, state, dependency edges and history across reopen", async () =>
  fixture(async path => {
    let dependencyId = ""
    let movedId = ""
    let residentId = ""
    const seed = batch([
      { op: "add", issue: a, key: "dependency", text: "Source dependency" },
      {
        op: "add",
        issue: a,
        key: "moved",
        text: "Completed requirement",
        dependsOn: [added("dependency")],
      },
      {
        op: "add",
        issue: b,
        key: "resident",
        text: "Destination requirement",
        dependsOn: [added("moved")],
      },
      { op: "status", target: added("moved"), status: "done" },
      {
        op: "block",
        target: added("moved"),
        reason: "External input remains documented",
      },
    ])
    await withStore(path, async store => {
      const original = await run(store.apply(seed, context("transfer-seed")))
      const dependency = original.created.find(row => row.key === "dependency")
      const moved = original.created.find(row => row.key === "moved")
      const resident = original.created.find(row => row.key === "resident")
      assert.ok(dependency && moved && resident)
      dependencyId = dependency.id
      movedId = moved.id
      residentId = resident.id
      let priorHistory: readonly unknown[] = []
      sql(path, database => {
        priorHistory = database
          .prepare("SELECT * FROM issue_plan_history ORDER BY sequence")
          .all()
      })
      assert.equal(priorHistory.length, 5)

      const saved = await run(
        store.apply(
          batch([{ op: "transfer", target: existing(movedId), toIssue: b }]),
          context("transfer-existing"),
        ),
      )
      assert.equal(saved.receipt, "committed")
      assert.equal(saved.eventCount, 1)
      assert.deepEqual(saved.created, [])
      assert.deepEqual(saved.changed, [
        { issue: issue(b), id: movedId, revision: 2, fields: ["issue"] },
      ])
      assert.equal(saved.issues.length, 2)
      for (const qualified of [a, b]) {
        assert.equal(
          saved.issues.find(
            plan =>
              plan.issue.repository === qualified.repository &&
              plan.issue.number === qualified.number,
          )?.revision,
          2,
        )
      }
      const source = await run(store.readTasks(issue(), { limit: 10 }))
      const destination = await run(store.readTasks(issue(b), { limit: 10 }))
      assert.ok(Option.isSome(source) && Option.isSome(destination))
      assert.deepEqual(
        source.value.tasks.map(task => task.id),
        [dependencyId],
      )
      assert.equal(destination.value.tasks.length, 2)
      assert.deepEqual(
        destination.value.tasks.find(task => task.id === movedId),
        {
          id: movedId,
          text: "Completed requirement",
          status: "done",
          blocker: "External input remains documented",
        },
      )
      sql(path, database => {
        const history = database
          .prepare("SELECT * FROM issue_plan_history ORDER BY sequence")
          .all()
        assert.deepEqual(history.slice(0, priorHistory.length), priorHistory)
        assert.equal(history.length, priorHistory.length + 1)
        const transfer = history.at(-1)
        assert.ok(transfer && typeof transfer.payload_json === "string")
        assert.equal(transfer.task_id, movedId)
        assert.equal(transfer.kind, "transfer")
        const payload: unknown = JSON.parse(transfer.payload_json)
        assert.deepEqual(payload, {
          op: "transfer",
          operationIndex: 0,
          issue: b,
          id: movedId,
          splitFrom: a,
        })
        const edges = database
          .prepare("SELECT task_id, depends_on_id FROM issue_plan_dependencies")
          .all()
        assert.equal(edges.length, 2)
        assert.ok(
          edges.some(
            edge =>
              edge.task_id === movedId && edge.depends_on_id === dependencyId,
          ),
        )
        assert.ok(
          edges.some(
            edge =>
              edge.task_id === residentId && edge.depends_on_id === movedId,
          ),
        )
      })
      await errorCode(
        store.apply(
          batch([
            {
              op: "edit",
              target: existing(movedId),
              text: "Reject the stale owner",
            },
          ]),
          context("transfer-stale-owner"),
        ),
        "scope_mismatch",
      )
      const currentOwner = await run(
        store.apply(
          batch([
            { op: "status", target: existing(movedId, b), status: "done" },
          ]),
          context("transfer-current-owner"),
        ),
      )
      assert.deepEqual(currentOwner.issues, [])
      assert.equal(currentOwner.eventCount, 0)
      const replay = await run(store.apply(seed, context("transfer-seed")))
      assert.equal(replay.receipt, "replayed")
      assert.equal(replay.batchId, original.batchId)
      assert.deepEqual(replay.created, original.created)
    })
    await withStore(path, async store => {
      const source = await run(store.readTasks(issue(), { limit: 10 }))
      const destination = await run(store.readTasks(issue(b), { limit: 10 }))
      assert.ok(Option.isSome(source) && Option.isSome(destination))
      assert.equal(source.value.revision, 2)
      assert.equal(destination.value.revision, 2)
      assert.deepEqual(
        source.value.tasks.map(task => task.id),
        [dependencyId],
      )
      assert.equal(destination.value.tasks.length, 2)
      assert.equal(
        destination.value.tasks.find(task => task.id === movedId)?.status,
        "done",
      )
    })
  }))

for (const omittedIndex of [0, 1]) {
  test(`transfer replay rejects an omitted affected issue revision: ${omittedIndex}`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        const seed = await run(
          store.apply(
            batch(
              [
                {
                  op: "add",
                  issue: a,
                  key: "source",
                  text: "Transfer requirement",
                },
              ],
              [a],
            ),
            context("receipt-transfer-seed"),
          ),
        )
        const task = seed.created[0]
        assert.ok(task)
        const transfer = batch([
          { op: "transfer", target: existing(task.id), toIssue: b },
        ])
        const transferContext = context("receipt-transfer")
        const saved = await run(store.apply(transfer, transferContext))
        assert.deepEqual(saved.issues, [
          { issue: a, revision: 2 },
          { issue: b, revision: 1 },
        ])
        sql(path, database => {
          const row = database
            .prepare("SELECT result_json FROM issue_plan_batches WHERE id = ?")
            .get(saved.batchId)
          assert.ok(row && typeof row.result_json === "string")
          const receipt: unknown = JSON.parse(row.result_json)
          assert.ok(
            typeof receipt === "object" &&
              receipt !== null &&
              "plans" in receipt,
          )
          assert.ok(Array.isArray(receipt.plans))
          assert.equal(receipt.plans.length, 2)
          receipt.plans.splice(omittedIndex, 1)
          database
            .prepare(
              "UPDATE issue_plan_batches SET result_json = ? WHERE id = ?",
            )
            .run(JSON.stringify(receipt), saved.batchId)
        })
        await errorCode(store.apply(transfer, transferContext), "corrupt_state")
      })
    }))
}

test("task transfer initializes destination issue state without a separate create operation", async () =>
  fixture(async path => {
    await withStore(path, async store => {
      const initial = await run(
        store.apply(
          batch(
            [
              {
                op: "add",
                issue: a,
                key: "source",
                text: "Move this requirement",
              },
            ],
            [a],
          ),
          context("fresh-destination-source"),
        ),
      )
      const task = initial.created[0]
      assert.ok(task)
      const moved = await run(
        store.apply(
          batch([{ op: "transfer", target: existing(task.id), toIssue: b }]),
          context("fresh-destination-transfer"),
        ),
      )
      assert.deepEqual(moved.issues, [
        { issue: a, revision: 2 },
        { issue: b, revision: 1 },
      ])
      assert.deepEqual(moved.created, [])
      const source = await run(store.readTasks(issue(), { limit: 10 }))
      const destination = await run(store.readTasks(issue(b), { limit: 10 }))
      assert.ok(Option.isSome(source) && Option.isSome(destination))
      assert.deepEqual(source.value.tasks, [])
      assert.deepEqual(
        destination.value.tasks.map(row => row.id),
        [task.id],
      )
    })
  }))

test("a failed late target leaves no issue state, task, receipt or history from the batch", async () =>
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
        Option.isNone(await run(store.readTasks(issue(), { limit: 10 }))),
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
        Option.isNone(await run(store.readTasks(issue(), { limit: 10 }))),
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

test("request replay rejects a changed-field summary inconsistent with add history", async () =>
  fixture(async path => {
    await withStore(path, async store => {
      const input = batch(
        [{ op: "add", issue: a, key: "first", text: "Retain the requirement" }],
        [a],
      )
      const request = context("receipt-fields")
      const saved = await run(store.apply(input, request))
      assert.deepEqual(saved.changed[0]?.fields, [
        "text",
        "status",
        "blocker",
        "dependsOn",
      ])
      const before = await run(store.readTasks(issue(), { limit: 10 }))
      sql(path, database => {
        const row = database
          .prepare("SELECT result_json FROM issue_plan_batches WHERE id = ?")
          .get(saved.batchId)
        assert.ok(row && typeof row.result_json === "string")
        const receipt: unknown = JSON.parse(row.result_json)
        assert.ok(
          typeof receipt === "object" &&
            receipt !== null &&
            "changed" in receipt,
        )
        assert.ok(Array.isArray(receipt.changed))
        const changed: unknown = receipt.changed[0]
        assert.ok(
          typeof changed === "object" &&
            changed !== null &&
            "fields" in changed,
        )
        changed.fields = ["status"]
        database
          .prepare("UPDATE issue_plan_batches SET result_json = ? WHERE id = ?")
          .run(JSON.stringify(receipt), saved.batchId)
      })
      await errorCode(store.apply(input, request), "corrupt_state")
      assert.deepEqual(
        await run(store.readTasks(issue(), { limit: 10 })),
        before,
      )
      sql(path, database => {
        assert.equal(
          database
            .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
            .get()?.count,
          1,
        )
        assert.equal(
          database
            .prepare("SELECT COUNT(*) AS count FROM issue_plan_batches")
            .get()?.count,
          1,
        )
      })
    })
  }))

for (const omitted of ["text", "status", "blocker", "dependsOn"]) {
  test(`add receipt requires its complete history field union: ${omitted}`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        const input = batch(
          [
            {
              op: "add",
              issue: a,
              key: "only",
              text: "Keep all changed fields",
            },
          ],
          [a],
        )
        const request = context(`missing-${omitted}`)
        const saved = await run(store.apply(input, request))
        const changed = saved.changed[0]
        assert.ok(changed)
        const before = await run(store.readTasks(issue(), { limit: 10 }))
        const forged = forgeReceiptFields(
          path,
          saved.batchId,
          changed.fields.filter(field => field !== omitted),
        )
        await errorCode(store.apply(input, request), "corrupt_state")
        assert.equal(receiptJson(path, saved.batchId), forged.tampered)
        assert.deepEqual(
          await run(store.readTasks(issue(), { limit: 10 })),
          before,
        )
        sql(path, database =>
          assert.equal(
            database
              .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
              .get()?.count,
            1,
          ),
        )
      })
    }))
}

for (const kind of ["status", "block", "transfer"]) {
  for (const corruption of ["extra", "substituted"]) {
    test(`${kind} receipt rejects ${corruption} recognized fields`, async () =>
      fixture(async path => {
        await withStore(path, async store => {
          const initial = await run(
            store.apply(
              batch(
                [
                  {
                    op: "add",
                    issue: a,
                    key: "task",
                    text: "Preserve the actual event",
                  },
                ],
                [a],
              ),
              context("field-event-seed"),
            ),
          )
          const task = initial.created[0]
          assert.ok(task)
          const operation =
            kind === "status"
              ? { op: "status", target: existing(task.id), status: "doing" }
              : kind === "block"
                ? {
                    op: "block",
                    target: existing(task.id),
                    reason: "Awaiting external input",
                  }
                : { op: "transfer", target: existing(task.id), toIssue: b }
          const input = batch([operation])
          const request = context("field-event")
          const saved = await run(store.apply(input, request))
          const changed = saved.changed[0]
          assert.ok(changed)
          assert.equal(changed.fields.length, 1)
          const owner = kind === "transfer" ? issue(b) : issue()
          const before = await run(store.readTasks(owner, { limit: 10 }))
          const fields =
            corruption === "extra" ? [...changed.fields, "text"] : ["text"]
          const forged = forgeReceiptFields(path, saved.batchId, fields)
          await errorCode(store.apply(input, request), "corrupt_state")
          assert.equal(receiptJson(path, saved.batchId), forged.tampered)
          assert.deepEqual(
            await run(store.readTasks(owner, { limit: 10 })),
            before,
          )
          sql(path, database =>
            assert.equal(
              database
                .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
                .get()?.count,
              2,
            ),
          )
        })
      }))
  }
}

for (const mode of ["text", "dependsOn", "both"]) {
  test(`edit receipt replays only its actual ${mode} field union after later mutations and reopen`, async () =>
    fixture(async path => {
      const original = await withStore(path, async store => {
        const seeded = await run(
          store.apply(
            batch(
              [
                { op: "add", issue: a, key: "dependency", text: "Dependency" },
                {
                  op: "add",
                  issue: a,
                  key: "work",
                  text: "Original requirement",
                  dependsOn: [added("dependency")],
                },
              ],
              [a],
            ),
            context("edit-fields-seed"),
          ),
        )
        const dependency = seeded.created.find(row => row.key === "dependency")
        const task = seeded.created.find(row => row.key === "work")
        assert.ok(dependency && task)
        const input = batch(
          [
            {
              op: "edit",
              target: existing(task.id),
              text:
                mode === "dependsOn"
                  ? "Original requirement"
                  : "x".repeat(5_000),
              dependsOn: mode === "text" ? [existing(dependency.id)] : [],
            },
          ],
          [a],
        )
        const request = context("edit-fields")
        const saved = await run(store.apply(input, request))
        const fields = mode === "both" ? ["text", "dependsOn"] : [mode]
        assert.deepEqual(saved.changed[0]?.fields, fields)
        if (mode !== "dependsOn")
          sql(path, database => {
            const row = database
              .prepare(
                "SELECT length(payload_json) AS size FROM issue_plan_history WHERE batch_id = ?",
              )
              .get(saved.batchId)
            assert.ok(row && typeof row.size === "number" && row.size > 4_096)
          })
        assert.deepEqual(
          (await run(store.apply(input, request))).changed,
          saved.changed,
        )
        const wrong =
          mode === "both" ? [["text"], ["dependsOn"]] : [["text", "dependsOn"]]
        for (const fields of wrong) {
          const forged = forgeReceiptFields(path, saved.batchId, fields)
          const before = await run(store.readTasks(issue(), { limit: 10 }))
          await errorCode(store.apply(input, request), "corrupt_state")
          assert.equal(receiptJson(path, saved.batchId), forged.tampered)
          assert.deepEqual(
            await run(store.readTasks(issue(), { limit: 10 })),
            before,
          )
          writeReceiptJson(path, saved.batchId, forged.original)
        }
        await run(
          store.apply(
            batch([
              {
                op: "edit",
                target: existing(task.id),
                text: "Later requirement",
                dependsOn: [],
              },
              { op: "status", target: existing(task.id), status: "done" },
              { op: "transfer", target: existing(task.id), toIssue: b },
            ]),
            context("after-edit-fields"),
          ),
        )
        return { input, request, saved }
      })
      await withStore(path, async store => {
        const replay = await run(store.apply(original.input, original.request))
        assert.equal(replay.receipt, "replayed")
        assert.deepEqual(replay.changed, original.saved.changed)
        assert.deepEqual(replay.issues, original.saved.issues)
      })
    }))
}

test("receipt field unions retain net-zero events but exclude no-op edit requests", async () =>
  fixture(async path => {
    await withStore(path, async store => {
      const seeded = await run(
        store.apply(
          batch(
            [
              { op: "add", issue: a, key: "first", text: "First dependency" },
              { op: "add", issue: a, key: "second", text: "Second dependency" },
              {
                op: "add",
                issue: a,
                key: "work",
                text: "Original",
                dependsOn: [added("first"), added("second")],
              },
            ],
            [a],
          ),
          context("union-seed"),
        ),
      )
      const first = seeded.created.find(row => row.key === "first")
      const second = seeded.created.find(row => row.key === "second")
      const task = seeded.created.find(row => row.key === "work")
      assert.ok(first && second && task)
      const noOp = {
        op: "edit",
        target: existing(task.id),
        text: "Original",
        dependsOn: [existing(second.id), existing(first.id)],
      }
      const unchangedInput = batch([noOp], [a])
      const unchangedContext = context("union-no-op")
      const unchanged = await run(store.apply(unchangedInput, unchangedContext))
      assert.deepEqual(unchanged.changed, [])
      assert.equal(unchanged.eventCount, 0)
      assert.deepEqual(
        (await run(store.apply(unchangedInput, unchangedContext))).changed,
        [],
      )
      const input = batch([
        noOp,
        { op: "edit", target: existing(task.id), text: "Temporary" },
        { op: "edit", target: existing(task.id), text: "Original" },
        { op: "status", target: existing(task.id), status: "doing" },
        { op: "status", target: existing(task.id), status: "todo" },
        { op: "block", target: existing(task.id), reason: "Temporary input" },
        { op: "block", target: existing(task.id), reason: null },
        { op: "transfer", target: existing(task.id), toIssue: b },
        { op: "transfer", target: existing(task.id, b), toIssue: a },
      ])
      const request = context("union-net-zero")
      const saved = await run(store.apply(input, request))
      assert.equal(saved.eventCount, 8)
      const changed = saved.changed[0]
      assert.ok(changed)
      assert.deepEqual(changed.fields, ["text", "status", "blocker", "issue"])
      assert.deepEqual(
        (await run(store.apply(input, request))).changed,
        saved.changed,
      )
      const before = await run(store.readTasks(issue(), { limit: 10 }))
      const forged = forgeReceiptFields(path, saved.batchId, [
        ...changed.fields,
        "dependsOn",
      ])
      await errorCode(store.apply(input, request), "corrupt_state")
      assert.deepEqual(
        await run(store.readTasks(issue(), { limit: 10 })),
        before,
      )
      assert.equal(receiptJson(path, saved.batchId), forged.tampered)
      sql(path, database =>
        assert.equal(
          database
            .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
            .get()?.count,
          11,
        ),
      )
    })
  }))

test("receipt field reconciliation is per task rather than a batch-wide union", async () =>
  fixture(async path => {
    await withStore(path, async store => {
      const seeded = await run(
        store.apply(
          batch(
            [
              { op: "add", issue: a, key: "first", text: "First" },
              { op: "add", issue: a, key: "second", text: "Second" },
            ],
            [a],
          ),
          context("per-task-seed"),
        ),
      )
      const first = seeded.created[0]
      const second = seeded.created[1]
      assert.ok(first && second)
      const input = batch(
        [
          { op: "edit", target: existing(first.id), text: "Updated first" },
          {
            op: "block",
            target: existing(second.id),
            reason: "Missing external input",
          },
        ],
        [a],
      )
      const request = context("per-task-fields")
      const saved = await run(store.apply(input, request))
      assert.deepEqual(saved.changed[0]?.fields, ["text"])
      assert.deepEqual(saved.changed[1]?.fields, ["blocker"])
      forgeReceiptFields(path, saved.batchId, ["blocker"], 0)
      const forged = forgeReceiptFields(path, saved.batchId, ["text"], 1)
      const before = await run(store.readTasks(issue(), { limit: 10 }))
      await errorCode(store.apply(input, request), "corrupt_state")
      assert.equal(receiptJson(path, saved.batchId), forged.tampered)
      assert.deepEqual(
        await run(store.readTasks(issue(), { limit: 10 })),
        before,
      )
      sql(path, database =>
        assert.equal(
          database
            .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
            .get()?.count,
          4,
        ),
      )
    })
  }))

test("new task edit and transfer events replay their full union after returning to the creation issue", async () =>
  fixture(async path => {
    const input = batch([
      { op: "add", issue: a, key: "new", text: "Original" },
      { op: "transfer", target: added("new"), toIssue: b },
      { op: "edit", target: added("new"), text: "Updated after transfer" },
      { op: "transfer", target: added("new"), toIssue: a },
    ])
    const request = context("new-task-union")
    const saved = await withStore(path, async store => {
      const result = await run(store.apply(input, request))
      assert.deepEqual(result.changed[0]?.fields, [
        "text",
        "status",
        "blocker",
        "dependsOn",
        "issue",
      ])
      assert.equal(result.eventCount, 4)
      return result
    })
    await withStore(path, async store => {
      const replay = await run(store.apply(input, request))
      assert.equal(replay.receipt, "replayed")
      assert.deepEqual(replay.changed, saved.changed)
      assert.deepEqual(replay.created, saved.created)
      assert.deepEqual(replay.issues, saved.issues)
    })
  }))

for (const noOp of ["text", "empty dependencies", "reordered dependencies"]) {
  test(`receipt reconciliation rejects forged no-op edit contribution: ${noOp}`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        const seed = await run(
          store.apply(
            batch(
              [
                { op: "add", issue: a, key: "first", text: "First dependency" },
                {
                  op: "add",
                  issue: a,
                  key: "second",
                  text: "Second dependency",
                },
                {
                  op: "add",
                  issue: a,
                  key: "work",
                  text: "Original",
                  dependsOn:
                    noOp === "empty dependencies"
                      ? []
                      : [added("first"), added("second")],
                },
              ],
              [a],
            ),
            context("no-op-contribution-seed"),
          ),
        )
        const first = seed.created[0]
        const second = seed.created[1]
        const task = seed.created[2]
        assert.ok(first && second && task)
        const input = batch(
          [
            {
              op: "edit",
              target: existing(task.id),
              text: noOp === "text" ? "Original" : "Updated",
              dependsOn:
                noOp === "reordered dependencies"
                  ? [existing(first.id), existing(second.id)]
                  : [],
            },
          ],
          [a],
        )
        const request = context("no-op-contribution")
        const saved = await run(store.apply(input, request))
        sql(path, database => {
          const row = database
            .prepare(
              "SELECT payload_json FROM issue_plan_history WHERE batch_id = ?",
            )
            .get(saved.batchId)
          assert.ok(row && typeof row.payload_json === "string")
          const payload: unknown = JSON.parse(row.payload_json)
          assert.ok(
            typeof payload === "object" &&
              payload !== null &&
              "changes" in payload &&
              Array.isArray(payload.changes),
          )
          payload.changes.push(
            noOp === "text"
              ? { field: "text", before: "Original", after: "Original" }
              : {
                  field: "dependsOn",
                  before:
                    noOp === "empty dependencies" ? [] : [first.id, second.id],
                  after:
                    noOp === "empty dependencies" ? [] : [second.id, first.id],
                },
          )
          database
            .prepare(
              "UPDATE issue_plan_history SET payload_json = ? WHERE batch_id = ?",
            )
            .run(JSON.stringify(payload), saved.batchId)
        })
        const forged = forgeReceiptFields(path, saved.batchId, [
          "text",
          "dependsOn",
        ])
        const before = await run(store.readTasks(issue(), { limit: 10 }))
        await errorCode(store.apply(input, request), "corrupt_state")
        assert.equal(receiptJson(path, saved.batchId), forged.tampered)
        assert.deepEqual(
          await run(store.readTasks(issue(), { limit: 10 })),
          before,
        )
        sql(path, database =>
          assert.equal(
            database
              .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
              .get()?.count,
            4,
          ),
        )
      })
    }))
}

for (const kind of ["status", "block"]) {
  test(`receipt reconciliation rejects forged no-op ${kind} contribution`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        const seed = await run(
          store.apply(
            batch(
              [{ op: "add", issue: a, key: "work", text: "Original" }],
              [a],
            ),
            context("other-no-op-seed"),
          ),
        )
        const task = seed.created[0]
        assert.ok(task)
        const noOp =
          kind === "status"
            ? { op: "status", target: existing(task.id), status: "todo" }
            : { op: "block", target: existing(task.id), reason: null }
        const input = batch(
          [{ op: "edit", target: existing(task.id), text: "Updated" }, noOp],
          [a],
        )
        const request = context("other-no-op")
        const saved = await run(store.apply(input, request))
        assert.equal(saved.eventCount, 1)
        const payload = {
          op: kind,
          operationIndex: 1,
          issue: a,
          id: task.id,
          before: kind === "status" ? "todo" : null,
          after: kind === "status" ? "todo" : null,
        }
        sql(path, database =>
          database
            .prepare(
              "INSERT INTO issue_plan_history (batch_id, plan_id, task_id, operation_index, kind, recorded_at, payload_json) SELECT batch_id, plan_id, task_id, 1, ?, recorded_at, ? FROM issue_plan_history WHERE batch_id = ? LIMIT 1",
            )
            .run(kind, JSON.stringify(payload), saved.batchId),
        )
        const receipt: unknown = JSON.parse(receiptJson(path, saved.batchId))
        assert.ok(typeof receipt === "object" && receipt !== null)
        Object.assign(receipt, { eventCount: 2 })
        writeReceiptJson(path, saved.batchId, JSON.stringify(receipt))
        const forged = forgeReceiptFields(path, saved.batchId, [
          "text",
          kind === "status" ? "status" : "blocker",
        ])
        const before = await run(store.readTasks(issue(), { limit: 10 }))
        await errorCode(store.apply(input, request), "corrupt_state")
        assert.equal(receiptJson(path, saved.batchId), forged.tampered)
        assert.deepEqual(
          await run(store.readTasks(issue(), { limit: 10 })),
          before,
        )
        sql(path, database =>
          assert.equal(
            database
              .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
              .get()?.count,
            3,
          ),
        )
      })
    }))
}

for (const kind of ["text", "dependsOn", "status", "block"]) {
  test(`receipt reconciliation rejects ${kind} history result inconsistent with the request`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        const seed = await run(
          store.apply(
            batch(
              [
                { op: "add", issue: a, key: "first", text: "First dependency" },
                {
                  op: "add",
                  issue: a,
                  key: "second",
                  text: "Second dependency",
                },
                { op: "add", issue: a, key: "work", text: "Original" },
              ],
              [a],
            ),
            context("request-result-seed"),
          ),
        )
        const first = seed.created[0]
        const second = seed.created[1]
        const task = seed.created[2]
        assert.ok(first && second && task)
        const operation =
          kind === "text"
            ? { op: "edit", target: existing(task.id), text: "Updated" }
            : kind === "dependsOn"
              ? {
                  op: "edit",
                  target: existing(task.id),
                  dependsOn: [existing(first.id)],
                }
              : kind === "status"
                ? { op: "status", target: existing(task.id), status: "doing" }
                : { op: "block", target: existing(task.id), reason: "Waiting" }
        const input = batch([operation], [a])
        const request = context("request-result")
        const saved = await run(store.apply(input, request))
        const before = await run(store.readTasks(issue(), { limit: 10 }))
        const receipt = receiptJson(path, saved.batchId)
        sql(path, database => {
          const row = database
            .prepare(
              "SELECT payload_json FROM issue_plan_history WHERE batch_id = ?",
            )
            .get(saved.batchId)
          assert.ok(row && typeof row.payload_json === "string")
          const payload: unknown = JSON.parse(row.payload_json)
          assert.ok(typeof payload === "object" && payload !== null)
          if (kind === "text" || kind === "dependsOn") {
            assert.ok("changes" in payload && Array.isArray(payload.changes))
            const change: unknown = payload.changes[0]
            assert.ok(
              typeof change === "object" &&
                change !== null &&
                "after" in change,
            )
            change.after = kind === "text" ? "Other text" : [second.id]
          } else
            Object.assign(payload, {
              after: kind === "status" ? "done" : "Other input",
            })
          database
            .prepare(
              "UPDATE issue_plan_history SET payload_json = ? WHERE batch_id = ?",
            )
            .run(JSON.stringify(payload), saved.batchId)
        })
        await errorCode(store.apply(input, request), "corrupt_state")
        assert.deepEqual(
          await run(store.readTasks(issue(), { limit: 10 })),
          before,
        )
        assert.equal(receiptJson(path, saved.batchId), receipt)
      })
    }))
}

test("edit receipt resolves creation-qualified dependency aliases after dependency transfers", async () =>
  fixture(async path => {
    await withStore(path, async store => {
      const seed = await run(
        store.apply(
          batch(
            [{ op: "add", issue: a, key: "work", text: "Requirement" }],
            [a],
          ),
          context("dependency-alias-seed"),
        ),
      )
      const task = seed.created[0]
      assert.ok(task)
      const input = batch([
        { op: "add", issue: a, key: "dependency", text: "New dependency" },
        { op: "transfer", target: added("dependency"), toIssue: b },
        {
          op: "edit",
          target: existing(task.id),
          dependsOn: [added("dependency")],
        },
      ])
      const request = context("dependency-alias")
      const saved = await run(store.apply(input, request))
      const dependency = saved.created[0]
      assert.ok(dependency)
      assert.deepEqual(saved.changed.find(row => row.id === task.id)?.fields, [
        "dependsOn",
      ])
      await run(
        store.apply(
          batch([
            { op: "edit", target: existing(task.id), dependsOn: [] },
            { op: "transfer", target: existing(dependency.id, b), toIssue: a },
          ]),
          context("after-dependency-alias"),
        ),
      )
      const replay = await run(store.apply(input, request))
      assert.equal(replay.receipt, "replayed")
      assert.deepEqual(replay.changed, saved.changed)
      assert.deepEqual(replay.created, saved.created)
    })
  }))

for (const corruption of [
  "empty changes",
  "duplicate field",
  "wrong owner",
  "wrong task",
  "wrong index",
  "unrequested field",
  "invalid JSON",
  "oversized payload",
]) {
  test(`receipt reconciliation rejects malformed edit history: ${corruption}`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        const seed = await run(
          store.apply(
            batch(
              [
                { op: "add", issue: a, key: "dependency", text: "Dependency" },
                { op: "add", issue: a, key: "work", text: "Original" },
              ],
              [a],
            ),
            context("malformed-edit-seed"),
          ),
        )
        const dependency = seed.created[0]
        const task = seed.created[1]
        assert.ok(dependency && task)
        const input = batch(
          [{ op: "edit", target: existing(task.id), text: "Updated" }],
          [a],
        )
        const request = context("malformed-edit")
        const saved = await run(store.apply(input, request))
        const before = await run(store.readTasks(issue(), { limit: 10 }))
        const receiptBefore = receiptJson(path, saved.batchId)
        sql(path, database => {
          const row = database
            .prepare(
              "SELECT payload_json FROM issue_plan_history WHERE batch_id = ?",
            )
            .get(saved.batchId)
          assert.ok(row && typeof row.payload_json === "string")
          const payload: unknown = JSON.parse(row.payload_json)
          assert.ok(
            typeof payload === "object" &&
              payload !== null &&
              "changes" in payload,
          )
          assert.ok(Array.isArray(payload.changes))
          if (corruption === "empty changes") payload.changes = []
          else if (corruption === "duplicate field")
            payload.changes = [payload.changes[0], payload.changes[0]]
          else if (corruption === "wrong owner")
            Object.assign(payload, { issue: b })
          else if (corruption === "wrong task")
            Object.assign(payload, { id: dependency.id })
          else if (corruption === "wrong index")
            Object.assign(payload, { operationIndex: 999 })
          else if (corruption === "unrequested field")
            payload.changes = [
              { field: "dependsOn", before: [], after: [dependency.id] },
            ]
          else if (corruption === "oversized payload")
            payload.changes = [
              {
                field: "text",
                before: "x".repeat(2_097_153),
                after: "Updated",
              },
            ]
          const encoded =
            corruption === "invalid JSON" ? "{" : JSON.stringify(payload)
          database
            .prepare(
              "UPDATE issue_plan_history SET payload_json = ? WHERE batch_id = ?",
            )
            .run(encoded, saved.batchId)
        })
        if (corruption === "unrequested field")
          forgeReceiptFields(path, saved.batchId, ["dependsOn"])
        const stored = receiptJson(path, saved.batchId)
        await errorCode(store.apply(input, request), "corrupt_state")
        assert.deepEqual(
          await run(store.readTasks(issue(), { limit: 10 })),
          before,
        )
        assert.equal(receiptJson(path, saved.batchId), stored)
        if (corruption !== "unrequested field")
          assert.equal(stored, receiptBefore)
        sql(path, database =>
          assert.equal(
            database
              .prepare("SELECT COUNT(*) AS count FROM issue_plan_history")
              .get()?.count,
            3,
          ),
        )
      })
    }))
}

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
          Option.isNone(await run(store.readTasks(issue(), { limit: 10 }))),
        )
        assert.ok(
          Option.isNone(await run(store.readTasks(issue(b), { limit: 10 }))),
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
          Option.isNone(await run(store.readTasks(issue(), { limit: 10 }))),
        )
        assert.ok(
          Option.isNone(await run(store.readTasks(issue(b), { limit: 10 }))),
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

for (const issueState of ["new", "existing"] as const) {
  test(`fresh receipt reconciliation rejects lowered revisions for a ${issueState} issue`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        const input = await (async () => {
          if (issueState === "new")
            return batch([{ op: "add", issue: a, key: "first", text: "First" }])

          const seeded = await run(
            store.apply(
              batch([{ op: "add", issue: a, key: "seed", text: "Seed" }]),
              context("seed-before-receipt-trigger"),
            ),
          )
          const created = seeded.created[0]
          assert.ok(created)
          return batch([
            { op: "status", target: existing(created.id), status: "doing" },
          ])
        })()
        const before = await run(store.readTasks(issue(), { limit: 10 }))
        const snapshot = () =>
          sql(path, database => ({
            counts: [
              "issue_plans",
              "issue_plan_tasks",
              "issue_plan_batches",
              "issue_plan_dependencies",
              "issue_plan_history",
            ].map(table =>
              database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
            ),
            receipts: database
              .prepare("SELECT result_json FROM issue_plan_batches ORDER BY id")
              .all(),
          }))
        const beforeRows = snapshot()
        sql(path, database =>
          database.exec(`
          CREATE TRIGGER fixture_lower_receipt AFTER INSERT ON issue_plan_batches
          BEGIN
            UPDATE issue_plan_batches SET result_json = json_set(
              NEW.result_json,
              '$.plans[0].revision', json_extract(NEW.result_json, '$.plans[0].revision') - 1,
              '$.changed[0].revision', json_extract(NEW.result_json, '$.changed[0].revision') - 1
            ) WHERE id = NEW.id;
          END;
        `),
        )

        await errorCode(
          store.apply(input, context("lowered-receipt")),
          "corrupt_state",
        )
        assert.deepEqual(
          await run(store.readTasks(issue(), { limit: 10 })),
          before,
        )
        assert.deepEqual(snapshot(), beforeRows)
        sql(path, database =>
          database.exec("DROP TRIGGER fixture_lower_receipt"),
        )

        const saved = await run(store.apply(input, context("lowered-receipt")))
        assert.equal(saved.issues[0]?.revision, issueState === "new" ? 1 : 2)
        const changed = saved.changed[0]
        assert.ok(changed)
        await run(
          store.apply(
            batch([
              { op: "status", target: existing(changed.id), status: "done" },
            ]),
            context("later-than-lowered-receipt"),
          ),
        )
        assert.deepEqual(
          await run(store.apply(input, context("lowered-receipt"))),
          { ...saved, receipt: "replayed" },
        )
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
      assert.equal(changed.issues[0]?.revision, 2)

      const replayed = await run(store.apply(input, context("original")))
      assert.deepEqual(replayed, { ...saved, receipt: "replayed" })
      const page = await run(store.readTasks(issue(), { limit: 10 }))
      assert.ok(Option.isSome(page))
      assert.equal(page.value.tasks[0]?.status, "doing")
      assert.equal(page.value.revision, 2)
    })
  }))

for (const verification of ["available", "unavailable"] as const) {
  test(`lost COMMIT acknowledgement uses ${verification} fresh read-only evidence`, async t =>
    fixture(async path => {
      const input = batch([
        { op: "add", issue: a, key: "once", text: "Only once" },
      ])
      const exec = DatabaseSync.prototype.exec
      const prepare = DatabaseSync.prototype.prepare
      let armed = true
      let acknowledgementLost = false
      let original: DatabaseSync | undefined
      let recoveryReads = 0
      let createdId = ""

      await withStore(path, async store => {
        t.mock.method(
          DatabaseSync.prototype,
          "exec",
          function (this: DatabaseSync, command: string) {
            if (armed && command === "COMMIT") {
              armed = false
              original = this
              exec.call(this, command)
              acknowledgementLost = true
              throw new Error("fixture lost commit acknowledgement")
            }
            return exec.call(this, command)
          },
        )
        t.mock.method(
          DatabaseSync.prototype,
          "prepare",
          function (this: DatabaseSync, command: string) {
            if (
              acknowledgementLost &&
              command.includes(
                "fingerprint, result_json FROM issue_plan_batches",
              )
            ) {
              recoveryReads += 1
              assert.notEqual(this, original)
              assert.throws(
                () =>
                  exec.call(
                    this,
                    "CREATE TABLE fixture_forbidden_write (id INTEGER)",
                  ),
                /readonly/i,
              )
              if (verification === "unavailable")
                throw new Error("fixture recovery read unavailable")
            }
            return prepare.call(this, command)
          },
        )

        const result = await run(
          Effect.either(store.apply(input, context("lost-ack"))),
        )
        if (verification === "available") {
          assert.ok(Either.isRight(result))
          assert.equal(result.right.receipt, "recovered")
          const created = result.right.created[0]
          assert.ok(created)
          createdId = created.id
        } else {
          assert.ok(Either.isLeft(result))
          assert.equal(result.left.code, "unknown_completion")
          assert.ok(result.left.code === "unknown_completion")
          assert.equal(result.left.requestId, "lost-ack")
          assert.match(result.left.batchId, /^[0-9a-f-]{36}$/)
          assert.ok(Cause.isCause(result.left.cause))
        }
        assert.equal(recoveryReads, 1)
        await errorCode(store.readTasks(issue(), { limit: 10 }), "io")
      })
      acknowledgementLost = false

      await withStore(path, async store => {
        const replay = await run(store.apply(input, context("lost-ack")))
        assert.equal(replay.receipt, "replayed")
        if (verification === "available")
          assert.equal(replay.created[0]?.id, createdId)
        const page = await run(store.readTasks(issue(), { limit: 10 }))
        assert.ok(Option.isSome(page))
        assert.equal(page.value.tasks.length, 1)
      })
      sql(path, database => {
        assert.equal(
          database
            .prepare("SELECT COUNT(*) AS count FROM issue_plan_tasks")
            .get()?.count,
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
}

for (const evidence of ["missing database", "different batch"] as const) {
  test(`recovery rejects ${evidence} without replacing the original commit identity`, async t =>
    fixture(async (path, root) => {
      await withStore(path, async store => {
        const exec = DatabaseSync.prototype.exec
        let armed = true
        let originalBatchId = ""
        t.mock.method(
          DatabaseSync.prototype,
          "exec",
          function (this: DatabaseSync, command: string) {
            if (armed && command === "COMMIT") {
              armed = false
              exec.call(this, command)
              const row = this.prepare(
                "SELECT id, result_json FROM issue_plan_batches",
              ).get()
              assert.ok(
                typeof row?.id === "string" &&
                  typeof row.result_json === "string",
              )
              originalBatchId = row.id
              if (evidence === "missing database") {
                renameSync(path, join(root, "preserved.sqlite"))
              } else {
                const replacement = "30000000-0000-4000-8000-000000000999"
                const result: unknown = JSON.parse(row.result_json)
                assert.ok(
                  typeof result === "object" &&
                    result !== null &&
                    "batchId" in result,
                )
                result.batchId = replacement
                exec.call(this, "PRAGMA foreign_keys = OFF")
                this.prepare(
                  "UPDATE issue_plan_batches SET id = ?, result_json = ? WHERE id = ?",
                ).run(replacement, JSON.stringify(result), originalBatchId)
                this.prepare(
                  "UPDATE issue_plan_history SET batch_id = ? WHERE batch_id = ?",
                ).run(replacement, originalBatchId)
              }
              throw new Error(
                "fixture lost acknowledgement with unavailable evidence",
              )
            }
            return exec.call(this, command)
          },
        )
        const result = await run(
          Effect.either(
            store.apply(
              batch([{ op: "add", issue: a, key: "first", text: "One task" }]),
              context("bound-recovery"),
            ),
          ),
        )
        assert.ok(Either.isLeft(result))
        assert.ok(result.left.code === "unknown_completion")
        assert.equal(result.left.batchId, originalBatchId)
        assert.equal(result.left.requestId, "bound-recovery")
        if (evidence === "missing database")
          assert.equal(existsSync(path), false)
      })
    }))
}

test("recovery uses the captured database configuration rather than later caller mutations", async t =>
  fixture(async (path, root) => {
    const options = { databasePath: path, busyTimeoutMs: 0 }
    const store = await run(openSqliteTaskStore(options))
    options.databasePath = join(root, "unrelated.sqlite")
    options.busyTimeoutMs = 1_000_000
    const exec = DatabaseSync.prototype.exec
    let armed = true
    t.mock.method(
      DatabaseSync.prototype,
      "exec",
      function (this: DatabaseSync, command: string) {
        exec.call(this, command)
        if (armed && command === "COMMIT") {
          armed = false
          throw new Error(
            "fixture lost acknowledgement after configuration changed",
          )
        }
      },
    )
    try {
      const result = await run(
        store.apply(
          batch([
            { op: "add", issue: a, key: "first", text: "Original database" },
          ]),
          context("captured-options"),
        ),
      )
      assert.equal(result.receipt, "recovered")
      assert.equal(existsSync(options.databasePath), false)
    } finally {
      await run(store.close())
    }
  }))

test("a failed COMMIT with confirmed rollback remains a known failure and leaves the connection usable", async t =>
  fixture(async path => {
    const input = batch([{ op: "add", issue: a, key: "first", text: "First" }])
    await withStore(path, async store => {
      const exec = DatabaseSync.prototype.exec
      let armed = true
      t.mock.method(
        DatabaseSync.prototype,
        "exec",
        function (this: DatabaseSync, command: string) {
          if (armed && command === "COMMIT") {
            armed = false
            throw new Error("fixture commit rejected before execution")
          }
          return exec.call(this, command)
        },
      )

      await errorCode(store.apply(input, context("known-failure")), "io")
      assert.ok(
        Option.isNone(await run(store.readTasks(issue(), { limit: 10 }))),
      )
      const saved = await run(store.apply(input, context("known-failure")))
      assert.equal(saved.receipt, "committed")
      assert.equal(saved.created.length, 1)
    })
  }))

test("failed COMMIT and rollback without durable receipt stays unknown and never reapplies", async t =>
  fixture(async path => {
    await withStore(path, async store => {
      const exec = DatabaseSync.prototype.exec
      let phase: "commit" | "rollback" | "complete" = "commit"
      let commits = 0
      t.mock.method(
        DatabaseSync.prototype,
        "exec",
        function (this: DatabaseSync, command: string) {
          if (phase === "commit" && command === "COMMIT") {
            commits += 1
            phase = "rollback"
            throw new Error("fixture unacknowledged commit failure")
          }
          if (phase === "rollback" && command === "ROLLBACK") {
            phase = "complete"
            throw new Error("fixture failed rollback")
          }
          return exec.call(this, command)
        },
      )
      await errorCode(
        store.apply(
          batch([{ op: "add", issue: a, key: "first", text: "Not committed" }]),
          context("unknown-absent"),
        ),
        "unknown_completion",
      )
      assert.equal(commits, 1)
      await errorCode(store.readTasks(issue(), { limit: 10 }), "io")
    })
    sql(path, database => {
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM issue_plan_tasks").get()
          ?.count,
        0,
      )
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM issue_plan_batches")
          .get()?.count,
        0,
      )
    })
  }))

test("cancellation at successful COMMIT does not roll back durable tasks", async t =>
  fixture(async path => {
    const input = batch([
      { op: "add", issue: a, key: "first", text: "Committed once" },
    ])
    await withStore(path, async store => {
      const exec = DatabaseSync.prototype.exec
      const controller = new AbortController()
      let committed = false
      let rollbacks = 0
      t.mock.method(
        DatabaseSync.prototype,
        "exec",
        function (this: DatabaseSync, command: string) {
          if (command === "ROLLBACK" && committed) rollbacks += 1
          exec.call(this, command)
          if (command === "COMMIT" && !committed) {
            committed = true
            controller.abort()
          }
        },
      )

      await Effect.runPromiseExit(
        store.apply(input, context("cancel-at-commit")),
        { signal: controller.signal },
      )
      assert.equal(committed, true)
      assert.equal(rollbacks, 0)
      const replay = await run(store.apply(input, context("cancel-at-commit")))
      assert.equal(replay.receipt, "replayed")
      const page = await run(store.readTasks(issue(), { limit: 10 }))
      assert.ok(Option.isSome(page))
      assert.equal(page.value.tasks.length, 1)
    })
  }))

test("cancelling interruptible task work rolls back without starting COMMIT", async t =>
  fixture(async path => {
    const entered = await run(Deferred.make<void>())
    const store = await run(
      openSqliteTaskStore({
        databasePath: path,
        busyTimeoutMs: 0,
        taskTransactionBeginSignal: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
      }),
    )
    const exec = DatabaseSync.prototype.exec
    let commits = 0
    let rollbacks = 0
    t.mock.method(
      DatabaseSync.prototype,
      "exec",
      function (this: DatabaseSync, command: string) {
        if (command === "COMMIT") commits += 1
        if (command === "ROLLBACK") rollbacks += 1
        return exec.call(this, command)
      },
    )
    try {
      const fiber = await run(
        Effect.forkDaemon(
          store.apply(
            batch([
              {
                op: "add",
                issue: a,
                key: "first",
                text: "Cancelled before write",
              },
            ]),
            context("cancel-work"),
          ),
        ),
      )
      await run(Deferred.await(entered))
      const result = await run(Fiber.interrupt(fiber))
      assert.ok(Exit.isFailure(result))
      assert.ok(Cause.isInterrupted(result.cause))
      assert.equal(commits, 0)
      assert.equal(rollbacks, 1)
      assert.ok(
        Option.isNone(await run(store.readTasks(issue(), { limit: 10 }))),
      )
    } finally {
      await run(store.close())
    }
  }))

test("concurrent writers load current state under the same SQLite write lock", async () =>
  fixture(async path => {
    const first = await run(
      openSqliteTaskStore({ databasePath: path, busyTimeoutMs: 0 }),
    )
    const second = await run(
      openSqliteTaskStore({ databasePath: path, busyTimeoutMs: 0 }),
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
      const page = await run(first.readTasks(issue(), { limit: 10 }))
      assert.ok(Option.isSome(page))
      assert.equal(page.value.tasks.length, 2)
      assert.equal(page.value.revision, 2)
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
      const page = await run(store.readTasks(issue(), { limit: 10 }))
      assert.ok(Option.isSome(page))
      assert.equal(page.value.revision, 1)
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

test("version-two history upgrades without losing registry data, history or old receipts", async () =>
  fixture(async (path, root) => {
    const registry = makeSqliteRegistryStore(root)
    const seed = batch(
      [
        {
          op: "add",
          issue: a,
          key: "retained",
          text: "Retain original history",
        },
      ],
      [a],
    )
    const seedContext = context("version-two-seed")
    let retainedId = ""
    let priorHistory: readonly unknown[] = []
    try {
      const request = await run(
        registry.enqueue({
          project: "/fixture/project",
          role: "worker",
          requesterId: "fixture-worker",
          text: "Keep unrelated registry data",
          now: 1_000,
        }),
      )
      await withStore(path, async store => {
        const saved = await run(store.apply(seed, seedContext))
        const retained = saved.created[0]
        assert.ok(retained)
        retainedId = retained.id
      })
      restoreVersionTwoHistory(path)
      sql(path, database => {
        priorHistory = database
          .prepare("SELECT * FROM issue_plan_history ORDER BY sequence")
          .all()
      })
      await withStore(path, async store => {
        const moved = await run(
          store.apply(
            batch([
              { op: "transfer", target: existing(retainedId), toIssue: b },
            ]),
            context("after-version-two-upgrade"),
          ),
        )
        assert.equal(moved.eventCount, 1)
        const replay = await run(store.apply(seed, seedContext))
        assert.equal(replay.receipt, "replayed")
        assert.equal(replay.created[0]?.id, retainedId)
        const destination = await run(store.readTasks(issue(b), { limit: 10 }))
        assert.ok(Option.isSome(destination))
        assert.equal(destination.value.tasks[0]?.id, retainedId)
      })
      sql(path, database => {
        const history = database
          .prepare("SELECT * FROM issue_plan_history ORDER BY sequence")
          .all()
        assert.deepEqual(history.slice(0, priorHistory.length), priorHistory)
        assert.equal(history.length, priorHistory.length + 1)
        assert.equal(history.at(-1)?.kind, "transfer")
        assert.equal(
          database.prepare("SELECT version FROM issue_plan_schema").get()
            ?.version,
          4,
        )
        assert.equal(
          database.prepare("PRAGMA user_version").get()?.user_version,
          5,
        )
      })
      const snapshot = await run(registry.snapshot(1_000))
      assert.equal(snapshot.requests.length, 1)
      assert.equal(snapshot.requests[0]?.id, request.id)
    } finally {
      registry.close()
    }
  }))

for (const foreign of [
  "CREATE INDEX fixture_history_index ON issue_plan_history (recorded_at)",
  "CREATE VIEW fixture_history_view AS SELECT task_id FROM issue_plan_history",
  "CREATE TRIGGER fixture_history_trigger AFTER INSERT ON fixture_subject BEGIN SELECT sequence FROM issue_plan_history; END",
  "CREATE TABLE fixture_history_reference (sequence INTEGER REFERENCES issue_plan_history(sequence)) STRICT; INSERT INTO fixture_history_reference SELECT sequence FROM issue_plan_history LIMIT 1",
]) {
  test(`version-two upgrade preserves foreign history objects by refusing unsafe rebuild: ${foreign.split(" ").slice(1, 3).join(" ")}`, async () =>
    fixture(async path => {
      await withStore(path, async store => {
        await run(
          store.apply(
            batch(
              [
                {
                  op: "add",
                  issue: a,
                  key: "original",
                  text: "Keep existing work",
                },
              ],
              [a],
            ),
            context("foreign-history-seed"),
          ),
        )
      })
      restoreVersionTwoHistory(path)
      let beforeSchema: readonly unknown[] = []
      let beforeHistory: readonly unknown[] = []
      sql(path, database => {
        database.exec(
          "CREATE TABLE fixture_subject (id INTEGER PRIMARY KEY) STRICT; INSERT INTO fixture_subject VALUES (1)",
        )
        database.exec(foreign)
        assert.equal(
          database.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode,
          "delete",
        )
        beforeSchema = database
          .prepare("SELECT * FROM sqlite_schema ORDER BY name")
          .all()
        beforeHistory = database
          .prepare("SELECT * FROM issue_plan_history ORDER BY sequence")
          .all()
      })
      const opened = await run(
        Effect.either(openSqliteTaskStore({ databasePath: path })),
      )
      if (Either.isRight(opened)) await run(opened.right.close())
      sql(path, database => {
        assert.deepEqual(
          database.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
          beforeSchema,
        )
        assert.deepEqual(
          database
            .prepare("SELECT * FROM issue_plan_history ORDER BY sequence")
            .all(),
          beforeHistory,
        )
        assert.equal(
          database.prepare("SELECT id FROM fixture_subject").get()?.id,
          1,
        )
        assert.equal(
          database.prepare("SELECT version FROM issue_plan_schema").get()
            ?.version,
          2,
        )
        assert.equal(
          database.prepare("PRAGMA journal_mode").get()?.journal_mode,
          "delete",
        )
      })
      assert.ok(Either.isLeft(opened))
      assert.equal(opened.left.code, "unsupported_schema")
    }))
}

test("version-three upgrade adds qualified lookup indexing without rewriting task history", async () =>
  fixture(async path => {
    let id = ""
    let originalHistory: readonly unknown[] = []
    await withStore(path, async store => {
      const saved = await run(
        store.apply(
          batch(
            [
              {
                op: "add",
                issue: a,
                key: "retained",
                text: "Retain version-three tasks",
              },
            ],
            [a],
          ),
          context("version-three-seed"),
        ),
      )
      const task = saved.created[0]
      assert.ok(task)
      id = task.id
    })
    sql(path, database => {
      originalHistory = database
        .prepare("SELECT * FROM issue_plan_history ORDER BY sequence")
        .all()
      database.exec(
        "DROP INDEX issue_plan_issues_nocase; UPDATE issue_plan_schema SET version = 3; PRAGMA user_version = 5;",
      )
    })
    await withStore(path, async store => {
      const page = await run(store.readTasks(issue(), { limit: 10 }))
      assert.ok(Option.isSome(page))
      assert.equal(page.value.tasks[0]?.id, id)
      assert.equal(page.value.revision, 1)
    })
    sql(path, database => {
      assert.deepEqual(
        database
          .prepare("SELECT * FROM issue_plan_history ORDER BY sequence")
          .all(),
        originalHistory,
      )
      assert.ok(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'issue_plan_issues_nocase'",
          )
          .get(),
      )
      assert.equal(
        database.prepare("SELECT version FROM issue_plan_schema").get()
          ?.version,
        4,
      )
      assert.equal(
        database.prepare("PRAGMA user_version").get()?.user_version,
        5,
      )
    })
  }))

test("a new schema upgrades the real version-one namespace without changing registry ownership", async () =>
  fixture(async path => {
    let retainedId = ""
    await withStore(path, async store => {
      const before = await run(
        store.apply(
          batch([
            {
              op: "add",
              issue: a,
              key: "before",
              text: "Retain through upgrade",
            },
          ]),
          context("before-upgrade"),
        ),
      )
      const retained = before.created[0]
      assert.ok(retained)
      retainedId = retained.id
    })
    sql(path, database =>
      database.exec(
        "DROP TABLE IF EXISTS issue_plan_history; DROP TABLE IF EXISTS issue_plan_dependencies; DROP TABLE IF EXISTS issue_plan_batches; DROP INDEX issue_plan_issues_nocase; UPDATE issue_plan_schema SET version = 1; PRAGMA user_version = 5;",
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
      const page = await run(store.readTasks(issue(), { limit: 10 }))
      assert.ok(Option.isSome(page))
      assert.equal(page.value.tasks.length, 2)
      assert.ok(page.value.tasks.some(task => task.id === retainedId))
    })
    sql(path, database => {
      assert.equal(
        database.prepare("SELECT version FROM issue_plan_schema").get()
          ?.version,
        4,
      )
      assert.equal(
        database.prepare("PRAGMA user_version").get()?.user_version,
        5,
      )
    })
  }))
