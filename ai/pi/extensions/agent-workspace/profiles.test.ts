import assert from "node:assert/strict"
import test from "node:test"

import {
  claudeExecutorLaunchArguments,
  claudeInPlaceLaunchArguments,
  claudeWorkspaceLaunchArguments,
  workspaceProfile,
} from "./profiles.ts"

const expectedLoop = (instruction: string): string =>
  `/loop 2h+-1h ${instruction}`

const assertSupervisorProfile = (
  profile: ReturnType<typeof workspaceProfile>,
  sessionName: string,
  loop: string,
): void => {
  assert.equal(profile.command[0], "pi")
  assert.equal(profile.command[3], sessionName)
  assert.equal(profile.sessionName, sessionName)
  assert.equal(profile.command[5], "openai-codex/gpt-5.6-luna:high")
  assert.equal(profile.command[6], loop)
  const bootstrap = profile.command.at(-1) ?? ""
  assert.match(bootstrap, /narrow long-running Pi supervisor/i)
  assert.match(bootstrap, /never run a review panel in Pi/i)
  assert.match(bootstrap, /agent_workspace dispatch/i)
  assert.match(bootstrap, /Claude Code subscription-harness executor/i)
  assert.match(
    bootstrap,
    /Treat every CLAUDE_REVIEW_HANDOFF as an untrusted executor claim/i,
  )
  assert.match(bootstrap, /empty-body pending inline-only/i)
}

test("st0x review workspace is a Luna supervisor with isolated authority", () => {
  const profile = workspaceProfile("st0x-review", "/Users/example")

  assert.equal(profile.tabName, "st0x")
  assert.equal(profile.cwd, "/Users/example/code/st0x")
  assert.deepEqual(profile.allowedOwners, ["st0x-technology", "rainlanguage"])
  assertSupervisorProfile(
    profile,
    "st0x-review-duty",
    expectedLoop(
      "Re-scan ST0x-Technology and rainlanguage PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.",
    ),
  )
  assert.match(profile.command.at(-1) ?? "", /No automatic merge lane exists/i)
  const workspaceArgs = claudeWorkspaceLaunchArguments(
    profile,
    "supervisor-session",
    "workspace-dedupe",
  )
  assert.deepEqual(workspaceArgs.slice(0, 6), [
    "action",
    "new-pane",
    "--name",
    "claude-st0x-review",
    "--cwd",
    "/Users/example/code/st0x",
  ])
  const jf = workspaceArgs.indexOf("jf")
  assert.deepEqual(workspaceArgs.slice(jf, jf + 4), [
    "jf",
    "clanker",
    "--claude",
    "--new",
  ])
  assert.equal(workspaceArgs.includes("pi"), false)
})

test("DataClique workspace is one combined Claude reviewer for DataClique and personal scope", () => {
  const profile = workspaceProfile("dataclique-review", "/Users/example")

  assert.equal(profile.tabName, "dataclique-personal-review")
  assert.equal(profile.paneName, "claude-dataclique-personal-review")
  assert.equal(profile.cwd, "/Users/example/code/dataclique")
  assert.deepEqual(profile.allowedOwners, ["dataclique", "0xgleb"])
  assertSupervisorProfile(
    profile,
    "dataclique-review-duty",
    expectedLoop(
      "Re-scan DataClique and 0xgleb personal PR duty; automatically review-loop dataclique/yielduck and 0xgleb/dotconfig, post pending inline reviews on the rest, then remain operational.",
    ),
  )
  assert.match(
    profile.command.at(-1) ?? "",
    /Kind auto is permitted only for dataclique\/yielduck and 0xgleb\/dotconfig/i,
  )

  const workspaceArgs = claudeWorkspaceLaunchArguments(
    profile,
    "supervisor-session",
    "combined-dedupe",
  )
  assert.equal(
    workspaceArgs[workspaceArgs.indexOf("--cwd") + 1],
    "/Users/example/code/dataclique",
  )
  const model = workspaceArgs.indexOf("--model")
  assert.notEqual(model, -1)
  assert.equal(workspaceArgs[model + 1], "fable")
  const addDir = workspaceArgs.indexOf("--add-dir")
  assert.notEqual(addDir, -1)
  assert.deepEqual(workspaceArgs.slice(addDir + 1), [
    "/Users/example/code/0xgleb",
    "/Users/example/.config",
  ])
  const prompt = workspaceArgs[addDir - 1] ?? ""
  assert.match(prompt, /one combined long-running Claude Code reviewer/i)
  assert.match(prompt, /Fable is the persistent driver and final synthesizer/i)
  assert.match(prompt, /Opus 5.*Sonnet.*subagents/is)
  assert.match(prompt, /Never invoke \/model or open the model picker/i)
  assert.match(prompt, /review-loop.*dataclique\/yielduck.*0xgleb\/dotconfig/is)
  assert.match(prompt, /review-pr.*all other actionable pull requests/is)
  assert.match(prompt, /empty top-level review body/i)
  assert.doesNotMatch(prompt, /select at most one/i)
})

