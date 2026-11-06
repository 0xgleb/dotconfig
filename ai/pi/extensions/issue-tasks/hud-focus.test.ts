import assert from "node:assert/strict"
import test from "node:test"
import { Either, Option } from "effect"
import { currentIssueFromEntries, taskNextHudFocus } from "./hud-focus.ts"
import { nativeNextResult } from "./test-fixtures/next-result.ts"

const call = (id: string, args: unknown) => ({
  type: "toolCall",
  id,
  name: "task",
  arguments: args,
})

const assistant = (...content: readonly unknown[]) => ({
  type: "message",
  message: { role: "assistant", content },
})

const result = (toolCallId: string, details: unknown) => ({
  type: "message",
  message: { role: "toolResult", toolName: "task", toolCallId, details },
})

test("HUD focus follows the existing verified native selection without inventing IDs", async () => {
  const native = await nativeNextResult()
  const projected = taskNextHudFocus(native.args, native.details)
  assert.ok(Either.isRight(projected) && Option.isSome(projected.right))
  assert.deepEqual(projected.right.value, {
    kind: "issue",
    issue: native.issue,
    mode: "implementation",
  })
  const restored = currentIssueFromEntries([
    assistant(call("pick", native.args)),
    result("pick", native.details),
  ])
  assert.ok(Either.isRight(restored))
  assert.deepEqual(restored.right, projected.right.value)
})

test("review selection remains a read-only review focus", async () => {
  const native = await nativeNextResult(7, "review")
  const focused = taskNextHudFocus(native.args, native.details)
  assert.ok(Either.isRight(focused) && Option.isSome(focused.right))
  assert.deepEqual(focused.right.value, {
    kind: "issue",
    issue: native.issue,
    mode: "review",
  })
})

test("incidental reads and saved doing writes cannot replace native issue focus", async () => {
  const native = await nativeNextResult()
  const other = await nativeNextResult(8)
  const entries: unknown[] = [
    assistant(call("pick", native.args)),
    result("pick", native.details),
  ]
  const saved = {
    outcome: {
      kind: "saved",
      result: {
        kind: "saved",
        receipt: "committed",
        batchId: "20000000-0000-4000-8000-000000000001",
        issues: [{ issue: other.issue, revision: 1 }],
        changed: [
          {
            issue: other.issue,
            id: "10000000-0000-4000-8000-000000000001",
            revision: 1,
            fields: ["status"],
          },
        ],
        created: [],
        eventCount: 1,
      },
    },
    output: "complete",
  }
  for (const args of [
    { action: "read", issue: other.issue, page: { limit: 10 } },
    {
      action: "getIssue",
      query: {
        issue: other.issue,
        related: { limit: 10 },
        tasks: { page: { limit: 10 } },
      },
    },
    {
      action: "apply",
      issues: [other.issue],
      operations: [
        {
          op: "status",
          target: {
            issue: other.issue,
            task: {
              kind: "existing",
              id: "10000000-0000-4000-8000-000000000001",
            },
          },
          status: "doing",
        },
      ],
    },
  ]) {
    const details =
      args.action === "apply"
        ? saved
        : args.action === "getIssue"
          ? {
              outcome: {
                kind: "issue_detail",
                view: { issue: other.issue, detail: null, tasks: null },
              },
              output: "complete",
            }
          : {
              outcome: { kind: "missing_issue", issue: other.issue },
              output: "complete",
            }
    const ignored = taskNextHudFocus(args, details)
    assert.ok(Either.isRight(ignored) && Option.isNone(ignored.right))
    entries.push(
      assistant(call("incidental", args)),
      result("incidental", details),
    )
  }
  const restored = currentIssueFromEntries(entries)
  assert.ok(Either.isRight(restored))
  assert.deepEqual(restored.right, {
    kind: "issue",
    issue: native.issue,
    mode: "implementation",
  })
})

test("latest native request wins even when parallel results arrive out of order", async () => {
  const first = await nativeNextResult()
  const latest = await nativeNextResult(8)
  const restored = currentIssueFromEntries([
    assistant(call("first", first.args), call("latest", latest.args)),
    result("latest", latest.details),
    result("first", first.details),
  ])
  assert.ok(Either.isRight(restored))
  assert.deepEqual(restored.right, {
    kind: "issue",
    issue: latest.issue,
    mode: "implementation",
  })
})

