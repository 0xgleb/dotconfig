import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import { createOwnerAllowance } from "../classified-workflows/owner-allowance.ts"
import type { ContentProcess } from "../shared/content-process.ts"
import {
  createReportJobs,
  REPORT_JOB_ENTRY,
  type ReportSnapshot,
} from "./report-jobs.ts"

const accepted = JSON.stringify({
  admissible: true,
  reason: "No meaningful defects.",
  coverage: "complete",
})
const rejected = JSON.stringify({
  admissible: false,
  reason: "The paragraph hides the current blocker; put it first.",
  coverage: "complete",
})
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const fixture = (
  process: ContentProcess,
  options: {
    deliver?: () => Promise<{ outcome: "delivered" }>
    persist?: (value: ReportSnapshot) => Either.Either<void, string>
  } = {},
) => {
  const guard = createOwnerAllowance({
    now: Date.now,
    schedule: (callback, delay) => setTimeout(callback, delay),
    clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    persist: () => {},
    cancel: () => {},
  })
  assert.ok(Either.isRight(guard.ownerInput(Date.now())))
  const sent: string[] = []
  const journal: ReportSnapshot[] = []
  const terminals: ReportSnapshot[] = []
  const jobs = createReportJobs({
    execution: guard,
    process,
    prepare: (_kind, text) => text,
    deliver: async (_kind, text) => {
      sent.push(text)
      return options.deliver ? options.deliver() : { outcome: "delivered" }
    },
    persist:
      options.persist ??
      (value => {
        journal.push(value)
        return Either.right(undefined)
      }),
    present: () => {},
    onTerminal: snapshot => {
      terminals.push(snapshot)
    },
  })
  return {
    jobs,
    sent,
    journal,
    terminals,
    guard,
    close: () => {
      jobs.close()
      guard.dispose()
    },
    submit: (
      text = "Fixture status.",
      kind: "owner-report" | "stakeholder-update" = "owner-report",
      signal?: AbortSignal,
    ) =>
      jobs.submit({
        kind,
        text,
        sender: "agent-fixture",
        isCurrent: () => true,
        context: { cwd: "/fixture" },
        signal,
      }),
  }
}
const settle = async (jobs: ReturnType<typeof createReportJobs>) => {
  for (let i = 0; i < 20; i++) {
    if (
      jobs
        .snapshots()
        .every(
          job =>
            !["queued", "reviewing", "revising", "sending"].includes(
              job.status,
            ),
        )
    )
      return
    await turn()
  }
  assert.fail("report did not reach a bounded terminal state")
}

test("submission returns queued while whole-text critic is unresolved, then sends exactly once", async t => {
  let complete: (text: string) => void = () => {}
  const calls: string[] = []
  const f = fixture(async (_ctx, request) => {
    calls.push(request.prompt)
    return new Promise(resolve => {
      complete = resolve
    })
  })
  t.after(f.close)
  const text =
    "**Status (1)**\n- [222d840](https://github.com/0xgleb/dotconfig/commit/222d840): 81 tests pass; SDK integration is not live."
  const result = f.submit(text)
  assert.ok(Either.isRight(result))
  assert.equal(result.right.status, "queued")
  assert.equal(f.sent.length, 0)
  await turn()
  assert.equal(f.jobs.snapshots()[0]?.status, "reviewing")
  assert.ok(calls[0]?.includes(JSON.stringify(text)))
  complete(accepted)
  await settle(f.jobs)
  assert.deepEqual(f.sent, [text])
  assert.equal(f.terminals.length, 1)
  assert.equal(f.terminals[0]?.status, "delivered")
  assert.equal(f.jobs.snapshots()[0]?.status, "delivered")
  assert.match(f.jobs.snapshots()[0]?.reviewedHash ?? "", /^[a-f0-9]{64}$/)
})

test("critic, author, fresh critic run inside the job; only the final reviewed revision sends", async t => {
  const calls: { role: string; prompt: string }[] = []
  const revised = "SDK integration is not live; 81 tests pass."
  const f = fixture(async (_ctx, request) => {
    calls.push(request)
    return calls.length === 1
      ? rejected
      : request.role === "author"
        ? JSON.stringify({ text: revised })
        : accepted
  })
  t.after(f.close)
  f.submit("81 tests pass; SDK integration is not live.")
  await settle(f.jobs)
  assert.deepEqual(
    calls.map(call => call.role),
    ["critic", "author", "critic"],
  )
  assert.ok(calls[1]?.prompt.includes("The paragraph hides"))
  assert.ok(
    !calls[2]?.prompt.includes("The paragraph hides"),
    "fresh critic must not receive prior findings",
  )
  assert.deepEqual(f.sent, [revised])
})

test("two critique passes is a hard cap; rejected content never sends", async t => {
  let count = 0
  const f = fixture(async (_ctx, request) => {
    count++
    return request.role === "critic"
      ? rejected
      : JSON.stringify({ text: "Same fixture status, revised." })
  })
  t.after(f.close)
  f.submit()
  await settle(f.jobs)
  assert.equal(count, 3)
  assert.equal(f.jobs.snapshots()[0]?.status, "needs-revision")
  assert.equal(f.sent.length, 0)
})

for (const value of [
  undefined,
  "not JSON",
  JSON.stringify({ admissible: true, reason: "Partial.", coverage: "partial" }),
  JSON.stringify({ admissible: true, reason: "Missing coverage." }),
]) {
  test(`unavailable/malformed/partial review fails closed: ${String(value)}`, async t => {
    const f = fixture(async () => value)
    t.after(f.close)
    f.submit()
    await settle(f.jobs)
    assert.equal(f.jobs.snapshots()[0]?.status, "review-unavailable")
    assert.equal(f.sent.length, 0)
  })
}

