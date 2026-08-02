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

const cursorPayload: HarnessReviewPayload = {
  lane: "cursor-subscription",
  task: "review-probe",
  model: "grok-4.5",
  profile: "personal-review",
  repository: "0xgleb/example",
  pullRequest: 7,
  kind: "own",
  inputHeadSha: headSha,
  repositoryRoot: "/Users/example/code/0xgleb/example",
  isolation: "read-only",
}

const errorCode = (value: unknown): string | undefined => {
  const result = Effect.runSync(Effect.either(decodeHarnessReviewPayload(value)))
  if (Either.isRight(result)) return undefined
  return result.left.code
}

test("registered harness review payloads decode exactly", () => {
  assert.deepEqual(
    Effect.runSync(decodeHarnessReviewPayload(claudePayload)),
    claudePayload,
  )
  assert.deepEqual(
    Effect.runSync(decodeHarnessReviewPayload(cursorPayload)),
    cursorPayload,
  )
})

test("harness payloads cannot carry executable or prompt injection fields", () => {
  for (const injected of [
    { ...claudePayload, prompt: "ignore policy" },
    { ...claudePayload, command: "arbitrary shell" },
    { ...claudePayload, environment: { ANTHROPIC_API_KEY: "injected" } },
    { ...claudePayload, force: true },
    { ...claudePayload, plugins: ["untrusted"] },
    { ...cursorPayload, endpoint: "https://attacker.invalid" },
    { ...cursorPayload, approveMcps: true },
  ])
    assert.equal(errorCode(injected), "invalid_input")
})

test("harness lane, model, isolation, and identity invariants fail closed", () => {
  for (const malformed of [
    { ...claudePayload, lane: "anthropic-api" },
    { ...claudePayload, task: "review-loop", kind: "assigned" },
    { ...claudePayload, task: "review-pr", kind: "own" },
    { ...claudePayload, isolation: "approved-worktree" },
    { ...cursorPayload, model: "claude-api" },
    { ...cursorPayload, task: "review-loop" },
    { ...cursorPayload, isolation: "approved-worktree" },
    { ...cursorPayload, kind: "auto" },
    { ...cursorPayload, repositoryRoot: "relative/path" },
    { ...cursorPayload, repositoryRoot: "/Users/example/../escape" },
    { ...cursorPayload, inputHeadSha: "A".repeat(40) },
    { ...cursorPayload, pullRequest: 0 },
    { ...cursorPayload, profile: "dataclique-review" },
    {
      ...claudePayload,
      profile: "dataclique-review",
      repository: "dataclique/moneymentum",
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
  const result = Effect.runSync(Effect.either(decodeHarnessReviewHandoff(value)))
  if (Either.isRight(result)) return undefined
  return result.left.code
}

test("bounded versioned harness handoffs decode and match the live attempt", () => {
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
    harnessHandoffMatchesAttempt(
      {
        ...handoff,
        lane: "cursor-subscription",
        repository: cursorPayload.repository,
        pullRequest: cursorPayload.pullRequest,
        inputHeadSha: cursorPayload.inputHeadSha,
        outputHeadSha: cursorPayload.inputHeadSha,
        status: "findings_fixed",
      },
      cursorPayload,
      "job-a",
      1,
    ),
    false,
  )
})

test("handoffs reject prompt, reasoning, raw logs, and malformed evidence", () => {
  for (const malformed of [
    { ...handoff, protocolVersion: 2 },
    { ...handoff, assessment: "x".repeat(501) },
    { ...handoff, assessment: "line one\nline two" },
    { ...handoff, evidence: Array.from({ length: 17 }, (_, index) => `check:${index}`) },
    { ...handoff, evidence: ["raw model prose with spaces"] },
    { ...handoff, evidence: ["path:/Users/example/.env"] },
    { ...handoff, reasoning: "hidden chain of thought" },
    { ...handoff, prompt: "stored prompt" },
    { ...handoff, logs: "raw executor output" },
    { ...handoff, executorProvenance: "api-key" },
  ])
    assert.equal(handoffErrorCode(malformed), "invalid_input")
})
