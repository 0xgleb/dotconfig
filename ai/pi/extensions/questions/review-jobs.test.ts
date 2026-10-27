import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import { createOwnerAllowance } from "../classified-workflows/owner-allowance.ts"
import type { ContentProcess } from "../shared/content-process.ts"
import {
  createQuestionReviewJobs,
  decodeQuestionDraft,
  QUESTION_REVIEW_ENTRY,
  type QuestionReviewSnapshot,
  type ReviewableQuestion,
} from "./review-jobs.ts"

const draft: ReviewableQuestion = {
  action: "ask",
  question:
    "Should [file.ts](https://example.com/file.ts) use the bounded queue?",
  header: "Queue",
  guess: "Use a bounded queue.",
  options: [{ label: "Use queue" }, { label: "Keep current" }],
}
const verdict = (admissible: boolean, reason = "Complete assessment.") =>
  JSON.stringify({ admissible, reason, coverage: "complete" })
const revised = {
  question:
    "Should the [file.ts](https://example.com/file.ts) queue admit four drafts at most?",
  header: "Queue",
  guess: "Use a bounded queue.",
  options: [{ label: "Use queue" }, { label: "Keep current" }],
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const settle = async () => {
  for (let index = 0; index < 12; index++)
    await new Promise(resolve => setImmediate(resolve))
}
const fixture = (t: test.TestContext, process: ContentProcess) => {
  const guard = createOwnerAllowance({
    now: Date.now,
    schedule: () => 0,
    clear: () => {},
    persist: () => {},
    cancel: () => {},
  })
  assert.ok(Either.isRight(guard.ownerInput(Date.now())))
  const journal: QuestionReviewSnapshot[] = []
  const sent: ReviewableQuestion[] = []
  const terminal: QuestionReviewSnapshot[] = []
  const jobs = createQuestionReviewJobs({
    execution: guard,
    process,
    persist: snapshot => {
      journal.push(snapshot)
      return Either.right(undefined)
    },
    present: () => {},
    onTerminal: snapshot => {
      terminal.push(snapshot)
    },
    publish: async request => {
      sent.push(request)
      return { outcome: "queued", questionId: 7 }
    },
  })
  t.after(() => {
    jobs.close()
    guard.dispose()
  })
  const context = {
    cwd: processCwd,
    sessionId: "session",
    getModel: () => ({ provider: "openai-codex", id: "gpt-6.1-sol" }),
    isCurrent: () => true,
  }
  return { jobs, guard, journal, sent, terminal, context }
}
const processCwd = process.cwd()

test("returns immediately; internal critic-author-fresh critic publishes only the final reviewed card", async t => {
  const first = deferred<string | undefined>()
  const roles: string[] = []
  const prompts: string[] = []
  const f = fixture(t, async (_ctx, task) => {
    roles.push(task.role)
    prompts.push(task.prompt)
    return roles.length === 1
      ? first.promise
      : task.role === "author"
        ? JSON.stringify(revised)
        : verdict(true)
  })
  const queued = f.jobs.submit(draft, f.context)
  assert.ok(Either.isRight(queued))
  assert.equal(queued.right.status, "queued-review")
  await settle()
  assert.deepEqual(roles, ["critic"])
  assert.equal(f.sent.length, 0)
  first.resolve(verdict(false, "UNIQUE_PRIVATE_CRITIC_FEEDBACK"))
  await settle()
  assert.deepEqual(roles, ["critic", "author", "critic"])
  assert.match(prompts[1], /UNIQUE_PRIVATE_CRITIC_FEEDBACK/)
  assert.doesNotMatch(prompts[2], /UNIQUE_PRIVATE_CRITIC_FEEDBACK/)
  assert.deepEqual(f.sent, [{ action: "ask", ...revised }])
  assert.equal(f.jobs.snapshots()[0].status, "queued-question")
  assert.equal(f.jobs.snapshots()[0].questionId, 7)
  assert.match(f.jobs.snapshots()[0].reviewedHash!, /^[a-f0-9]{64}$/)
  assert.equal(f.terminal.length, 1)
  assert.ok(
    !JSON.stringify(f.journal).includes(draft.question),
    "journal is metadata, not a replayable draft",
  )
})

test("two editorial critiques end with the author's final revision and a queued question", async t => {
  const roles: string[] = []
  const final = {
    ...revised,
    question:
      "Should [file.ts](https://example.com/file.ts) admit at most four pending decision drafts?",
  }
  let authors = 0
  const f = fixture(t, async (_ctx, task) => {
    roles.push(task.role)
    return task.role === "author"
      ? JSON.stringify(++authors === 1 ? revised : final)
      : verdict(false, "Make the decision concrete without changing its scope.")
  })
  f.jobs.submit(draft, f.context)
  await settle()

  const snapshot = f.jobs.snapshots()[0]

  assert.ok(snapshot)
  assert.deepEqual(roles, ["critic", "author", "critic", "author"])
  assert.equal(snapshot.status, "queued-question")
  assert.equal(snapshot.pass, 2)
  assert.equal(snapshot.questionId, 7)
  assert.ok(snapshot.reason)
  assert.match(snapshot.reason, /final author revision/i)
  assert.deepEqual(f.sent, [{ action: "ask", ...final }])
  assert.equal(f.terminal.length, 1)
})

test("last author revision still rejects changed links instead of publishing", async t => {
  let authors = 0
  const f = fixture(t, async (_ctx, task) =>
    task.role === "critic"
      ? verdict(false)
      : JSON.stringify(
          ++authors === 1
            ? revised
            : { ...revised, question: "Use https://attacker.invalid instead?" },
        ),
  )
  f.jobs.submit(draft, f.context)
  await settle()

  const snapshot = f.jobs.snapshots()[0]

  assert.ok(snapshot)
  assert.equal(authors, 2)
  assert.equal(snapshot.status, "unavailable")
  assert.ok(snapshot.reason)
  assert.match(snapshot.reason, /changed URL set/)
  assert.equal(f.sent.length, 0)
})

test("cancellation during the last author revision prevents publication", async t => {
  const last = deferred<string | undefined>()
  let authors = 0
  const f = fixture(t, async (_ctx, task) =>
    task.role === "critic"
      ? verdict(false)
      : ++authors === 1
        ? JSON.stringify(revised)
        : last.promise,
  )
  f.jobs.submit(draft, f.context)
  await settle()

  const revisingSnapshot = f.jobs.snapshots()[0]

  assert.ok(revisingSnapshot)
  assert.equal(authors, 2)
  assert.equal(revisingSnapshot.status, "revising")
  f.jobs.cancelAll()
  last.resolve(JSON.stringify(revised))
  await settle()

  const cancelledSnapshot = f.jobs.snapshots()[0]

  assert.ok(cancelledSnapshot)
  assert.equal(cancelledSnapshot.status, "cancelled")
  assert.equal(f.sent.length, 0)
})

test("publication rejection remains an explicit operational failure, not editorial needs-revision", async t => {
  const f = fixture(t, async () => verdict(true))
  const jobs = createQuestionReviewJobs({
    execution: f.guard,
    process: async () => verdict(true),
    present: () => {},
    persist: () => Either.right(undefined),
    publish: async () => ({
      outcome: "rejected",
      reason: "Decision q4 is already pending; no duplicate created.",
    }),
  })
  t.after(() => jobs.close())
  jobs.submit(draft, f.context)
  await settle()

  const snapshot = jobs.snapshots()[0]

  assert.ok(snapshot)
  assert.equal(snapshot.status, "unavailable")
  assert.ok(snapshot.reason)
  assert.match(snapshot.reason, /Decision q4 is already pending/)
  assert.equal(snapshot.questionId, undefined)
})

for (const output of [
  undefined,
  "not JSON",
  JSON.stringify({
    admissible: true,
    reason: "Incomplete",
    coverage: "partial",
  }),
  JSON.stringify({ admissible: true, reason: "Missing coverage" }),
]) {
  test(`unavailable or incomplete critic stays inside bounded background passes: ${output}`, async t => {
    let calls = 0
    const f = fixture(t, async () => {
      calls++
      return output
    })
    f.jobs.submit(draft, f.context)
    await settle()
    assert.equal(calls, 2)
    assert.equal(f.jobs.snapshots()[0].status, "unavailable")
    assert.equal(f.sent.length, 0)
  })
}

test("author cannot change URLs or replacement identity before independent approval", async t => {
  const f = fixture(t, async (_ctx, task) =>
    task.role === "critic"
      ? verdict(false)
      : JSON.stringify({
          ...revised,
          question: "Use https://attacker.invalid instead?",
        }),
  )
  f.jobs.submit(
    { ...draft, action: "replace", id: 4, reason: "Repair context" },
    f.context,
  )
  await settle()
  assert.equal(f.jobs.snapshots()[0].status, "unavailable")
  assert.equal(f.sent.length, 0)
})

test("replacement target and reason stay original; publishing happens only once at final acceptance", async t => {
  let critiques = 0
  const f = fixture(t, async (_ctx, task) =>
    task.role === "author" ? JSON.stringify(revised) : verdict(++critiques > 1),
  )
  f.jobs.submit(
    { ...draft, action: "replace", id: 4, reason: "Repair context" },
    f.context,
  )
  await settle()
  assert.deepEqual(f.sent, [
    { action: "replace", id: 4, reason: "Repair context", ...revised },
  ])
})

test("owner renewal cannot extend original child deadline or admit an expired draft", async t => {
  let now = 10_000
  t.mock.method(Date, "now", () => now)
  const first = deferred<string | undefined>()
  let inherited: number | undefined
  const f = fixture(t, async ctx => {
    const lease = ctx.execution!.admit()
    if (Either.isRight(lease)) inherited = lease.right.deadlineAt
    return first.promise
  })
  const initial = f.guard.admit()
  assert.ok(Either.isRight(initial))
  f.jobs.submit(draft, f.context)
  await settle()
  now += 500
  assert.ok(Either.isRight(f.guard.ownerInput(now)))
  assert.equal(inherited, initial.right.deadlineAt)
  now = initial.right.deadlineAt + 1
  first.resolve(verdict(true))
  await settle()
  assert.equal(f.jobs.snapshots()[0].status, "cancelled")
  assert.equal(f.sent.length, 0)
})

test("cancel and session changes cannot publish even after a late clean verdict", async t => {
  const first = deferred<string | undefined>()
  let signal: AbortSignal | undefined
  const f = fixture(t, async ctx => {
    signal = ctx.signal
    return first.promise
  })
  const abort = new AbortController()
  f.jobs.submit(draft, f.context, abort.signal)
  await settle()
  abort.abort()
  first.resolve(verdict(true))
  await settle()
  assert.equal(signal?.aborted, true)
  assert.equal(f.jobs.snapshots()[0].status, "cancelled")
  assert.equal(f.sent.length, 0)
  assert.equal(f.terminal.length, 1)
})

test("foreign session cannot journal or publish a late completion", async t => {
  const first = deferred<string | undefined>()
  const f = fixture(t, async () => first.promise)
  let current = true
  f.jobs.submit(draft, { ...f.context, isCurrent: () => current })
  await settle()
  const before = f.journal.length
  current = false
  first.resolve(verdict(true))
  await settle()
  assert.equal(f.sent.length, 0)
  assert.equal(f.journal.length, before)
  assert.equal(f.terminal.length, 0)
})

test("duplicate draft and four-slot cap do not create extra work", async t => {
  const hold = deferred<string | undefined>()
  const f = fixture(t, async () => hold.promise)
  assert.ok(Either.isRight(f.jobs.submit(draft, f.context)))
  assert.ok(Either.isLeft(f.jobs.submit(draft, f.context)))
  for (let index = 1; index < 4; index++)
    assert.ok(
      Either.isRight(
        f.jobs.submit(
          { ...draft, question: `${draft.question} ${index}` },
          f.context,
        ),
      ),
    )
  assert.ok(
    Either.isLeft(
      f.jobs.submit(
        { ...draft, question: `${draft.question} overflow` },
        f.context,
      ),
    ),
  )
  assert.equal(f.journal.length, 4)
  f.jobs.close()
  hold.resolve(undefined)
  await settle()
})

test("restore interrupts unfinished metadata without model, publish or terminal replay", async t => {
  let calls = 0
  const f = fixture(t, async () => {
    calls++
    return verdict(true)
  })
  const queued = f.jobs.submit(draft, f.context)
  assert.ok(Either.isRight(queued))
  const before = f.terminal.length
  assert.ok(
    Either.isRight(
      f.jobs.restore([
        {
          type: "custom",
          customType: QUESTION_REVIEW_ENTRY,
          data: queued.right,
        },
      ]),
    ),
  )
  await settle()
  assert.equal(calls, 0)
  assert.equal(f.sent.length, 0)
  assert.equal(f.jobs.snapshots()[0].status, "interrupted")
  assert.equal(
    f.terminal.length,
    before + 1,
    "only original cancellation, never restored terminal replay",
  )
})

test("malformed journal fails explicitly and blocks partial-trust continuation", t => {
  const f = fixture(t, async () => verdict(true))
  assert.ok(
    Either.isLeft(
      f.jobs.restore([
        {
          type: "custom",
          customType: QUESTION_REVIEW_ENTRY,
          data: { id: "bad", pass: 999 },
        },
      ]),
    ),
  )
  assert.ok(Either.isLeft(f.jobs.submit(draft, f.context)))
})

test("journal and cancellation-registration exceptions never leave an executable draft", async t => {
  const f = fixture(t, async () => verdict(true))
  const bad = createQuestionReviewJobs({
    execution: {
      ...f.guard,
      track: () => {
        throw new Error("tracking boundary failed")
      },
    },
    process: async () => verdict(true),
    present: () => {},
    persist: () => Either.right(undefined),
    publish: async () => {
      assert.fail("must not publish")
    },
  })
  t.after(() => bad.close())
  assert.ok(Either.isLeft(bad.submit(draft, f.context)))
  await settle()
  assert.equal(bad.snapshots()[0].status, "cancelled")
  const journal = createQuestionReviewJobs({
    execution: f.guard,
    process: async () => verdict(true),
    present: () => {},
    persist: () => {
      throw new Error("journal boundary failed")
    },
    publish: async () => {
      assert.fail("must not publish")
    },
  })
  t.after(() => journal.close())
  assert.ok(Either.isLeft(journal.submit(draft, f.context)))
})

test("late actual publication proof resolves interruption without claiming Telegram delivery", async t => {
  const f = fixture(t, async () => verdict(true))
  const proof = deferred<{ outcome: "queued"; questionId: number }>()
  const jobs = createQuestionReviewJobs({
    execution: f.guard,
    process: async () => verdict(true),
    present: () => {},
    persist: () => Either.right(undefined),
    publish: () => proof.promise,
  })
  t.after(() => jobs.close())
  const controller = new AbortController()
  jobs.submit(draft, f.context, controller.signal)
  await settle()
  assert.equal(jobs.snapshots()[0].status, "publishing")
  controller.abort()
  assert.equal(jobs.snapshots()[0].status, "interrupted")
  proof.resolve({ outcome: "queued", questionId: 8 })
  await settle()
  assert.equal(jobs.snapshots()[0].status, "queued-question")
  assert.equal(jobs.snapshots()[0].questionId, 8)
  assert.match(jobs.snapshots()[0].reason!, /delivery is not yet confirmed/)
  assert.doesNotMatch(jobs.snapshots()[0].reason!, /cancelled/)
})

test("missing authority and invalid publication identifiers cannot certify a question", async t => {
  const f = fixture(t, async () => verdict(true))
  const missing = createQuestionReviewJobs({
    process: async () => {
      assert.fail("must not run")
    },
    present: () => {},
    persist: () => Either.right(undefined),
    publish: async () => {
      assert.fail("must not publish")
    },
  })
  assert.ok(Either.isLeft(missing.submit(draft, f.context)))
  const jobs = createQuestionReviewJobs({
    execution: f.guard,
    process: async () => verdict(true),
    present: () => {},
    persist: () => Either.right(undefined),
    publish: async () => ({ outcome: "queued", questionId: 0 }),
  })
  t.after(() => jobs.close())
  jobs.submit(draft, f.context)
  await settle()
  assert.equal(jobs.snapshots()[0].status, "interrupted")
  assert.equal(jobs.snapshots()[0].questionId, undefined)
})

test("author receives transport limits; invalid field is diagnosed without exposing output", async t => {
  const f = fixture(t, async (_ctx, task) => {
    if (task.role === "critic") return verdict(false)
    assert.match(task.prompt, /header at most 16/)
    assert.match(task.prompt, /description at most 160/)
    assert.match(task.prompt, /never a report/)
    return JSON.stringify({
      ...revised,
      header: "PRIVATE_SYNTHETIC_TOO_LONG_HEADER",
    })
  })
  f.jobs.submit(draft, f.context)
  await settle()
  assert.match(f.jobs.snapshots()[0].reason!, /invalid header field/)
  assert.doesNotMatch(JSON.stringify(f.journal), /PRIVATE_SYNTHETIC/)
  assert.equal(f.sent.length, 0)
})

test("URL preservation compares decoded text fields, not JSON newline escapes", async t => {
  let count = 0
  const changedFormatting = {
    ...revised,
    question: "Should https://example.com/file.ts\nuse the bounded queue?",
  }
  const f = fixture(t, async (_ctx, task) =>
    task.role === "author"
      ? JSON.stringify(changedFormatting)
      : verdict(++count > 1),
  )
  f.jobs.submit(draft, f.context)
  await settle()
  assert.equal(f.jobs.snapshots()[0].status, "queued-question")
  assert.equal(f.sent[0].question, changedFormatting.question)
})

test("malformed input and author fields fail validation rather than coercion", () => {
  for (const value of [
    null,
    [],
    {},
    { question: 12 },
    { question: "valid?", options: [{ label: 4 }, { label: "ok" }] },
    { question: "valid?", header: "x".repeat(17) },
    { question: "valid?", action: "approve" },
  ])
    assert.equal(decodeQuestionDraft(value), undefined)
  assert.equal(
    decodeQuestionDraft({ question: "  valid?  " })?.question,
    "valid?",
  )
})
