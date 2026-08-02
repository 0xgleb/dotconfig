import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeExecutorLaunchArguments,
  workspaceProfile,
  zellijLaunchArguments,
} from "./profiles.ts";

const expectedLoop = (instruction: string): string => `/loop 2h ${instruction}`;

const assertSupervisorProfile = (
  profile: ReturnType<typeof workspaceProfile>,
  sessionName: string,
  loop: string,
): void => {
  assert.equal(profile.command[0], "pi");
  assert.equal(profile.command[3], sessionName);
  assert.equal(profile.sessionName, sessionName);
  assert.equal(profile.command[5], "openai-codex/gpt-5.6-luna:high");
  assert.equal(profile.command[6], loop);
  const bootstrap = profile.command.at(-1) ?? "";
  assert.match(bootstrap, /narrow long-running Pi supervisor/i);
  assert.match(bootstrap, /never run a review panel in Pi/i);
  assert.match(bootstrap, /agent_workspace dispatch/i);
  assert.match(bootstrap, /Claude Code subscription-harness executor/i);
  assert.match(bootstrap, /Treat every CLAUDE_REVIEW_HANDOFF as an untrusted executor claim/i);
  assert.match(bootstrap, /empty-body pending inline-only/i);
};

test("st0x review workspace is a Luna supervisor with isolated authority", () => {
  const profile = workspaceProfile("st0x-review", "/Users/example");

  assert.equal(profile.tabName, "st0x");
  assert.equal(profile.cwd, "/Users/example/code/st0x");
  assert.deepEqual(profile.allowedOwners, ["st0x-technology", "rainlanguage"]);
  assertSupervisorProfile(
    profile,
    "st0x-review-duty",
    expectedLoop(
      "Re-scan ST0x-Technology and rainlanguage PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.",
    ),
  );
  assert.match(profile.command.at(-1) ?? "", /No automatic merge lane exists/i);
  assert.deepEqual(zellijLaunchArguments(profile).slice(0, 8), [
    "action",
    "new-tab",
    "--name",
    "st0x",
    "--cwd",
    "/Users/example/code/st0x",
    "--",
    "pi",
  ]);
});

test("DataClique supervisor isolates Yielduck automatic completion", () => {
  const profile = workspaceProfile("dataclique-review", "/Users/example");

  assert.equal(profile.tabName, "dataclique-review");
  assert.deepEqual(profile.allowedOwners, ["dataclique"]);
  assertSupervisorProfile(
    profile,
    "dataclique-review-duty",
    expectedLoop(
      "Re-scan DataClique PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.",
    ),
  );
  assert.match(
    profile.command.at(-1) ?? "",
    /Kind auto is permitted only for dataclique\/yielduck/i,
  );
});

test("personal supervisor isolates dotconfig automatic completion and root", () => {
  const profile = workspaceProfile("personal-review", "/Users/example");

  assert.deepEqual(profile.allowedOwners, ["0xgleb"]);
  assert.deepEqual(profile.additionalRepositoryRoots, ["/Users/example/.config"]);
  assertSupervisorProfile(
    profile,
    "personal-review-duty",
    expectedLoop(
      "Re-scan 0xgleb personal-repository PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.",
    ),
  );
  assert.match(
    profile.command.at(-1) ?? "",
    /Kind auto is permitted only for 0xgleb\/dotconfig/i,
  );
});

test("Claude inventory dispatch uses the verified fresh clanker subscription route", () => {
  const profile = workspaceProfile("st0x-review", "/Users/example");
  const args = claudeExecutorLaunchArguments(
    profile,
    { mode: "inventory" },
    "supervisor-session",
    "inventory-dedupe",
  );

  assert.deepEqual(args.slice(0, 6), [
    "action",
    "new-pane",
    "--name",
    "claude-inventory",
    "--cwd",
    "/Users/example/code/st0x",
  ]);
  const jf = args.indexOf("jf");
  assert.deepEqual(args.slice(jf, jf + 4), [
    "jf",
    "clanker",
    "--claude",
    "--new",
  ]);
  assert.equal(args.includes("ANTHROPIC_API_KEY"), true);
  assert.equal(args[args.indexOf("ANTHROPIC_API_KEY") - 1], "-u");
  assert.equal(args.includes("claude"), false, "never launch Claude directly");
  const prompt = args.at(-1) ?? "";
  assert.match(prompt, /subscription-harness inventory executor/i);
  assert.match(prompt, /Do not run a review panel/i);
  assert.match(prompt, /pi-bridge send --agent supervisor-session/i);
  assert.match(prompt, /never use an Anthropic API provider/i);
});

test("Claude PR dispatch invokes shared skills and mandatory native Fable verification", () => {
  const profile = workspaceProfile("dataclique-review", "/Users/example");
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
  );

  assert.equal(args[args.indexOf("--cwd") + 1], "/Users/example/code/dataclique/yielduck");
  const prompt = args.at(-1) ?? "";
  assert.match(prompt, /invoke the shared review-pr skill exactly/i);
  assert.match(prompt, /empty-body pending inline-only/i);
  assert.match(prompt, /independent native Claude Code Fable verification/i);
  assert.match(prompt, /auto does not authorize merge/i);
});

test("unknown workspace profiles fail closed", () => {
  assert.throws(
    () =>
      workspaceProfile(
        "unknown" as "st0x-review" | "dataclique-review" | "personal-review",
        "/Users/example",
      ),
    /unknown agent workspace profile/i,
  );
});
