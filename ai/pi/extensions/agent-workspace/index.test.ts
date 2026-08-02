import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("dedicated workspace launch is profile-bound and shell-free", () => {
  assert.match(source, /name: "agent_workspace"/);
  assert.match(
    source,
    /StringEnum\(\s*\["st0x-review", "dataclique-review", "personal-review"\]/,
  );
  assert.match(source, /claudeWorkspaceLaunchArguments/);
  assert.doesNotMatch(source, /pi\.exec\("(?:bash|sh|zsh)"/);
  assert.match(source, /query-pane-names/);
  assert.match(source, /existing \? "running" : "stopped"/);
});

test("review supervisors migrate to Luna without changing unrelated sessions", () => {
  assert.match(source, /profileForSession\(pi\.getSessionName\(\)\)/);
  assert.match(source, /find\("openai-codex", "gpt-5\.6-luna"\)/);
  assert.match(source, /pi\.setModel\(luna\)/);
  assert.match(source, /pi\.setThinkingLevel\("high"\)/);
  assert.match(source, /SUPERVISOR_POLICY_MESSAGE/);
  assert.match(source, /Never run a PR review panel or fix pass in Pi/);
  assert.match(source, /deliverAs: "nextTurn"/);
});

test("Claude dispatch is source-fixed, profile-bound, and fail-closed", () => {
  assert.match(source, /StringEnum\(\["start", "status", "dispatch", "replace"\]/);
  assert.match(source, /pi\.getSessionName\(\) !== profile\.sessionName/);
  assert.match(source, /Invalid or out-of-scope Claude review dispatch/);
  assert.match(source, /restoreReviewDutyState/);
  assert.match(source, /requires the exact active review_duty job/);
  assert.match(source, /\^\[0-9a-f\]\{40,64\}\$/);
  assert.match(source, /lstatSync\(parsed\.repositoryRoot\)\.isSymbolicLink\(\)/);
  assert.match(source, /profile\.additionalRepositoryRoots/);
  assert.match(source, /child\.startsWith\("\.\."\)/);
  assert.match(source, /claudeExecutorLaunchArguments/);
  assert.doesNotMatch(source, /go-to-tab-name/);
  assert.match(source, /ctx\.sessionManager\.getSessionId\(\)/);
  assert.match(source, /status: "dispatched"/);
});

test("in-place replacement is matching-session only and never creates a pane or tab", () => {
  assert.match(source, /params\.action === "replace"/);
  assert.match(source, /pi\.getSessionName\(\) !== profile\.sessionName/);
  assert.match(source, /claudeInPlaceLaunchArguments/);
  assert.match(source, /status: "replaced"/);
});

test("automatic dispatch accepts only the two existing exact automatic lanes", () => {
  assert.match(
    source,
    /repository !== "dataclique\/yielduck"[\s\S]*?repository !== "0xgleb\/dotconfig"/,
  );
});
