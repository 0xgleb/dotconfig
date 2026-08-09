import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  decodeHarnessReviewHandoff,
  decodeHarnessReviewPayload,
  harnessHandoffAttemptMatch,
  requireHandoffMatchesAttempt,
  type HarnessHandoffAttemptMatch,
  type HarnessHandoffMismatch,
  type HarnessReviewHandoff,
  type HarnessReviewPayload,
} from "./harness-protocol.ts"
import { canonicalPath, type CanonicalPath } from "./review-duty-profile.ts"

const headSha = "a".repeat(40)

const canonical = (value: string): CanonicalPath => {
  const path = canonicalPath(value)
  if (path === undefined) throw new Error(`fixture is not canonical: ${value}`)
  return path
}

const home = canonical("/Users/example")

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

const automaticPayload: HarnessReviewPayload = {
  lane: "claude-code-max",
  task: "review-loop",
  profile: "personal-review",
  repository: "0xgleb/dotconfig",
  pullRequest: 56,
  kind: "auto",
  inputHeadSha: headSha,
  repositoryRoot: "/Users/example/.config",
  isolation: "approved-worktree",
}

const rainlanguagePayload: HarnessReviewPayload = {
  lane: "cursor-subscription",
  task: "review-probe",
  model: "composer-2.5",
  profile: "st0x-review",
  repository: "rainlanguage/rain.orderbook",
  pullRequest: 12,
  kind: "assigned",
  inputHeadSha: headSha,
  repositoryRoot: "/Users/example/code/rainlanguage/rain.orderbook",
  isolation: "read-only",
}

const decoded = (value: unknown): HarnessReviewPayload =>
  Effect.runSync(decodeHarnessReviewPayload(value, home))

const errorCode = (value: unknown): string | undefined => {
  const result = Effect.runSync(
    Effect.either(decodeHarnessReviewPayload(value, home)),
  )
  if (Either.isRight(result)) return undefined
  return result.left.code
}

test("registered harness review payloads decode exactly", () => {
  assert.deepEqual(decoded(claudePayload), claudePayload)
  assert.deepEqual(decoded(cursorPayload), cursorPayload)
  const worktreeRoot =
    "/Users/example/code/st0x/example/.worktrees/feat/harness"
  assert.deepEqual(decoded({ ...claudePayload, repositoryRoot: worktreeRoot }), {
    ...claudePayload,
    repositoryRoot: worktreeRoot,
  })
})

test("st0x review duty reaches the rainlanguage checkout workspace", () => {
  assert.deepEqual(decoded(rainlanguagePayload), rainlanguagePayload)
  const worktreeRoot = `${rainlanguagePayload.repositoryRoot}/.worktrees/feat/probe`
  assert.deepEqual(
    decoded({ ...rainlanguagePayload, repositoryRoot: worktreeRoot }),
    { ...rainlanguagePayload, repositoryRoot: worktreeRoot },
  )
  assert.equal(
    errorCode({
      ...rainlanguagePayload,
      repositoryRoot: "/Users/example/code/rainlanguage/other",
    }),
    "invalid_input",
  )
})

test("automatic review decodes for its registered repository and checkout", () => {
  assert.deepEqual(decoded(automaticPayload), automaticPayload)
  const worktreeRoot = "/Users/example/.config/.worktrees/feat/harness"
  assert.deepEqual(
    decoded({ ...automaticPayload, repositoryRoot: worktreeRoot }),
    { ...automaticPayload, repositoryRoot: worktreeRoot },
  )
  assert.equal(
    errorCode({ ...automaticPayload, repositoryRoot: "/Users/example/dotconfig" }),
    "invalid_input",
  )
  assert.equal(
    errorCode({ ...automaticPayload, repository: "0xgleb/example" }),
    "invalid_input",
  )
})

test("repository roots bind to the registered checkout, not to a matching name", () => {
  for (const root of [
    "/tmp/anything/example",
    "/Users/attacker/example",
    "/Users/example/code/attacker/example",
    "/Users/example/code/0xgleb/example/.worktrees",
  ])
    assert.equal(
      errorCode({ ...cursorPayload, repositoryRoot: root }),
      "invalid_input",
    )
})

