import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import test, { mock } from "node:test"
import { fileURLToPath } from "node:url"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { Effect, Either, Option } from "effect"
import { decodeIssueReference } from "./identity.ts"
import { openSqliteTaskStore, type SqliteTaskStore } from "./sqlite-store.ts"
import {
  createTaskHudComponent,
  taskHudLines,
  taskHudStatus,
  type TaskHudView,
  type ConfirmedTaskHudFocus,
} from "./hud.ts"

const decoded = decodeIssueReference({
  repository: "0xgleb/dotconfig",
  number: 201,
})
assert.ok(Either.isRight(decoded))
const issue = decoded.right

const focus: ConfirmedTaskHudFocus = {
  kind: "issue",
  issue,
  mode: "implementation",
}

const parent = fileURLToPath(
  new URL("../../../../.tmp/task-hud/", import.meta.url),
)

const context = () => ({
  actorId: "hud-fixture",
  requestId: randomUUID(),
  now: 1000,
  cancellation: "owner-authorized" as const,
})

const fixture = async (
  work: (
    store: SqliteTaskStore,
    view: Extract<TaskHudView, { readonly kind: "ready" }>,
  ) => Promise<void>,
) => {
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(parent, "presentation-"))
  const store = await Effect.runPromise(
    openSqliteTaskStore({ databasePath: join(root, "tasks.sqlite") }),
  )
  try {
    const operations = [
      {
        op: "add",
        issue,
        key: "current",
        text: "Ship 界🦆 HUD\nRead\tprogress \u009b31m",
      },
      { op: "add", issue, key: "done", text: "Finished requirement" },
      { op: "add", issue, key: "cancelled", text: "Withdrawn requirement" },
      { op: "add", issue, key: "waiting", text: "Pending requirement" },
      {
        op: "status",
        target: { issue, task: { kind: "added", key: "current" } },
        status: "doing",
      },
      {
        op: "status",
        target: { issue, task: { kind: "added", key: "done" } },
        status: "done",
      },
      {
        op: "status",
        target: { issue, task: { kind: "added", key: "cancelled" } },
        status: "cancelled",
      },
      {
        op: "block",
        target: { issue, task: { kind: "added", key: "waiting" } },
        reason: "Needs verified build",
      },
    ]
    await Effect.runPromise(
      store.apply({ issues: [issue], operations }, context()),
    )
    const progress = await Effect.runPromise(store.readProgress(issue))
    assert.ok(Option.isSome(progress))
    await work(store, {
      kind: "ready",
      mode: "implementation",
      progress: progress.value,
    })
  } finally {
    await Effect.runPromise(store.close())
    rmSync(root, { recursive: true })
  }
}

