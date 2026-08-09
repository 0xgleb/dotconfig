import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  buildHarnessLaunchPlan,
  toCanonicalWorkspaceRoot,
  type HarnessLaunchPlan,
  type RegisteredWorkspaceRoots,
} from "./harness-adapter.ts"
import { includesAny, type HarnessReviewPayload } from "./harness-protocol.ts"
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

const ownReviewPayload: HarnessReviewPayload = {
  ...claudePayload,
  task: "review-loop",
  kind: "own",
  isolation: "approved-worktree",
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

const registeredRoots = (roots: readonly string[]): RegisteredWorkspaceRoots =>
  roots.map((root) => {
    const registered = toCanonicalWorkspaceRoot(root)
    if (registered === undefined)
      throw new Error(`fixture is not a canonical workspace root: ${root}`)
    return registered
  })

/**
 * Registered roots as a caller that skipped the validating constructor would
 * hand them over, so the launch-time canonical check stays exercised.
 */
const unvalidatedRoots = (
  roots: readonly string[],
): RegisteredWorkspaceRoots => roots as RegisteredWorkspaceRoots

const allowedRoots = registeredRoots([
  "/Users/example/code/st0x/example",
  "/Users/example/code/0xgleb/example",
  "/Users/example/.config",
])

const plan = (
  payload: unknown,
  jobId = "job-a",
  attempt = 1,
  roots: RegisteredWorkspaceRoots = allowedRoots,
): HarnessLaunchPlan =>
  Effect.runSync(buildHarnessLaunchPlan(payload, jobId, attempt, roots, home))

const planErrorCode = (
  payload: unknown,
  jobId = "job-a",
  attempt = 1,
  roots: RegisteredWorkspaceRoots = allowedRoots,
): string | undefined => {
  const result = Effect.runSync(
    Effect.either(
      buildHarnessLaunchPlan(payload, jobId, attempt, roots, home),
    ),
  )
  if (Either.isRight(result)) return undefined
  return result.left.code
}

const executorCommand = (launch: HarnessLaunchPlan): readonly string[] =>
  launch.argv.slice(
    1 + launch.scrubbedEnvironment.length * 2,
    launch.argv.length - 1,
  )

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
  "bypassPermissions",
  "auto",
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
  assert.deepEqual(executorCommand(launch), [
    "claude",
    "-p",
    "--no-session-persistence",
    "--permission-mode",
    "plan",
  ])
  const prompt = launch.argv.at(-1) ?? ""
  assert.equal(prompt.includes("st0x-technology/example#42"), true)
  assert.equal(prompt.includes(headSha), true)
  assert.equal(prompt.includes("review-pr"), true)
  assert.equal(prompt.includes("job-a"), true)
  assert.equal(prompt.includes("attempt 1"), true)
})

test("the claude lane runs headless with the permission mode its isolation allows", () => {
  assert.deepEqual(executorCommand(plan(claudePayload)), [
    "claude",
    "-p",
    "--no-session-persistence",
    "--permission-mode",
    "plan",
  ])
  for (const launch of [
    plan(ownReviewPayload),
    plan(automaticPayload, "job-auto", 1),
  ])
    assert.deepEqual(executorCommand(launch), [
      "claude",
      "-p",
      "--no-session-persistence",
      "--permission-mode",
      "acceptEdits",
    ])
})

test("claude own-review work runs review-loop in an isolated worktree", () => {
  const launch = plan(ownReviewPayload)
  assert.notEqual(launch.cwd, ownReviewPayload.repositoryRoot)
  assert.equal(
    launch.cwd,
    `${ownReviewPayload.repositoryRoot}/.worktrees/job-a-1`,
  )
  const prompt = launch.argv.at(-1) ?? ""
  assert.equal(prompt.includes("review-loop"), true)
  assert.equal(prompt.includes("approved-worktree"), true)
  assert.equal(prompt.includes(launch.cwd), true)
})

test("each harness attempt runs in its own worktree", () => {
  const first = plan(ownReviewPayload, "job-a", 1)
  const second = plan(ownReviewPayload, "job-a", 2)
  const other = plan(ownReviewPayload, "job-b", 1)
  assert.notEqual(first.cwd, second.cwd)
  assert.notEqual(first.cwd, other.cwd)
})

test("automatic review launches inside the registered automatic checkout", () => {
  const launch = plan(automaticPayload, "job-auto", 1)
  assert.equal(launch.lane, "claude-code-max")
  assert.equal(launch.cwd, "/Users/example/.config/.worktrees/job-auto-1")
  const prompt = launch.argv.at(-1) ?? ""
  assert.equal(prompt.includes("0xgleb/dotconfig#56"), true)
  assert.equal(prompt.includes("review-loop"), true)
  assert.equal(
    planErrorCode({ ...automaticPayload, repository: "0xgleb/example" }),
    "invalid_input",
  )
})

test("approved-worktree work never nests inside another worktree", () => {
  assert.equal(
    planErrorCode({
      ...ownReviewPayload,
      repositoryRoot: `${ownReviewPayload.repositoryRoot}/.worktrees/feat/other`,
    }),
    "invalid_input",
  )
})

test("the cursor lane builds an exact read-only plan-mode probe", () => {
  const launch = plan(cursorPayload, "job-b", 2)
  assert.equal(launch.lane, "cursor-subscription")
  assert.equal(launch.cwd, cursorPayload.repositoryRoot)
  assert.deepEqual(launch.scrubbedEnvironment, [
    "CURSOR_API_KEY",
    "CURSOR_API_ENDPOINT",
  ])
  assert.deepEqual(launch.argv.slice(0, launch.argv.length - 1), [
    "env",
    "-u",
    "CURSOR_API_KEY",
    "-u",
    "CURSOR_API_ENDPOINT",
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
    "claude -p",
  ])
    assert.equal(planErrorCode(malformed), "invalid_input")
})

test("registered workspace roots confine every launch", () => {
  const registered = plan(claudePayload)
  assert.equal(registered.cwd, claudePayload.repositoryRoot)

  const worktreeRoot =
    "/Users/example/code/st0x/example/.worktrees/feat/harness"
  const worktree = plan({ ...claudePayload, repositoryRoot: worktreeRoot })
  assert.equal(worktree.cwd, worktreeRoot)

  for (const outside of [
    "/tmp/example",
    "/Users/example/code/other/example",
    "/Users/example/code/st0x/example-fork/example",
  ])
    assert.equal(
      planErrorCode({ ...claudePayload, repositoryRoot: outside }),
      "invalid_input",
    )

  assert.equal(
    planErrorCode(
      claudePayload,
      "job-a",
      1,
      registeredRoots(["/Users/example/code/0xgleb/example"]),
    ),
    "invalid_input",
  )
})

test("launches require canonical registered workspace roots", () => {
  for (const roots of [
    [],
    ["relative/path"],
    ["/"],
    ["/Users/example/code/st0x/example/"],
    ["/Users/example/code/st0x/../st0x/example"],
    ["/Users/example/code/st0x/example/.."],
    ["/Users/example/code/st0x/example", "relative/path"],
  ])
    assert.equal(
      planErrorCode(claudePayload, "job-a", 1, unvalidatedRoots(roots)),
      "invalid_input",
    )
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
    plan(ownReviewPayload),
    plan(automaticPayload, "job-auto", 1),
  ])
    for (const argument of launch.argv.slice(0, launch.argv.length - 1))
      assert.equal(includesAny(FORBIDDEN_ARGUMENTS, argument), false)
})
