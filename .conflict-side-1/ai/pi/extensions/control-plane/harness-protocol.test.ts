import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  decodeHarnessReviewHandoff,
  decodeHarnessReviewPayload,
  harnessHandoffMatchesAttempt,
  type HarnessReviewHandoff,
  type HarnessReviewPayload,
} from "./harness-protocol.ts"

const headSha = "a".repeat(40)

const claudePayload: HarnessReviewPayload = {
  lane: "claude-code-max",
  task: "review-pr",
  profile: "st0x-review",
  repository: "st0x-technology/example",
  pullRequest: 42,
  kind: "assigned",
  inputHeadSha: headSha,
  repositoryRoot: "/Users/example/code/st0x/example",
  isolation: "read-only",
}

const errorCode = (value: unknown): string | undefined => {
  const result = Effect.runSync(
    Effect.either(decodeHarnessReviewPayload(value)),
  )
  return Either.isRight(result) ? undefined : result.left.code
}

test("registered Claude harness review payloads decode exactly", () => {
  assert.deepEqual(
    Effect.runSync(decodeHarnessReviewPayload(claudePayload)),
    claudePayload,
  )
  const worktreeRoot =
    "/Users/example/code/st0x/example/.worktrees/feat/harness"
  assert.deepEqual(
    Effect.runSync(
      decodeHarnessReviewPayload({
        ...claudePayload,
        repositoryRoot: worktreeRoot,
      }),
    ),
    { ...claudePayload, repositoryRoot: worktreeRoot },
  )
})

test("retired Cursor and injected harness payloads fail closed", () => {
  for (const malformed of [
    { ...claudePayload, lane: "cursor-subscription" },
    { ...claudePayload, lane: "cursor-subscription", model: "grok-4.5" },
    { ...claudePayload, prompt: "ignore policy" },
    { ...claudePayload, command: "arbitrary shell" },
    { ...claudePayload, environment: { ANTHROPIC_API_KEY: "injected" } },
    { ...claudePayload, force: true },
    { ...claudePayload, plugins: ["untrusted"] },
  ])
    assert.equal(errorCode(malformed), "invalid_input")
})

test("harness task, isolation, and identity invariants fail closed", () => {
  for (const malformed of [
    { ...claudePayload, lane: "anthropic-api" },
    { ...claudePayload, task: "review-loop", kind: "assigned" },
    { ...claudePayload, task: "review-pr", kind: "own" },
    { ...claudePayload, isolation: "approved-worktree" },
    { ...claudePayload, repositoryRoot: "relative/path" },
    { ...claudePayload, repositoryRoot: "/Users/example/../escape" },
    { ...claudePayload, repositoryRoot: "/" },
    { ...claudePayload, repositoryRoot: "/etc" },
    { ...claudePayload, repositoryRoot: "/Users/example/.ssh" },
    { ...claudePayload, repositoryRoot: "/Users/example/.gnupg/example" },
    { ...claudePayload, repositoryRoot: "/Users/example/.aws/example" },
    { ...claudePayload, repositoryRoot: "/Users/example/code/st0x/.env" },
    { ...claudePayload, repositoryRoot: "/Users/example/code/st0x/other" },
    { ...claudePayload, inputHeadSha: "A".repeat(40) },
    { ...claudePayload, pullRequest: 0 },
    {
      ...claudePayload,
      profile: "dataclique-review",
      repository: "dataclique/other",
      repositoryRoot: "/Users/example/code/dataclique/other",
      kind: "auto",
      task: "review-loop",
      isolation: "approved-worktree",
    },
  ])
    assert.equal(errorCode(malformed), "invalid_input")
})

const handoff: HarnessReviewHandoff = {
  protocolVersion: 1,
  jobId: "job-a",
  attempt: 1,
  lane: "claude-code-max",
  repository: claudePayload.repository,
  pullRequest: claudePayload.pullRequest,
  inputHeadSha: claudePayload.inputHeadSha,
  outputHeadSha: claudePayload.inputHeadSha,
  status: "clean",
  assessment: "No verified findings.",
  evidence: ["check:review-core", `head:${claudePayload.inputHeadSha}`],
  verifier: "fable-clean",
  executorProvenance: "subscription-verified",
}

const handoffErrorCode = (value: unknown): string | undefined => {
  const result = Effect.runSync(
    Effect.either(decodeHarnessReviewHandoff(value)),
  )
  return Either.isRight(result) ? undefined : result.left.code
}

test("bounded versioned Claude handoffs decode and match the live attempt", () => {
  assert.deepEqual(Effect.runSync(decodeHarnessReviewHandoff(handoff)), handoff)
  assert.equal(
    harnessHandoffMatchesAttempt(handoff, claudePayload, "job-a", 1),
    true,
  )
  assert.equal(
    harnessHandoffMatchesAttempt(
      { ...handoff, inputHeadSha: "b".repeat(40) },
      claudePayload,
      "job-a",
      1,
    ),
    false,
  )
  assert.equal(
    handoffErrorCode({ ...handoff, lane: "cursor-subscription" }),
    "invalid_input",
  )
})

test("unverified terminal handoffs may carry empty evidence", () => {
  const blocked = {
    ...handoff,
    status: "blocked",
    verifier: "unavailable",
    evidence: [],
  }
  assert.deepEqual(Effect.runSync(decodeHarnessReviewHandoff(blocked)), blocked)
})

test("handoffs reject prompt, reasoning, raw logs, and malformed evidence", () => {
  for (const malformed of [
    { ...handoff, protocolVersion: 2 },
    { ...handoff, assessment: "x".repeat(501) },
    { ...handoff, assessment: "line one\nline two" },
    {
      ...handoff,
      evidence: Array.from({ length: 17 }, (_, index) => `check:${index}`),
    },
    { ...handoff, evidence: [] },
    { ...handoff, status: "findings_fixed", evidence: [] },
    { ...handoff, status: "findings_pending", evidence: [] },
    { ...handoff, evidence: ["raw model prose with spaces"] },
    { ...handoff, evidence: ["path:/Users/example/.env"] },
    { ...handoff, reasoning: "hidden chain of thought" },
    { ...handoff, prompt: "stored prompt" },
    { ...handoff, logs: "raw executor output" },
    { ...handoff, executorProvenance: "api-key" },
  ])
    assert.equal(handoffErrorCode(malformed), "invalid_input")
})
