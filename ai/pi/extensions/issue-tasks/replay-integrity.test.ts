import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Effect, Either } from "effect"
import { openSqliteTaskStore } from "./sqlite-store.ts"

const issue = { repository: "0xgleb/dotconfig", number: 140 }
const reference = (key = "task") => ({
  issue,
  task: { kind: "added", key },
})
const add = { op: "add", issue, key: "task", text: "created task" }
const fixtureParent = fileURLToPath(
  new URL("../../../../.tmp/issue-plans-tests/", import.meta.url),
)
const replace =
  (before: string, after: string) =>
  (json: string): string => {
    assert.equal(json.includes(before), true)

    return json.replace(before, after)
  }
type CorruptionCase = {
  readonly name: string
  readonly operations: readonly unknown[]
  readonly operationIndex: number
} & (
  | {
      readonly target: "history" | "receipt"
      readonly corrupt: (json: string) => string
    }
  | { readonly target: "missing-event" }
)
const removeChange =
  (field: "text" | "dependsOn") =>
  (json: string): string => {
    const payload: unknown = JSON.parse(json)
    assert.ok(
      typeof payload === "object" && payload !== null && "changes" in payload,
    )
    assert.ok(Array.isArray(payload.changes))
    assert.equal(payload.changes.length, 2)

    const changes = payload.changes.filter((change: unknown) => {
      assert.ok(
        typeof change === "object" && change !== null && "field" in change,
      )
      return change.field !== field
    })
    assert.equal(changes.length, 1)
    payload.changes = changes

    return JSON.stringify(payload)
  }
const cases: readonly CorruptionCase[] = [
  {
    name: "malformed add JSON",
    operations: [add],
    operationIndex: 0,
    target: "history",
    corrupt: () => "{",
  },
  ...[
    ["creation text", '"text":"created task"', '"text":"forged task"'],
    ["creation status", '"status":"todo"', '"status":"done"'],
    ["creation blocker", '"blocker":null', '"blocker":"phantom blocker"'],
    [
      "creation dependencies",
      '"dependsOn":[]',
      '"dependsOn":["4a501756-0fac-4df7-bce7-7ee0f08eb21e"]',
    ],
  ].map(([name, before, after]): CorruptionCase => {
    assert.ok(name !== undefined && before !== undefined && after !== undefined)

    return {
      name,
      operations: [add],
      operationIndex: 0,
      target: "history",
      corrupt: replace(before, after),
    }
  }),
  {
    name: "status continuity",
    operations: [
      add,
      { op: "status", target: reference(), status: "doing" },
      { op: "status", target: reference(), status: "done" },
    ],
    operationIndex: 2,
    target: "history",
    corrupt: replace('"before":"doing"', '"before":"cancelled"'),
  },
  {
    name: "blocker continuity",
    operations: [
      add,
      { op: "block", target: reference(), reason: "first blocker" },
      { op: "block", target: reference(), reason: "second blocker" },
    ],
    operationIndex: 2,
    target: "history",
    corrupt: replace('"before":"first blocker"', '"before":"phantom blocker"'),
  },
  {
    name: "text continuity",
    operations: [
      add,
      { op: "edit", target: reference(), text: "first edit" },
      { op: "edit", target: reference(), text: "second edit" },
    ],
    operationIndex: 2,
    target: "history",
    corrupt: replace('"before":"first edit"', '"before":"phantom text"'),
  },
  {
    name: "dependency continuity",
    operations: [
      { ...add, key: "dependency" },
      { ...add, dependsOn: [reference("dependency")] },
      { op: "edit", target: reference(), dependsOn: [] },
      { op: "edit", target: reference(), dependsOn: [reference("dependency")] },
    ],
    operationIndex: 3,
    target: "history",
    corrupt: replace(
      '"before":[]',
      '"before":["4a501756-0fac-4df7-bce7-7ee0f08eb21e"]',
    ),
  },
  ...(["text", "dependsOn"] as const).map((field): CorruptionCase => ({
    name: `omitted requested edit field: ${field}`,
    operations: [
      { ...add, key: "dependency" },
      add,
      {
        op: "edit",
        target: reference(),
        text: "changed text",
        dependsOn: [reference("dependency")],
      },
    ],
    operationIndex: 2,
    target: "history",
    corrupt: removeChange(field),
  })),
  {
    name: "omitted final state-changing operation",
    operations: [add, { op: "status", target: reference(), status: "doing" }],
    operationIndex: 1,
    target: "missing-event",
  },
  {
    name: "omitted intermediate state-changing operation",
    operations: [
      add,
      { op: "status", target: reference(), status: "doing" },
      { op: "block", target: reference(), reason: "blocked" },
    ],
    operationIndex: 1,
    target: "missing-event",
  },
  {
    name: "malformed receipt JSON classification",
    operations: [add],
    operationIndex: 0,
    target: "receipt",
    corrupt: () => "{",
  },
]
const snapshot = (database: DatabaseSync): string =>
  JSON.stringify([
    database.prepare("SELECT * FROM issue_plans ORDER BY id").all(),
    database.prepare("SELECT * FROM issue_plan_tasks ORDER BY id").all(),
    database
      .prepare(
        "SELECT * FROM issue_plan_dependencies ORDER BY task_id, depends_on_id",
      )
      .all(),
    database
      .prepare("SELECT * FROM issue_plan_history ORDER BY sequence")
      .all(),
    database.prepare("SELECT * FROM issue_plan_batches ORDER BY id").all(),
  ])

