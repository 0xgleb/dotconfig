import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  decodeHarnessReviewHandoff,
  decodeHarnessReviewPayload,
  harnessHandoffAttemptMatch,
  isCredentialBearingPath,
  requireHandoffMatchesAttempt,
  toCommitSha,
  toJobId,
  type CommitSha,
  type HarnessHandoffAttemptMatch,
  type HarnessHandoffMismatch,
  type HarnessReviewHandoff,
  type HarnessReviewPayload,
  type JobId,
} from "./harness-protocol.ts"
import { canonicalPath, type CanonicalPath } from "./review-duty-profile.ts"

const canonical = (value: string): CanonicalPath => {
  const path = canonicalPath(value)
  if (path === undefined) throw new Error(`fixture is not canonical: ${value}`)
  return path
}

const commit = (value: string): CommitSha => {
  const sha = toCommitSha(value)
  if (sha === undefined) throw new Error(`fixture is not a commit sha: ${value}`)
  return sha
}

const job = (value: string): JobId => {
  const id = toJobId(value)
  if (id === undefined)
    throw new Error(`fixture is not a job identifier: ${value}`)
  return id
}

const headSha = commit("a".repeat(40))
const jobA = job("job-a")
const jobB = job("job-b")
const jobAuto = job("job-auto")

const home = canonical("/Users/example")

