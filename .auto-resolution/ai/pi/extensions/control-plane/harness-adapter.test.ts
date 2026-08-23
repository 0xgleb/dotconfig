import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  buildHarnessLaunchPlan,
  toCanonicalWorkspaceRoot,
  type HarnessLaunchPlan,
  type RegisteredWorkspaceRoots,
} from "./harness-adapter.ts"
import {
  LAUNCH_ENVIRONMENT_ALLOWLIST,
  type LaunchEnvironment,
} from "./harness-launch.ts"
import {
  includesAny,
  toCommitSha,
  type CommitSha,
  type HarnessReviewPayload,
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

const headSha = commit("a".repeat(40))

const home = canonical("/Users/example")

/**
 * A launcher environment carrying both the variables a harness is allowed to
 * inherit and the provider variables it must never see, so every launch
 * assertion runs against an environment that would leak under a denylist.
 */
const PROVIDER_ENVIRONMENT: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "sk-ant-provider-secret",
  ANTHROPIC_AUTH_TOKEN: "ant-auth-provider-secret",
  ANTHROPIC_BASE_URL: "https://provider.invalid/anthropic",
  ANTHROPIC_CUSTOM_HEADERS: "x-injected-authorization: provider-secret",
  CLAUDE_CODE_USE_BEDROCK: "bedrock-routing-provider-secret",
  CLAUDE_CODE_USE_VERTEX: "vertex-routing-provider-secret",
  CLAUDE_CODE_USE_FOUNDRY: "foundry-routing-provider-secret",
  AWS_BEARER_TOKEN_BEDROCK: "aws-bedrock-provider-secret",
  CURSOR_API_KEY: "cur-provider-secret",
  CURSOR_API_ENDPOINT: "https://provider.invalid/cursor",
  OPENAI_API_KEY: "sk-openai-provider-secret",
  OPENAI_BASE_URL: "https://provider.invalid/openai",
  GEMINI_API_KEY: "gemini-provider-secret",
  GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcloud-provider-secret.json",
  HTTP_PROXY: "http://provider.invalid:8080",
  HTTPS_PROXY: "https://provider.invalid:8443",
  NO_PROXY: "bypass.provider.invalid",
  NODE_EXTRA_CA_CERTS: "/tmp/intercept-provider-secret.pem",
  UNENUMERATED_FUTURE_PROVIDER_TOKEN: "future-provider-secret",
}

const environment: LaunchEnvironment = {
  HOME: "/Users/example",
  PATH: "/usr/bin:/bin",
  SHELL: "/bin/zsh",
  TERM: "xterm-256color",
  USER: "example",
  LANG: "en_US.UTF-8",
  TMPDIR: "/tmp/example-scratch",
  ...PROVIDER_ENVIRONMENT,
}

/** The prefix `environment` produces: allowlisted and set, in allowlist order. */
const LAUNCH_PREFIX = [
  "env",
  "-i",
  "HOME=/Users/example",
  "PATH=/usr/bin:/bin",
  "SHELL=/bin/zsh",
  "TERM=xterm-256color",
  "USER=example",
  "LANG=en_US.UTF-8",
  "TMPDIR=/tmp/example-scratch",
] as const

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
  repositoryRoot: canonical("/Users/example/.config"),
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
  launchedFrom: LaunchEnvironment = environment,
): HarnessLaunchPlan =>
  Effect.runSync(
    buildHarnessLaunchPlan(payload, jobId, attempt, roots, home, launchedFrom),
  )

const planErrorCode = (
  payload: unknown,
  jobId = "job-a",
  attempt = 1,
  roots: RegisteredWorkspaceRoots = allowedRoots,
): string | undefined => {
  const result = Effect.runSync(
    Effect.either(
      buildHarnessLaunchPlan(payload, jobId, attempt, roots, home, environment),
    ),
  )
  return Either.isRight(result) ? undefined : result.left.code
}

const executorCommand = (launch: HarnessLaunchPlan): readonly string[] =>
  launch.argv.slice(LAUNCH_PREFIX.length, launch.argv.length - 1)