for (const scenario of cases) {
  test(`receipt replay rejects ${scenario.name} after reopening without additional writes`, async () => {
    mkdirSync(fixtureParent, { recursive: true, mode: 0o700 })
    const root = mkdtempSync(join(fixtureParent, "replay-integrity-"))
    const databasePath = join(root, "tasks.sqlite")
    const batch = { issues: [issue], operations: scenario.operations }
    const context = {
      actorId: "integrity-fixture",
      requestId: scenario.name,
      now: 1_000,
      cancellation: "forbidden" as const,
    }

    try {
      const original = await Effect.runPromise(
        openSqliteTaskStore({ databasePath }),
      )
      const saved = await Effect.runPromise(original.apply(batch, context))
      await Effect.runPromise(original.close())

      const database = new DatabaseSync(databasePath)
      try {
        const query =
          scenario.target === "receipt"
            ? database.prepare(
                "SELECT result_json AS json FROM issue_plan_batches WHERE id = ?",
              )
            : database.prepare(
                "SELECT payload_json AS json FROM issue_plan_history WHERE batch_id = ? AND operation_index = ?",
              )
        const row =
          scenario.target === "receipt"
            ? query.get(saved.batchId)
            : query.get(saved.batchId, scenario.operationIndex)
        assert.ok(row !== undefined && typeof row.json === "string")

        if (scenario.target === "missing-event") {
          database
            .prepare(
              "DELETE FROM issue_plan_history WHERE batch_id = ? AND operation_index = ?",
            )
            .run(saved.batchId, scenario.operationIndex)
          const receiptRow = database
            .prepare("SELECT result_json FROM issue_plan_batches WHERE id = ?")
            .get(saved.batchId)
          assert.ok(
            receiptRow !== undefined &&
              typeof receiptRow.result_json === "string",
          )

          const receipt: unknown = JSON.parse(receiptRow.result_json)
          assert.ok(
            typeof receipt === "object" &&
              receipt !== null &&
              "eventCount" in receipt,
          )
          assert.ok(
            typeof receipt.eventCount === "number" && receipt.eventCount > 0,
          )
          receipt.eventCount -= 1
          database
            .prepare(
              "UPDATE issue_plan_batches SET result_json = ? WHERE id = ?",
            )
            .run(JSON.stringify(receipt), saved.batchId)
        } else {
          const corrupted = scenario.corrupt(row.json)
          assert.notEqual(corrupted, row.json)

          if (scenario.target === "history") {
            database
              .prepare(
                "UPDATE issue_plan_history SET payload_json = ? WHERE batch_id = ? AND operation_index = ?",
              )
              .run(corrupted, saved.batchId, scenario.operationIndex)
          } else {
            database
              .prepare(
                "UPDATE issue_plan_batches SET result_json = ? WHERE id = ?",
              )
              .run(corrupted, saved.batchId)
          }
        }
        const beforeReplay = snapshot(database)
        const reopened = await Effect.runPromise(
          openSqliteTaskStore({ databasePath }),
        )
        try {
          const replayed = await Effect.runPromise(
            Effect.either(reopened.apply(batch, context)),
          )
          assert.ok(
            Either.isLeft(replayed),
            "corrupted history must not confirm a durable receipt",
          )
          assert.equal(replayed.left.code, "corrupt_state")
          assert.equal(snapshot(database), beforeReplay)
        } finally {
          await Effect.runPromise(reopened.close())
        }
      } finally {
        database.close()
      }
    } finally {
      rmSync(root, { recursive: true })
    }
  })
}