const claudePayload: HarnessReviewPayload = {
  lane: "claude-code-max",
  task: "review-pr",
  profile: "st0x-review",
  repository: "st0x-technology/example",
  pullRequest: 42,
  kind: "assigned",
  inputHeadSha: headSha,
  repositoryRoot: canonical("/Users/example/code/st0x/example"),
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
  repositoryRoot: canonical("/Users/example/code/0xgleb/example"),
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
  repositoryRoot: canonical("/Users/example/.config"),
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
  repositoryRoot: canonical("/Users/example/code/rainlanguage/rain.orderbook"),
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

test("a repository binds to its own organisation's workspace, never another's", () => {
  for (const root of [
    "/Users/example/code/rainlanguage/example",
    "/Users/example/code/rainlanguage/example/.worktrees/feat/harness",
  ])
    assert.equal(
      errorCode({ ...claudePayload, repositoryRoot: root }),
      "invalid_input",
    )
  for (const root of [
    "/Users/example/code/st0x/rain.orderbook",
    "/Users/example/code/st0x/rain.orderbook/.worktrees/feat/probe",
  ])
    assert.equal(
      errorCode({ ...rainlanguagePayload, repositoryRoot: root }),
      "invalid_input",
    )
})

test("a repository name shared across organisations keeps its own checkout", () => {
  const sharedName: HarnessReviewPayload = {
    ...rainlanguagePayload,
    repository: "rainlanguage/example",
    repositoryRoot: canonical("/Users/example/code/rainlanguage/example"),
  }
  assert.deepEqual(decoded(sharedName), sharedName)
  assert.deepEqual(decoded(claudePayload), claudePayload)
  assert.equal(
    errorCode({
      ...sharedName,
      repositoryRoot: "/Users/example/code/st0x/example",
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

test("credential path segments are recognised whatever their case", () => {
  for (const path of [
    "/Users/example/.ssh/id_ed25519",
    "/Users/example/.SSH/id_ed25519",
    "/Users/example/.Ssh/id_ed25519",
    "/Users/example/.gnupg/secring",
    "/Users/example/.GnuPG/secring",
    "/Users/example/.aws/credentials",
    "/Users/example/.AWS/credentials",
    "/Users/example/code/.env",
    "/Users/example/code/.ENV.production",
    "/Users/example/code/.Env.local",
  ])
    assert.equal(isCredentialBearingPath(path), true)
  for (const path of [
    "/Users/example/code/st0x/example",
    "/Users/example/code/0xgleb/environment",
    "/Users/example/.config",
  ])
    assert.equal(isCredentialBearingPath(path), false)
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
  jobId: jobA,
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

const matched: HarnessHandoffAttemptMatch = { outcome: "matched" }

const mismatched = (
  mismatch: HarnessHandoffMismatch,
): HarnessHandoffAttemptMatch => ({ outcome: "mismatched", mismatch })

test("bounded versioned harness handoffs decode and match the live attempt", () => {
  assert.deepEqual(Effect.runSync(decodeHarnessReviewHandoff(handoff)), handoff)
  assert.deepEqual(
    harnessHandoffAttemptMatch(handoff, claudePayload, jobA, 1),
    matched,
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(
      { ...handoff, inputHeadSha: commit("b".repeat(40)) },
      claudePayload,
      jobA,
      1,
    ),
    mismatched("input-head"),
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(handoff, claudePayload, jobB, 1),
    mismatched("job-id"),
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(handoff, claudePayload, jobA, 2),
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
    harnessHandoffAttemptMatch(cursorHandoff, cursorPayload, jobA, 1),
    matched,
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(
      { ...cursorHandoff, lane: "claude-code-max" },
      cursorPayload,
      jobA,
      1,
    ),
    mismatched("lane"),
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(
      { ...cursorHandoff, status: "findings_fixed" },
      cursorPayload,
      jobA,
      1,
    ),
    mismatched("read-only-mutation"),
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(
      { ...cursorHandoff, verifier: "unavailable" },
      cursorPayload,
      jobA,
      1,
    ),
    mismatched("unverified"),
  )
})

test("approved-worktree work hands back a fixed head under the same attempt", () => {
  const fixedHeadSha = commit("c".repeat(40))
  const fixed: HarnessReviewHandoff = {
    ...handoff,
    jobId: jobAuto,
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
    harnessHandoffAttemptMatch(fixed, automaticPayload, jobAuto, 1),
    matched,
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(
      { ...fixed, repository: "0xgleb/example" },
      automaticPayload,
      jobAuto,
      1,
    ),
    mismatched("repository"),
  )
  assert.deepEqual(
    harnessHandoffAttemptMatch(fixed, automaticPayload, jobAuto, 2),
    mismatched("attempt"),
  )
})

test("fixed findings require a head the review actually moved", () => {
  const unchanged: HarnessReviewHandoff = {
    ...handoff,
    jobId: jobAuto,
    repository: automaticPayload.repository,
    pullRequest: automaticPayload.pullRequest,
    status: "findings_fixed",
    evidence: [
      `head:${automaticPayload.inputHeadSha}`,
      `commit:${automaticPayload.inputHeadSha}`,
    ],
  }
  assert.deepEqual(
    harnessHandoffAttemptMatch(unchanged, automaticPayload, jobAuto, 1),
    mismatched("unchanged-head"),
  )
})

test("a rejected handoff names the invariant it violated", () => {
  const result = Effect.runSync(
    Effect.either(requireHandoffMatchesAttempt(handoff, claudePayload, jobB, 1)),
  )
  assert.equal(Either.isLeft(result), true)
  if (Either.isLeft(result)) {
    assert.equal(result.left.code, "invalid_input")
    assert.equal(result.left.message.includes("job identifier"), true)
  }
  assert.equal(
    Effect.runSync(
      Effect.either(
        requireHandoffMatchesAttempt(handoff, claudePayload, jobA, 1),
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
    { ...handoff, jobId: "job with spaces" },
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
    ["check:Users/example/.SSH/id_ed25519"],
    ["check:Users/example/.Ssh/id_ed25519"],
    ["check:home/.env.production"],
    ["check:home/.ENV.production"],
    ["review:Users/0xgleb/.aws/credentials"],
    ["review:Users/0xgleb/.AWS/credentials"],
    ["test:home/.gnupg/secring"],
    ["test:home/.GnuPG/secring"],
    ["check:review-core", "commit:home/.env"],
  ])
    assert.equal(handoffErrorCode({ ...handoff, evidence }), "invalid_input")
})

test("only fixed findings hand back a head the review moved", () => {
  const movedHead = commit("d".repeat(40))
  for (const status of ["clean", "findings_pending", "blocked", "failed"] as const)
    assert.deepEqual(
      harnessHandoffAttemptMatch(
        {
          ...handoff,
          jobId: jobAuto,
          repository: automaticPayload.repository,
          pullRequest: automaticPayload.pullRequest,
          outputHeadSha: movedHead,
          status,
        },
        automaticPayload,
        jobAuto,
        1,
      ),
      mismatched("moved-head"),
    )
})

test("a verified terminal status requires a clean Fable verification", () => {
  const fixedHeadSha = commit("c".repeat(40))
  const worktreeHandoff: HarnessReviewHandoff = {
    ...handoff,
    jobId: jobAuto,
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
          jobAuto,
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
        jobAuto,
        1,
      ),
      mismatched("unverified"),
    )
    for (const status of ["blocked", "failed"] as const)
      assert.deepEqual(
        harnessHandoffAttemptMatch(
          { ...worktreeHandoff, status, verifier },
          automaticPayload,
          jobAuto,
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
    harnessHandoffAttemptMatch(disputed, claudePayload, jobA, 1),
    mismatched("unverified"),
  )
})