test("uncompleted, partial or unknown next selection is never confirmed work", async () => {
  const native = await nativeNextResult()
  const pending = currentIssueFromEntries([
    assistant(call("pending", native.args)),
  ])
  assert.ok(Either.isRight(pending))
  assert.deepEqual(pending.right, { kind: "unconfirmed" })
  for (const kind of ["partial", "unknown"]) {
    const details = JSON.parse(JSON.stringify(native.details))
    details.outcome.result.receipt.kind = kind
    const projected = taskNextHudFocus(native.args, details)
    assert.ok(Either.isRight(projected) && Option.isSome(projected.right))
    assert.deepEqual(projected.right.value, { kind: "unconfirmed" })
  }
  const stopped = taskNextHudFocus(native.args, {
    outcome: {
      kind: "unconfirmed",
      stop: "interrupted",
      message: "Pickup outcome lost",
      invocation: { toolCallId: "pending", sessionId: "fixture-session" },
    },
    output: "complete",
  })
  assert.ok(Either.isRight(stopped) && Option.isSome(stopped.right))
  assert.deepEqual(stopped.right.value, { kind: "unconfirmed" })
})

test("scope, mode and malformed readback mismatches fail instead of choosing another issue", async () => {
  const native = await nativeNextResult()
  const malformed = JSON.parse(JSON.stringify(native.details))
  malformed.outcome.result.receipt.observed.status.optionId = "other-status"
  for (const [args, details] of [
    [
      {
        ...native.args,
        query: { ...native.args.query, repository: "other/repo" },
      },
      native.details,
    ],
    [
      { ...native.args, query: { ...native.args.query, mode: "review" } },
      native.details,
    ],
    [{ ...native.args, authority: "invented" }, native.details],
    [native.args, malformed],
    [
      native.args,
      { outcome: { kind: "issue_next", result: null }, output: "complete" },
    ],
  ]) {
    const projected = taskNextHudFocus(args, details)
    assert.ok(Either.isLeft(projected))
    assert.equal(projected.left.code, "invalid_state")
  }
})

test("restoration ignores unmatched tool results and does not revive a prior issue after a pending next", async () => {
  const native = await nativeNextResult()
  const other = await nativeNextResult(8)
  const unmatched = currentIssueFromEntries([
    result("unmatched", native.details),
  ])
  assert.ok(Either.isRight(unmatched))
  assert.deepEqual(unmatched.right, { kind: "none" })
  const pending = currentIssueFromEntries([
    assistant(call("prior", native.args)),
    result("prior", native.details),
    assistant(call("pending", other.args)),
    result("unmatched", native.details),
  ])
  assert.ok(Either.isRight(pending))
  assert.deepEqual(pending.right, { kind: "unconfirmed" })
})

test("ambiguous duplicate pending IDs cannot confirm a selection", async () => {
  const native = await nativeNextResult()
  const restored = currentIssueFromEntries([
    assistant(
      call("duplicate", native.args),
      call("duplicate", native.args),
      call("duplicate", native.args),
    ),
    result("duplicate", native.details),
  ])
  assert.ok(Either.isLeft(restored))
  assert.equal(restored.left.code, "invalid_state")
})

test("completed nonlatest calls do not remain pending when their ID is reused", async () => {
  const first = await nativeNextResult()
  const latest = await nativeNextResult(8)
  const restored = currentIssueFromEntries([
    assistant(call("first", first.args), call("latest", latest.args)),
    result("latest", latest.details),
    result("first", first.details),
    assistant(call("first", first.args)),
    result("first", first.details),
  ])
  assert.ok(Either.isRight(restored))
  assert.deepEqual(restored.right, {
    kind: "issue",
    issue: first.issue,
    mode: "implementation",
  })
})

test("no eligible selection clears focus and rendering-output fallback retains verified selection", async () => {
  const native = await nativeNextResult()
  const fallback = taskNextHudFocus(native.args, {
    ...native.details,
    output: "unavailable",
  })
  assert.ok(Either.isRight(fallback) && Option.isSome(fallback.right))
  assert.equal(fallback.right.value.kind, "issue")
  const details = JSON.parse(JSON.stringify(native.details))
  details.outcome.result = {
    kind: "none",
    observation: {
      ...details.outcome.result.observation,
      selection: { kind: "none", assessments: [] },
      selected: null,
    },
  }
  const none = taskNextHudFocus(native.args, details)
  assert.ok(Either.isRight(none) && Option.isSome(none.right))
  assert.deepEqual(none.right.value, { kind: "none" })
})
