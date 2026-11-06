import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test, { mock } from "node:test"
import { fileURLToPath } from "node:url"
import { Effect, Either, Option } from "effect"
import { decodeIssueReference, type IssueReference } from "./identity.ts"
import { openSqliteTaskStore, type SqliteTaskStore } from "./sqlite-store.ts"

const parent = fileURLToPath(
  new URL("../../../../.tmp/task-hud/", import.meta.url),
)
const reference = (
  repository = "0xgleb/dotconfig",
  number = 201,
): IssueReference => {
  const result = decodeIssueReference({ repository, number })
  assert.ok(Either.isRight(result))
  return result.right
}
const issue = reference()
const context = () => ({
  actorId: "progress-fixture",
  requestId: randomUUID(),
  now: 1000,
  cancellation: "owner-authorized" as const,
})
const fixture = async (
  work: (store: SqliteTaskStore, path: string) => Promise<void>,
) => {
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(parent, "progress-"))
  const path = join(root, "tasks.sqlite")
  const store = await Effect.runPromise(
    openSqliteTaskStore({ databasePath: path }),
  )
  try {
    await work(store, path)
  } finally {
    await Effect.runPromise(store.close())
    rmSync(root, { recursive: true })
  }
}
const add = (store: SqliteTaskStore, target = issue, text = "Current task") =>
  Effect.runPromise(
    store.apply(
      {
        issues: [target],
        operations: [{ op: "add", issue: target, key: "one", text }],
      },
      context(),
    ),
  )

const errorCode = async <A, E extends { readonly code: string }>(
  effect: Effect.Effect<A, E>,
  expected: E["code"],
) => {
  const result = await Effect.runPromise(Effect.either(effect))
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, expected)
}

test("issue progress counts every task beyond a page and retains the current native UUID", async () =>
  fixture(async store => {
    const additions = Array.from({ length: 120 }, (_, index) => ({
      op: "add",
      issue,
      key: `task${index}`,
      text: `Requirement ${index}`,
    }))
    const states = Array.from({ length: 52 }, (_, index) => ({
      op: "status",
      target: { issue, task: { kind: "added", key: `task${index}` } },
      status: index < 40 ? "done" : index < 50 ? "cancelled" : "doing",
    }))
    const blocks = [0, 40, 50, 52].map(index => ({
      op: "block",
      target: { issue, task: { kind: "added", key: `task${index}` } },
      reason: "Factual blocker",
    }))
    const saved = await Effect.runPromise(
      store.apply(
        { issues: [issue], operations: [...additions, ...states, ...blocks] },
        context(),
      ),
    )
    await add(store, reference("other/repository"), "Other issue task")
    const progress = await Effect.runPromise(store.readProgress(issue))
    assert.ok(Option.isSome(progress))
    assert.deepEqual(progress.value.counts, {
      total: 120,
      todo: 68,
      doing: 2,
      done: 40,
      cancelled: 10,
      blocked: 4,
    })
    assert.equal(progress.value.revision, 1)
    assert.deepEqual(progress.value.issue, issue)
    const expected = saved.created
      .filter(row => row.key === "task50" || row.key === "task51")
      .map(row => row.id)
      .sort()[0]
    assert.ok(expected)
    assert.equal(progress.value.currentTask?.id, expected)
    assert.equal(progress.value.currentTask?.status, "doing")
    assert.match(progress.value.currentTask?.text ?? "", /^Requirement 5[01]$/)
    assert.ok(Object.isFrozen(progress.value.counts))
  }))

