import assert from "node:assert/strict";
import test from "node:test";

import { workspaceProfile, zellijLaunchArguments } from "./profiles.ts";

test("st0x review workspace is a source-fixed operational profile", () => {
  const profile = workspaceProfile("st0x-review", "/Users/example");

  assert.equal(profile.tabName, "st0x");
  assert.equal(profile.cwd, "/Users/example/code/st0x");
  assert.deepEqual(profile.command.slice(0, 7), [
    "pi",
    "--approve",
    "--name",
    "st0x-review-duty",
    "--model",
    "openai-codex/gpt-5.6-sol:high",
    "/loop 15m Re-scan ST0x-Technology and rainlanguage PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.",
  ]);
  assert.match(
    profile.command.at(-1) ?? "",
    /role reviewer in operational mode/i,
  );
  assert.match(
    profile.command.at(-1) ?? "",
    /empty-body pending draft review/i,
  );
  assert.match(
    profile.command.at(-1) ?? "",
    /DataClique and personal repositories remain out of scope/i,
  );
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

test("DataClique review workspace is isolated and auto-merges only Yielduck", () => {
  const profile = workspaceProfile("dataclique-review", "/Users/example");

  assert.equal(profile.tabName, "dataclique-review");
  assert.equal(profile.cwd, "/Users/example/code/dataclique");
  assert.deepEqual(profile.command.slice(0, 7), [
    "pi",
    "--approve",
    "--name",
    "dataclique-review-duty",
    "--model",
    "openai-codex/gpt-5.6-sol:high",
    "/loop 15m Re-scan DataClique PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.",
  ]);
  const bootstrap = profile.command.at(-1) ?? "";
  assert.match(
    bootstrap,
    /only on repositories owned by the DataClique GitHub organization/i,
  );
  assert.match(bootstrap, /dataclique\/yielduck[\s\S]*auto-merge/i);
  assert.match(bootstrap, /every other DataClique repository[\s\S]*human action gate/i);
  assert.match(bootstrap, /empty-body pending draft review/i);
});

test("personal review workspace is isolated and auto-merges only dotconfig", () => {
  const profile = workspaceProfile("personal-review", "/Users/example");

  assert.equal(profile.tabName, "personal-review");
  assert.equal(profile.cwd, "/Users/example/code/0xgleb");
  assert.equal(profile.command[3], "personal-review-duty");
  const bootstrap = profile.command.at(-1) ?? "";
  assert.match(
    bootstrap,
    /only on repositories owned by the 0xgleb GitHub account/i,
  );
  assert.match(bootstrap, /0xgleb\/dotconfig[\s\S]*auto-merge/i);
  assert.match(bootstrap, /every other 0xgleb repository[\s\S]*human action gate/i);
  assert.doesNotMatch(bootstrap, /DataClique replication is out of scope/i);
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