const theme = {
  fg: (token: string, text: string) =>
    `\u001b[${token === "muted" ? 90 : token === "accent" ? 36 : 34}m${text}\u001b[39m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
} as unknown as Theme

test("task HUD reuses two framed rows for qualified issue progress and one current task", async () =>
  fixture(async (_store, view) => {
    const lines = taskHudLines(view, 120)
    assert.equal(lines.length, 2)
    assert.match(lines[0] ?? "", /0xgleb\/dotconfig#201/)
    assert.match(lines[0] ?? "", /2\/4 settled/)
    assert.match(lines[0] ?? "", /1 cancelled/)
    assert.match(lines[0] ?? "", /1 blocked/)
    assert.match(lines[0] ?? "", /50%/)
    assert.match(lines[0] ?? "", /▰+▱+/)
    assert.match(lines[1] ?? "", /\[\/\].*Ship 界🦆 HUD Read progress/)
    assert.doesNotMatch(lines.join("\n"), /\u009b/)
    assert.match(lines[1] ?? "", /\\u009b/)
    assert.equal(taskHudStatus(view), "tasks:2/4 settled")
  }))

test("HUD width and Unicode elision remain pane-relative without adding rows", async () =>
  fixture(async (_store, view) => {
    for (const width of [1, 5, 6, 12, 24, 40, 80, 120]) {
      const lines = taskHudLines(view, width)
      assert.equal(lines.length, width < 6 ? 1 : 2)
      assert.ok(lines.every(line => visibleWidth(line) === width))
      if (width >= 24) assert.match(lines[0] ?? "", /#201/)
    }
    assert.deepEqual(taskHudLines(view, 0), [])
  }))

test("missing, loading, unconfirmed and failed progress never pretend zero completion", () => {
  const cases: readonly [TaskHudView, RegExp][] = [
    [{ kind: "missing", focus }, /No local task state/],
    [{ kind: "loading", focus }, /Loading progress/],
    [{ kind: "unconfirmed" }, /unconfirmed/i],
    [{ kind: "selection_unavailable", code: "invalid_state" }, /unavailable/i],
    [
      { kind: "progress_unavailable", focus, code: "busy" },
      /unavailable.*busy|busy.*unavailable/is,
    ],
  ]
  for (const [view, expected] of cases) {
    const text = taskHudLines(view, 100).join("\n")
    assert.match(text, expected)
    assert.doesNotMatch(text, /0\/0|0%|100%/)
    assert.ok(taskHudStatus(view))
  }
  assert.deepEqual(taskHudLines({ kind: "none" }, 100), [])
  assert.equal(taskHudStatus({ kind: "none" }), undefined)
})

test("cancelled tasks are settled rather than mislabeled done and no stale current task is invented", async () =>
  fixture(async (store, view) => {
    const page = await Effect.runPromise(store.readTasks(issue, { limit: 10 }))
    assert.ok(Option.isSome(page))
    const unfinished = page.value.tasks.filter(
      task => task.status === "doing" || task.status === "todo",
    )
    await Effect.runPromise(
      store.apply(
        {
          issues: [issue],
          operations: unfinished.map(task => ({
            op: "status",
            target: { issue, task: { kind: "existing", id: task.id } },
            status: task.status === "doing" ? "done" : "cancelled",
          })),
        },
        context(),
      ),
    )
    const progress = await Effect.runPromise(store.readProgress(issue))
    assert.ok(Option.isSome(progress))
    const settled: TaskHudView = { ...view, progress: progress.value }
    const text = taskHudLines(settled, 120).join("\n")
    assert.match(text, /4\/4 settled/)
    assert.match(text, /2 cancelled/)
    assert.match(text, /100%/)
    assert.match(text, /All tasks settled/)
    assert.doesNotMatch(text, /4 done/)
    assert.equal(progress.value.currentTask, null)
  }))

test("persisted empty issues render zero tasks without a fabricated completion percentage", async () =>
  fixture(async (store, view) => {
    const other = decodeIssueReference({ repository: "other/repo", number: 1 })
    assert.ok(Either.isRight(other))
    const page = await Effect.runPromise(store.readTasks(issue, { limit: 10 }))
    assert.ok(Option.isSome(page))
    await Effect.runPromise(
      store.apply(
        {
          issues: [issue, other.right],
          operations: page.value.tasks.map(task => ({
            op: "transfer",
            target: { issue, task: { kind: "existing", id: task.id } },
            toIssue: other.right,
          })),
        },
        context(),
      ),
    )
    const progress = await Effect.runPromise(store.readProgress(issue))
    assert.ok(Option.isSome(progress))
    const empty: TaskHudView = { ...view, progress: progress.value }
    const text = taskHudLines(empty, 100).join("\n")
    assert.match(text, /0 tasks/)
    assert.match(text, /No tasks recorded/)
    assert.doesNotMatch(text, /0\/0|0%|100%/)
    assert.equal(taskHudStatus(empty), "tasks:0")
  }))

test("review focus and changing cached views remain readable at narrow widths", async () =>
  fixture(async (_store, view) => {
    let snapshot: TaskHudView = { ...view, mode: "review" }
    const component = createTaskHudComponent(
      () => snapshot,
      theme,
      () => 0,
    )
    assert.match(taskHudLines(snapshot, 120)[0] ?? "", /Review/)
    for (const width of [24, 55, 80, 120]) {
      const lines = component.render(width)
      assert.ok(lines.every(line => visibleWidth(line) === width))
      assert.match(taskHudLines(snapshot, width)[0] ?? "", /#201/)
    }
    snapshot = { kind: "loading", focus }
    assert.match(component.render(120).join("\n"), /Loading progress/)
    snapshot = { kind: "none" }
    assert.deepEqual(component.render(120), [])
  }))

test("native component pulses by wall clock without a background timer or render-count animation", async () =>
  fixture(async (_store, view) => {
    let now = 0
    let reads = 0
    const timer = mock.method(globalThis, "setInterval", () =>
      assert.fail("HUD must not schedule a background timer"),
    )
    try {
      const component = createTaskHudComponent(
        () => {
          reads += 1
          return view
        },
        theme,
        () => now,
      )
      const initial = component.render(120)
      assert.equal(reads, 1)
      for (let index = 0; index < 5; index += 1)
        assert.deepEqual(component.render(120), initial)
      now = 300
      assert.notDeepEqual(component.render(120), initial)
      assert.ok(component.render(24).every(line => visibleWidth(line) === 24))
      component.invalidate()
      assert.ok(component.render(120).length === 2)
    } finally {
      timer.mock.restore()
    }
  }))