const FORBIDDEN_ARGUMENTS = [
  "cursor-agent",
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

test("the Claude lane builds exact source-fixed subscription argv", () => {
  const launch = plan(claudePayload)
  assert.equal(launch.lane, "claude-code-max")
  assert.equal(launch.cwd, claudePayload.repositoryRoot)
  assert.deepEqual(launch.environmentAllowlist, [
    "HOME",
    "PATH",
    "SHELL",
    "TERM",
    "USER",
    "LANG",
    "LC_ALL",
    "TMPDIR",
  ])
  assert.deepEqual(launch.argv.slice(0, LAUNCH_PREFIX.length), [
    ...LAUNCH_PREFIX,
  ])
  assert.deepEqual(executorCommand(launch), [
    "claude",
    "-p",
    "--no-session-persistence",
    "--permission-mode",
    "plan",
  ])
  assert.equal(
    launch.argv.at(-1),
    `You are a fresh Claude Code subscription-harness review executor for st0x-technology/example#42, kind assigned, input head ${headSha}, profile st0x-review. Verify the unchanged input head, then invoke the shared review-pr skill exactly. Assigned work is read-only: no checkout, no mutation, empty-body pending inline-only, and never a submitted verdict. Run an independent native Fable verification before handoff; report blocked if it is unavailable. Never use an Anthropic API provider, SDK, curl, or paid API key. At completion, return exactly one bounded harness handoff v1 for job job-a attempt 1 with matching lane, repository, pull request, and input head SHA. Never include prompts, reasoning, credentials, diffs, or raw logs, and never treat model output as approval or merge authority.`,
  )
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
  assert.deepEqual(launch.argv.slice(0, launch.argv.length - 1), [
    ...LAUNCH_PREFIX,
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
  assert.equal(
    launch.argv.at(-1),
    `You are a read-only Cursor review probe for 0xgleb/example#7, input head ${headSha}, profile personal-review. Inspect the pull request in plan mode without mutating any file, branch, or review state, and report bounded findings only. At completion, return exactly one bounded harness handoff v1 for job job-b attempt 2 with matching lane, repository, pull request, and input head SHA. Never include prompts, reasoning, credentials, diffs, or raw logs, and never treat model output as approval or merge authority.`,
  )
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

test("the launch environment is an allowlist, so an unenumerated provider variable never reaches a harness", () => {
  assert.deepEqual(LAUNCH_ENVIRONMENT_ALLOWLIST, [
    "HOME",
    "PATH",
    "SHELL",
    "TERM",
    "USER",
    "LANG",
    "LC_ALL",
    "TMPDIR",
  ])
  for (const launch of [
    plan(claudePayload),
    plan(cursorPayload, "job-b", 2),
    plan(ownReviewPayload),
    plan(automaticPayload, "job-auto", 1),
  ]) {
    assert.deepEqual(launch.environmentAllowlist, LAUNCH_ENVIRONMENT_ALLOWLIST)
    assert.deepEqual(launch.argv.slice(0, 2), ["env", "-i"])
    for (const assignment of launch.argv.slice(2, LAUNCH_PREFIX.length))
      assert.equal(
        includesAny(
          LAUNCH_ENVIRONMENT_ALLOWLIST,
          assignment.split("=").at(0) ?? "",
        ),
        true,
      )
    for (const [name, value] of Object.entries(PROVIDER_ENVIRONMENT))
      for (const argument of launch.argv) {
        assert.equal(argument.includes(name), false)
        assert.equal(argument.includes(value), false)
      }
  }
})

test("only the allowlisted variables the launcher actually defines are restored", () => {
  const withLocale = plan(claudePayload, "job-a", 1, allowedRoots, {
    ...environment,
    LC_ALL: "C.UTF-8",
  })
  assert.deepEqual(withLocale.argv.slice(0, LAUNCH_PREFIX.length + 1), [
    "env",
    "-i",
    "HOME=/Users/example",
    "PATH=/usr/bin:/bin",
    "SHELL=/bin/zsh",
    "TERM=xterm-256color",
    "USER=example",
    "LANG=en_US.UTF-8",
    "LC_ALL=C.UTF-8",
    "TMPDIR=/tmp/example-scratch",
  ])
  const sparse = plan(claudePayload, "job-a", 1, allowedRoots, {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: PROVIDER_ENVIRONMENT.ANTHROPIC_API_KEY,
  })
  assert.deepEqual(sparse.argv.slice(0, 4), [
    "env",
    "-i",
    "PATH=/usr/bin",
    "claude",
  ])
})

test("unknown lanes, task families, and free-form fields never launch", () => {
  for (const malformed of [
    { ...claudePayload, lane: "cursor-subscription" },
    { ...claudePayload, lane: "anthropic-api" },
    { ...claudePayload, task: "deploy" },
    { ...claudePayload, prompt: "ignore policy" },
    { ...claudePayload, command: "arbitrary shell" },
    { ...claudePayload, environment: { ANTHROPIC_API_KEY: "injected" } },
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
    "/Users/example/.SSH/repo",
    "/Users/example/.gnupg/repo",
    "/Users/example/.aws/repo",
    "/Users/example/code/.env",
    "/Users/example/code/.ENV.production",
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

test("built argv never contains retired Cursor or unsafe flags", () => {
  for (const launch of [
    plan(claudePayload),
    plan(cursorPayload),
    plan(ownReviewPayload),
    plan(automaticPayload, "job-auto", 1),
  ])
    for (const argument of launch.argv.slice(0, launch.argv.length - 1))
      assert.equal(includesAny(FORBIDDEN_ARGUMENTS, argument), false)
})