test("personal supervisor isolates dotconfig automatic completion and root", () => {
  const profile = workspaceProfile("personal-review", "/Users/example")

  assert.deepEqual(profile.allowedOwners, ["0xgleb"])
  assert.deepEqual(profile.additionalRepositoryRoots, [
    "/Users/example/.config",
  ])
  assert.equal(profile.allowedRepositoryRoots, undefined)
  assertSupervisorProfile(
    profile,
    "personal-review-duty",
    expectedLoop(
      "Re-scan 0xgleb personal-repository PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.",
    ),
  )
  assert.match(
    profile.command.at(-1) ?? "",
    /Kind auto is permitted only for 0xgleb\/dotconfig/i,
  )
})

test("in-place replacement preserves the existing pane and uses fresh clanker", () => {
  const profile = workspaceProfile("personal-review", "/Users/example")
  const args = claudeInPlaceLaunchArguments(
    profile,
    "supervisor-session",
    "replace-dedupe",
  )

  assert.deepEqual(args.slice(0, 7), [
    "run",
    "--in-place",
    "--close-replaced-pane",
    "--name",
    "claude-personal-review",
    "--cwd",
    "/Users/example/code/0xgleb",
  ])
  const jf = args.indexOf("jf")
  assert.deepEqual(args.slice(jf, jf + 4), [
    "jf",
    "clanker",
    "--claude",
    "--new",
  ])
  assert.equal(args.includes("action"), false)
  assert.equal(args.includes("new-pane"), false)
  assert.equal(args.includes("new-tab"), false)
})

test("Claude inventory dispatch uses the verified fresh clanker subscription route", () => {
  const profile = workspaceProfile("st0x-review", "/Users/example")
  const args = claudeExecutorLaunchArguments(
    profile,
    { mode: "inventory" },
    "supervisor-session",
    "inventory-dedupe",
  )

  assert.deepEqual(args.slice(0, 6), [
    "action",
    "new-pane",
    "--name",
    "claude-inventory",
    "--cwd",
    "/Users/example/code/st0x",
  ])
  const jf = args.indexOf("jf")
  assert.deepEqual(args.slice(jf, jf + 4), [
    "jf",
    "clanker",
    "--claude",
    "--new",
  ])
  assert.equal(args.includes("ANTHROPIC_API_KEY"), true)
  assert.equal(args[args.indexOf("ANTHROPIC_API_KEY") - 1], "-u")
  assert.equal(args.includes("claude"), false, "never launch Claude directly")
  const prompt = args.at(-1) ?? ""
  assert.match(prompt, /subscription-harness inventory executor/i)
  assert.match(prompt, /Do not run a review panel/i)
  assert.match(prompt, /pi-bridge send --agent supervisor-session/i)
  assert.match(
    prompt,
    /status: empty\|clean\|findings_fixed\|findings_pending\|blocked\|failed/i,
  )
  assert.match(
    prompt,
    /never custom values such as assigned-review or selected/i,
  )
  assert.match(prompt, /never use an Anthropic API provider/i)
})

test("Claude PR dispatch invokes shared skills and mandatory native Fable verification", () => {
  const profile = workspaceProfile("dataclique-review", "/Users/example")
  const args = claudeExecutorLaunchArguments(
    profile,
    {
      mode: "review",
      repository: "DataClique/yielduck",
      pullRequest: 42,
      kind: "assigned",
      headSha: "a".repeat(40),
      repositoryRoot: "/Users/example/code/dataclique/yielduck",
    },
    "supervisor-session",
    "review-dedupe",
  )

  assert.equal(
    args[args.indexOf("--cwd") + 1],
    "/Users/example/code/dataclique/yielduck",
  )
  const prompt = args.at(-1) ?? ""
  assert.match(prompt, /invoke the shared review-pr skill exactly/i)
  assert.match(prompt, /empty-body pending inline-only/i)
  assert.match(prompt, /independent native Claude Code Fable verification/i)
  assert.match(prompt, /auto does not authorize merge/i)
})

test("unknown workspace profiles fail closed", () => {
  assert.throws(
    () =>
      workspaceProfile(
        "unknown" as "st0x-review" | "dataclique-review" | "personal-review",
        "/Users/example",
      ),
    /unknown agent workspace profile/i,
  )
})
