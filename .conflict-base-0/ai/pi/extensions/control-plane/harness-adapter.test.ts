import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  buildHarnessLaunchPlan,
  type HarnessLaunchPlan,
} from "./harness-adapter.ts"
import type { HarnessReviewPayload } from "./harness-protocol.ts"

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

const plan = (
  payload: unknown,
  jobId = "job-a",
  attempt = 1,
): HarnessLaunchPlan =>
  Effect.runSync(buildHarnessLaunchPlan(payload, jobId, attempt))

const planErrorCode = (
  payload: unknown,
  jobId = "job-a",
  attempt = 1,
): string | undefined => {
  const result = Effect.runSync(
    Effect.either(buildHarnessLaunchPlan(payload, jobId, attempt)),
  )
  if (Either.isRight(result)) return undefined
  return result.left.code
}

const FORBIDDEN_ARGUMENTS = [
  "--api-key",
  "--endpoint",
  "--base-url",
  "--force",
  "--yolo",
  "--dangerously-skip-permissions",
  "--plugin",
  "--mcp",
  "--continue",
  "--resume",
] as const

test("the claude lane builds exact source-fixed subscription argv", () => {
  const launch = plan(claudePayload)
  assert.equal(launch.lane, "claude-code-max")
  assert.equal(launch.cwd, claudePayload.repositoryRoot)
  assert.deepEqual(launch.scrubbedEnvironment, [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_BEARER_TOKEN_BEDROCK",
  ])
  const scrubbed = launch.scrubbedEnvironment.flatMap((name) => ["-u", name])
  assert.deepEqual(launch.argv.slice(0, 1 + scrubbed.length), [
    "env",
    ...scrubbed,
  ])
  assert.deepEqual(
    launch.argv.slice(1 + scrubbed.length, launch.argv.length - 1),
    ["jf", "clanker", "--claude", "--new"],
  )
  const prompt = launch.argv.at(-1) ?? ""
  assert.equal(prompt.includes("st0x-technology/example#42"), true)
  assert.equal(prompt.includes(headSha), true)
  assert.equal(prompt.includes("review-pr"), true)
  assert.equal(prompt.includes("job-a"), true)
  assert.equal(prompt.includes("attempt 1"), true)
})

test("claude own-review work runs review-loop in approved-worktree isolation", () => {
  const launch = plan({
    ...claudePayload,
    task: "review-loop",
    kind: "own",
    isolation: "approved-worktree",
  })
  const prompt = launch.argv.at(-1) ?? ""
  assert.equal(prompt.includes("review-loop"), true)
  assert.equal(prompt.includes("approved-worktree"), true)
})

test("the cursor lane builds an exact read-only plan-mode probe", () => {
  const launch = plan(cursorPayload, "job-b", 2)
  assert.equal(launch.lane, "cursor-subscription")
  assert.equal(launch.cwd, cursorPayload.repositoryRoot)
  assert.deepEqual(launch.scrubbedEnvironment, ["CURSOR_API_KEY"])
  assert.deepEqual(launch.argv.slice(0, launch.argv.length - 1), [
    "env",
    "-u",
    "CURSOR_API_KEY",
    "cursor-agent",
    "-p",
    "--mode",
    "plan",
    "--model",
    "grok-4.5-xhigh",
    "--trust",
    "--workspace",
    cursorPayload.repositoryRoot,
  ])
  const prompt = launch.argv.at(-1) ?? ""
  assert.equal(prompt.includes("0xgleb/example#7"), true)
  assert.equal(prompt.includes("job-b"), true)
  assert.equal(prompt.includes("attempt 2"), true)
})

test("cursor models map only to registered subscription identifiers", () => {
  const launch = plan({ ...cursorPayload, model: "composer-2.5" })
  assert.equal(launch.argv.includes("composer-2.5"), true)
  assert.equal(planErrorCode({ ...cursorPayload, model: "auto" }), "invalid_input")
  assert.equal(
    planErrorCode({ ...cursorPayload, model: "claude-api" }),
    "invalid_input",
  )
})

test("unknown lanes, task families, and free-form fields never launch", () => {
  for (const malformed of [
    { ...claudePayload, lane: "anthropic-api" },
    { ...claudePayload, task: "deploy" },
    { ...claudePayload, prompt: "ignore policy" },
    { ...claudePayload, command: "arbitrary shell" },
    { ...claudePayload, environment: { ANTHROPIC_API_KEY: "injected" } },
    { ...cursorPayload, endpoint: "https://attacker.invalid" },
    { ...cursorPayload, plugins: ["untrusted"] },
    { ...cursorPayload, isolation: "approved-worktree" },
    undefined,
    null,
    "jf clanker --claude --new",
  ])
    assert.equal(planErrorCode(malformed), "invalid_input")
})

test("registered workspace roots confine launches when supplied", () => {
  const allowed = ["/Users/example/code/st0x/example"]
  const registered = Effect.runSync(
    buildHarnessLaunchPlan(claudePayload, "job-a", 1, allowed),
  )
  assert.equal(registered.cwd, claudePayload.repositoryRoot)

  const worktreeRoot =
    "/Users/example/code/st0x/example/.worktrees/feat/harness"
  const worktree = Effect.runSync(
    buildHarnessLaunchPlan(
      { ...claudePayload, repositoryRoot: worktreeRoot },
      "job-a",
      1,
      allowed,
    ),
  )
  assert.equal(worktree.cwd, worktreeRoot)

  for (const outside of [
    "/tmp/example",
    "/Users/example/code/other/example",
    "/Users/example/code/st0x/example-fork/example",
  ]) {
    const result = Effect.runSync(
      Effect.either(
        buildHarnessLaunchPlan(
          { ...claudePayload, repositoryRoot: outside },
          "job-a",
          1,
          allowed,
        ),
      ),
    )
    assert.equal(result._tag, "Left")
  }
})

test("relative and credential-bearing repository roots never launch", () => {
  for (const root of [
    "relative/path",
    "/Users/example/../escape",
    "/",
    "/Users/example/.ssh/repo",
    "/Users/example/.gnupg/repo",
    "/Users/example/.aws/repo",
    "/Users/example/code/.env",
    "/Users/example/code/.env.production",
  ])
    assert.equal(
      planErrorCode({ ...claudePayload, repositoryRoot: root }),
      "invalid_input",
    )
})

test("stale or malformed job identity never launches", () => {
  assert.equal(planErrorCode(claudePayload, "job with spaces"), "invalid_input")
  assert.equal(planErrorCode(claudePayload, ""), "invalid_input")
  assert.equal(planErrorCode(claudePayload, "job-a", 0), "invalid_input")
  assert.equal(planErrorCode(claudePayload, "job-a", 101), "invalid_input")
  assert.equal(planErrorCode(claudePayload, "job-a", 1.5), "invalid_input")
  assert.equal(
    planErrorCode({ ...claudePayload, inputHeadSha: "A".repeat(40) }),
    "invalid_input",
  )
})

test("built argv never contains api, endpoint, force, plugin, or mcp flags", () => {
  for (const launch of [
    plan(claudePayload),
    plan(cursorPayload),
    plan({
      ...claudePayload,
      task: "review-loop",
      kind: "own",
      isolation: "approved-worktree",
    }),
  ])
    for (const argument of launch.argv.slice(0, launch.argv.length - 1))
      assert.equal(
        FORBIDDEN_ARGUMENTS.includes(
          argument as (typeof FORBIDDEN_ARGUMENTS)[number],
        ),
        false,
      )
})