test("repository roots anchor at the home directory, not at a matching suffix", () => {
  for (const root of [
    "/tmp/attacker/code/0xgleb/example",
    "/Users/mallory/x/code/0xgleb/example",
    "/Users/example/decoy/code/0xgleb/example",
    "/Users/example/code/0xgleb/example/decoy/code/0xgleb/example",
  ])
    assert.equal(
      errorCode({ ...cursorPayload, repositoryRoot: root }),
      "invalid_input",
    )
  for (const root of [
    "/tmp/attacker/.config",
    "/Users/mallory/.config",
    "/Users/example/decoy/.config",
  ])
    assert.equal(
      errorCode({ ...automaticPayload, repositoryRoot: root }),
      "invalid_input",
    )
})

test("repository roots must be in canonical form", () => {
  for (const root of [
    "/Users/example/code/0xgleb/example/",
    "/Users/example/code/0xgleb/./example",
    "/Users/example/code//0xgleb/example",
    "/Users/example/code/0xgleb/example/.worktrees/feat/harness/",
  ])
    assert.equal(
      errorCode({ ...cursorPayload, repositoryRoot: root }),
      "invalid_input",
    )
})

test("repository roots carrying control characters never decode", () => {
  for (const control of [0, 1, 10, 27, 127])
    assert.equal(
      errorCode({
        ...cursorPayload,
        repositoryRoot: `/Users/example${String.fromCharCode(control)}/code/0xgleb/example`,
      }),
      "invalid_input",
    )
})