test("progress distinguishes missing local state, empty persisted issue and settled work", async () =>
  fixture(async store => {
    assert.ok(Option.isNone(await Effect.runPromise(store.readProgress(issue))))
    assert.ok(
      Option.isNone(
        await Effect.runPromise(store.readTasks(issue, { limit: 10 })),
      ),
    )
    const saved = await add(store)
    const created = saved.created[0]
    assert.ok(created)
    await Effect.runPromise(
      store.apply(
        {
          issues: [issue],
          operations: [
            {
              op: "status",
              target: { issue, task: { kind: "existing", id: created.id } },
              status: "done",
            },
          ],
        },
        context(),
      ),
    )
    const settled = await Effect.runPromise(store.readProgress(issue))
    assert.ok(Option.isSome(settled))
    assert.deepEqual(settled.value.counts, {
      total: 1,
      todo: 0,
      doing: 0,
      done: 1,
      cancelled: 0,
      blocked: 0,
    })
    assert.equal(settled.value.currentTask, null)
    const other = reference("other/repository")
    await Effect.runPromise(
      store.apply(
        {
          issues: [issue, other],
          operations: [
            {
              op: "transfer",
              target: { issue, task: { kind: "existing", id: created.id } },
              toIssue: other,
            },
          ],
        },
        context(),
      ),
    )
    const empty = await Effect.runPromise(store.readProgress(issue))
    assert.ok(Option.isSome(empty))
    assert.equal(empty.value.revision, 3)
    assert.deepEqual(empty.value.counts, {
      total: 0,
      todo: 0,
      doing: 0,
      done: 0,
      cancelled: 0,
      blocked: 0,
    })
    assert.equal(empty.value.currentTask, null)
  }))

test("progress validates qualified inputs and reports closed stores without creating task state", async () =>
  fixture(async store => {
    await errorCode(
      store.readProgress({ ...issue, number: 0 } as IssueReference),
      "invalid_input",
    )
    assert.ok(Option.isNone(await Effect.runPromise(store.readProgress(issue))))
    await Effect.runPromise(store.close())
    await errorCode(store.readProgress(issue), "closed")
  }))

test("progress rejects corrupt lifecycle counts and malformed current-task text", async () =>
  fixture(async (store, path) => {
    const saved = await add(store)
    const created = saved.created[0]
    assert.ok(created)
    const database = new DatabaseSync(path)
    try {
      database.exec("PRAGMA ignore_check_constraints = ON")
      database
        .prepare("UPDATE issue_plan_tasks SET status = 'mystery' WHERE id = ?")
        .run(created.id)
      await errorCode(store.readProgress(issue), "corrupt_state")
      database
        .prepare(
          "UPDATE issue_plan_tasks SET status = 'doing', text = '   ' WHERE id = ?",
        )
        .run(created.id)
      await errorCode(store.readProgress(issue), "corrupt_state")
    } finally {
      database.close()
    }
  }))

test("progress revision, counts and preview share one snapshot across a concurrent commit", async () =>
  fixture(async (store, path) => {
    const saved = await add(store, issue, "Before concurrent commit")
    const created = saved.created[0]
    assert.ok(created)
    const prepare = DatabaseSync.prototype.prepare
    let advanced = false
    const interception = mock.method(
      DatabaseSync.prototype,
      "prepare",
      function (this: DatabaseSync, query: string) {
        const statement = prepare.call(this, query)
        if (query.includes("COUNT(*)") && query.includes("issue_plan_tasks")) {
          const get = statement.get
          Object.defineProperty(statement, "get", {
            value: (...parameters: readonly unknown[]) => {
              const result: unknown = Reflect.apply(get, statement, parameters)
              if (!advanced) {
                advanced = true
                const writer = new DatabaseSync(path)
                try {
                  writer.exec("BEGIN IMMEDIATE")
                  prepare
                    .call(
                      writer,
                      "UPDATE issue_plan_tasks SET status = 'done', text = 'After concurrent commit' WHERE id = ?",
                    )
                    .run(created.id)
                  prepare
                    .call(
                      writer,
                      "UPDATE issue_plans SET revision = revision + 1 WHERE repository = ? AND issue_number = ?",
                    )
                    .run(issue.repository, issue.number)
                  writer.exec("COMMIT")
                } finally {
                  writer.close()
                }
              }
              return result
            },
          })
        }
        return statement
      },
    )
    try {
      const progress = await Effect.runPromise(store.readProgress(issue))
      assert.ok(advanced, "Concurrent write barrier must actually run")
      assert.ok(Option.isSome(progress))
      assert.equal(progress.value.revision, 1)
      assert.equal(progress.value.counts.todo, 1)
      assert.equal(progress.value.currentTask?.text, "Before concurrent commit")
      const latest = await Effect.runPromise(store.readProgress(issue))
      assert.ok(Option.isSome(latest))
      assert.equal(latest.value.revision, 2)
      assert.equal(latest.value.counts.done, 1)
      assert.equal(latest.value.currentTask, null)
    } finally {
      interception.mock.restore()
    }
  }))