test("stakeholder text is exact: criticism never authorizes automatic rewriting", async t => {
  const roles: string[] = []
  const f = fixture(async (_ctx, request) => {
    roles.push(request.role)
    return rejected
  })
  t.after(f.close)
  f.submit("Exact forwardable stakeholder draft.", "stakeholder-update")
  await settle(f.jobs)
  assert.deepEqual(roles, ["critic"])
  assert.equal(f.jobs.snapshots()[0]?.status, "needs-revision")
  assert.equal(f.sent.length, 0)
})

test("author cannot replace original links, even if its output is otherwise valid", async t => {
  const f = fixture(async (_ctx, request) =>
    request.role === "critic"
      ? rejected
      : JSON.stringify({ text: "See https://example.org/changed" }),
  )
  t.after(f.close)
  f.submit("See https://example.org/original")
  await settle(f.jobs)
  assert.equal(f.sent.length, 0)
  assert.equal(f.jobs.snapshots()[0]?.status, "review-unavailable")
})

test("cancellation and late critic completion cannot send; close never replays jobs", async t => {
  let complete: (value: string) => void = () => {}
  const f = fixture(
    async () =>
      new Promise(resolve => {
        complete = resolve
      }),
  )
  t.after(f.close)
  const result = f.submit()
  assert.ok(Either.isRight(result))
  await turn()
  f.jobs.cancel(result.right.id)
  complete(accepted)
  await settle(f.jobs)
  assert.equal(f.jobs.snapshots()[0]?.status, "cancelled")
  assert.equal(f.sent.length, 0)
  f.jobs.close()
  assert.ok(Either.isLeft(f.submit()))
})

test("original submission deadline does not grow after another owner message", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() })
  let complete: (value: string) => void = () => {}
  const f = fixture(
    async () =>
      new Promise(resolve => {
        complete = resolve
      }),
  )
  t.after(f.close)
  f.submit()
  await turn()
  t.mock.timers.tick(1_000)
  f.guard.ownerInput(Date.now())
  t.mock.timers.tick(30 * 60_000 - 1_000)
  complete(accepted)
  await turn()
  assert.equal(f.sent.length, 0)
  assert.equal(f.jobs.snapshots()[0]?.status, "cancelled")
  assert.ok(
    Either.isRight(f.guard.admit()),
    "the newer owner allowance itself remains valid",
  )
})

test("interruption during sending is uncertain, never an automatic retry", async t => {
  let complete: (value: { outcome: "delivered" }) => void = () => {}
  const f = fixture(async () => accepted, {
    deliver: () =>
      new Promise(resolve => {
        complete = resolve
      }),
  })
  t.after(f.close)
  const result = f.submit()
  assert.ok(Either.isRight(result))
  await turn()
  assert.equal(f.jobs.snapshots()[0]?.status, "sending")
  f.jobs.cancel(result.right.id)
  assert.equal(f.jobs.snapshots()[0]?.status, "uncertain")
  assert.equal(f.sent.length, 1)
  complete({ outcome: "delivered" })
  await turn()
  assert.equal(
    f.jobs.snapshots()[0]?.status,
    "delivered",
    "actual late delivery evidence must not be hidden",
  )
  assert.equal(f.sent.length, 1)
})

test("reload restores interrupted status without replaying a report", async t => {
  const first = fixture(async () => new Promise(() => {}))
  const next = fixture(async () => {
    assert.fail("restore must not invoke a model")
  })
  t.after(first.close)
  t.after(next.close)
  first.submit()
  await turn()
  const persisted = first.journal.map(data => ({
    type: "custom",
    customType: REPORT_JOB_ENTRY,
    data,
  }))
  first.close()
  assert.ok(Either.isRight(next.jobs.restore(persisted)))
  assert.equal(next.jobs.snapshots()[0]?.status, "interrupted")
  await turn()
  assert.equal(next.sent.length, 0)
  assert.equal(
    next.terminals.length,
    0,
    "restoring history must not replay completion notifications",
  )
  assert.ok(
    Either.isLeft(
      next.jobs.restore([
        {
          type: "custom",
          customType: REPORT_JOB_ENTRY,
          data: { status: "delivered" },
        },
      ]),
    ),
  )
  assert.equal(
    next.jobs.snapshots().length,
    0,
    "malformed state cannot reuse stale previous-session history",
  )
})

test("session identity changes stop pending content without writing into the new session", async t => {
  let current = true
  let complete: (value: string) => void = () => {}
  const f = fixture(
    async () =>
      new Promise(resolve => {
        complete = resolve
      }),
  )
  t.after(f.close)
  const result = f.jobs.submit({
    kind: "owner-report",
    text: "Original session report.",
    sender: "agent-fixture",
    context: { cwd: "/fixture" },
    isCurrent: () => current,
  })
  assert.ok(Either.isRight(result))
  await turn()
  const count = f.journal.length
  current = false
  complete(accepted)
  await turn()
  assert.equal(f.sent.length, 0)
  assert.equal(
    f.journal.length,
    count,
    "old report metadata must not journal into the new session",
  )
})

test("journal failure prevents starting any background work", t => {
  const f = fixture(
    async () => {
      assert.fail("must not start reviewer")
    },
    { persist: () => Either.left("fixture unavailable") },
  )
  t.after(f.close)
  assert.ok(Either.isLeft(f.submit()))
  assert.equal(f.sent.length, 0)
})
