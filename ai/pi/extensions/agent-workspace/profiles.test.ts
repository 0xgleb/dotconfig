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
    /DataClique replication is out of scope/i,
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

test("unknown workspace profiles fail closed", () => {
  assert.throws(
    () => workspaceProfile("unknown" as "st0x-review", "/Users/example"),
    /unknown agent workspace profile/i,
  );
});