test("head SHAs must be exactly a SHA-1 or SHA-256 commit identifier", () => {
  const sha256Payload = { ...cursorPayload, inputHeadSha: "b".repeat(64) }
  assert.deepEqual(decoded(sha256Payload), sha256Payload)
  for (const length of [39, 41, 50, 63, 65])
    assert.equal(
      errorCode({ ...cursorPayload, inputHeadSha: "b".repeat(length) }),
      "invalid_input",
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
    { ...cursorPayload, repositoryRoot: "/" },
    { ...cursorPayload, repositoryRoot: "/etc" },
    { ...cursorPayload, repositoryRoot: "/Users/example/.ssh" },
    { ...cursorPayload, repositoryRoot: "/Users/example/.gnupg/example" },
    { ...cursorPayload, repositoryRoot: "/Users/example/.aws/example" },
    { ...cursorPayload, repositoryRoot: "/Users/example/code/0xgleb/.env" },
    { ...cursorPayload, repositoryRoot: "/Users/example/code/0xgleb/other" },
    { ...claudePayload, repositoryRoot: "/Users/example/code/st0x" },
    { ...cursorPayload, inputHeadSha: "A".repeat(40) },
    { ...cursorPayload, pullRequest: 0 },
    { ...cursorPayload, profile: "dataclique-review" },
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
  const result = Effect.runSync(Effect.either(decodeHarnessReviewHandoff(value)))
  if (Either.isRight(result)) return undefined
  return result.left.code
}

const matched: HarnessHandoffAttemptMatch = { outcome: "matched" }

const mismatched = (
  mismatch: HarnessHandoffMismatch,
): HarnessHandoffAttemptMatch => ({ outcome: "mismatched", mismatch })

test("bounded versioned harness handoffs decode and match the live attempt", () => {
  assert.deepEqual(Effect.runSync(decodeHarnessReviewHandoff(handoff)), handoff)
  assert.deepEqual(
    harnessHandoffAttemptMatch(handoff, claudePayload, "job-a", 1),
    matched,
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(
      { ...handoff, inputHeadSha: "b".repeat(40) },
      claudePayload,
      "job-a",
      1,
    ),
    mismatched("input-head"),
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(handoff, claudePayload, "job-b", 1),
    mismatched("job-id"),
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(handoff, claudePayload, "job-a", 2),
    mismatched("attempt"),
  )
  const cursorHandoff: HarnessReviewHandoff = {
    ...handoff,
    lane: "cursor-subscription",
    repository: cursorPayload.repository,
    pullRequest: cursorPayload.pullRequest,
    inputHeadSha: cursorPayload.inputHeadSha,
    outputHeadSha: cursorPayload.inputHeadSha,
  }
  assert.deepEqual(
    harnessHandoffAttemptMatch(cursorHandoff, cursorPayload, "job-a", 1),
    matched,
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(
      { ...cursorHandoff, lane: "claude-code-max" },
      cursorPayload,
      "job-a",
      1,
    ),
    mismatched("lane"),
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(
      { ...cursorHandoff, status: "findings_fixed" },
      cursorPayload,
      "job-a",
      1,
    ),
    mismatched("read-only-mutation"),
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(
      { ...cursorHandoff, verifier: "unavailable" },
      cursorPayload,
      "job-a",
      1,
    ),
    mismatched("unverified"),
  )
})

test("approved-worktree work hands back a fixed head under the same attempt", () => {
  const fixedHeadSha = "c".repeat(40)
  const fixed: HarnessReviewHandoff = {
    ...handoff,
    jobId: "job-auto",
    repository: automaticPayload.repository,
    pullRequest: automaticPayload.pullRequest,
    inputHeadSha: automaticPayload.inputHeadSha,
    outputHeadSha: fixedHeadSha,
    status: "findings_fixed",
    assessment: "Fixed two verified findings.",
    evidence: [
      `head:${automaticPayload.inputHeadSha}`,
      `commit:${fixedHeadSha}`,
      "check:review-core",
    ],
  }
  assert.deepEqual(Effect.runSync(decodeHarnessReviewHandoff(fixed)), fixed)
  assert.deepEqual(
    harnessHandoffAttemptMatch(fixed, automaticPayload, "job-auto", 1),
    matched,
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(
      { ...fixed, repository: "0xgleb/example" },
      automaticPayload,
      "job-auto",
      1,
    ),
    mismatched("repository"),
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(fixed, automaticPayload, "job-auto", 2),
    mismatched("attempt"),
  )
})

test("fixed findings require a head the review actually moved", () => {
  const unchanged: HarnessReviewHandoff = {
    ...handoff,
    jobId: "job-auto",
    repository: automaticPayload.repository,
    pullRequest: automaticPayload.pullRequest,
    status: "findings_fixed",
    evidence: [
      `head:${automaticPayload.inputHeadSha}`,
      `commit:${automaticPayload.inputHeadSha}`,
    ],
  }
  assert.deepEqual(
    harnessHandoffAttemptMatch(unchanged, automaticPayload, "job-auto", 1),
    mismatched("unchanged-head"),
  )
})

test("a rejected handoff names the invariant it violated", () => {
  const result = Effect.runSync(
    Effect.either(
      requireHandoffMatchesAttempt(handoff, claudePayload, "job-b", 1),
    ),
  )
  assert.equal(Either.isLeft(result), true)
  if (Either.isLeft(result)) {
    assert.equal(result.left.code, "invalid_input")
    assert.equal(result.left.message.includes("job identifier"), true)
  }
  assert.equal(
    Effect.runSync(
      Effect.either(
        requireHandoffMatchesAttempt(handoff, claudePayload, "job-a", 1),
      ),
    )._tag,
    "Right",
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

test("a claimed Fable verification must carry evidence identifiers", () => {
  assert.equal(
    handoffErrorCode({
      ...handoff,
      status: "blocked",
      verifier: "fable-clean",
      evidence: [],
    }),
    "invalid_input",
  )
})

test("a fixed handoff must cite the commit it produced", () => {
  const fixedHeadSha = "c".repeat(40)
  assert.equal(
    handoffErrorCode({
      ...handoff,
      outputHeadSha: fixedHeadSha,
      status: "findings_fixed",
      evidence: [`head:${handoff.inputHeadSha}`],
    }),
    "invalid_input",
  )
  assert.equal(
    handoffErrorCode({
      ...handoff,
      outputHeadSha: fixedHeadSha,
      status: "findings_fixed",
      evidence: [`commit:${handoff.inputHeadSha}`],
    }),
    "invalid_input",
  )
})

test("handoffs reject prompt, reasoning, raw logs, and malformed evidence", () => {
  for (const malformed of [
    { ...handoff, protocolVersion: 2 },
    { ...handoff, assessment: "x".repeat(501) },
    { ...handoff, assessment: "line one\nline two" },
    { ...handoff, evidence: Array.from({ length: 17 }, (_, index) => `check:${index}`) },
    { ...handoff, evidence: [] },
    { ...handoff, status: "findings_fixed", evidence: [] },
    { ...handoff, status: "findings_pending", evidence: [] },
    { ...handoff, evidence: ["raw model prose with spaces"] },
    { ...handoff, evidence: ["path:/Users/example/.env"] },
    { ...handoff, evidence: ["check:Users/example/.ssh/id_ed25519"] },
    { ...handoff, reasoning: "hidden chain of thought" },
    { ...handoff, prompt: "stored prompt" },
    { ...handoff, logs: "raw executor output" },
    { ...handoff, executorProvenance: "api-key" },
  ])
    assert.equal(handoffErrorCode(malformed), "invalid_input")
})

test("handoff evidence never names a credential-bearing path", () => {
  for (const evidence of [
    ["check:Users/example/.ssh/id_ed25519"],
    ["check:home/.env.production"],
    ["review:Users/0xgleb/.aws/credentials"],
    ["test:home/.gnupg/secring"],
    ["check:review-core", "commit:home/.env"],
  ])
    assert.equal(handoffErrorCode({ ...handoff, evidence }), "invalid_input")
})

test("only fixed findings hand back a head the review moved", () => {
  const movedHead = "d".repeat(40)
  for (const status of ["clean", "findings_pending", "blocked", "failed"] as const)
    assert.deepEqual(
      harnessHandoffAttemptMatch(
        {
          ...handoff,
          jobId: "job-auto",
          repository: automaticPayload.repository,
          pullRequest: automaticPayload.pullRequest,
          outputHeadSha: movedHead,
          status,
        },
        automaticPayload,
        "job-auto",
        1,
      ),
      mismatched("moved-head"),
    )
})

test("a verified terminal status requires a clean Fable verification", () => {
  const fixedHeadSha = "c".repeat(40)
  const worktreeHandoff: HarnessReviewHandoff = {
    ...handoff,
    jobId: "job-auto",
    repository: automaticPayload.repository,
    pullRequest: automaticPayload.pullRequest,
  }
  for (const verifier of [
    "fable-rejected",
    "not-applicable",
    "unavailable",
  ] as const) {
    for (const status of ["clean", "findings_pending"] as const)
      assert.deepEqual(
        harnessHandoffAttemptMatch(
          { ...worktreeHandoff, status, verifier },
          automaticPayload,
          "job-auto",
          1,
        ),
        mismatched("unverified"),
      )
    assert.deepEqual(
      harnessHandoffAttemptMatch(
        {
          ...worktreeHandoff,
          status: "findings_fixed",
          outputHeadSha: fixedHeadSha,
          evidence: [`commit:${fixedHeadSha}`],
          verifier,
        },
        automaticPayload,
        "job-auto",
        1,
      ),
      mismatched("unverified"),
    )
    for (const status of ["blocked", "failed"] as const)
      assert.deepEqual(
        harnessHandoffAttemptMatch(
          { ...worktreeHandoff, status, verifier },
          automaticPayload,
          "job-auto",
          1,
        ),
        matched,
      )
  }
})

test("a disputed handoff decodes and stays unverified", () => {
  const disputed: HarnessReviewHandoff = {
    ...handoff,
    verifier: "fable-rejected",
  }
  assert.deepEqual(
    Effect.runSync(decodeHarnessReviewHandoff(disputed)),
    disputed,
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(disputed, claudePayload, "job-a", 1),
    mismatched("unverified"),
  )
})
