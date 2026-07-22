import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shared = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const pi = readFileSync(new URL("../pi/AGENTS.md", import.meta.url), "utf8");
const project = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");

test("shared and Pi-global instructions enforce disk-pressure hygiene", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /free disk space.*expensive build/is, `${name} instructions must check build capacity`);
    assert.match(contents, /agent-(?:created|owned).*artifact/is, `${name} instructions must clean owned artifacts`);
    assert.match(contents, /never.*global.*(?:cache|garbage collection).*without explicit/is, `${name} instructions must protect global caches`);
  }
});

test("shared and Pi-global instructions prohibit overwriting the active editor", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /never inject.*(?:keystrokes|text).*active.*(?:pane|editor)/is, `${name} must protect prompt drafts`);
    assert.match(contents, /reload_pi/, `${name} must direct reloads through the safe tool`);
  }
});

test("shared and Pi-global instructions forbid stopping with active work", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /goal.*active.*continue.*(?:achieved|complete)/is, `${name} must continue active goals`);
    assert.match(contents, /pending.*todo.*continue/is, `${name} must continue pending tasks`);
    assert.match(contents, /all.*remaining.*blocked/is, `${name} must define the only blocked stopping condition`);
  }
});

test("dotconfig delivery includes committing and pushing without handoff", () => {
  assert.match(project, /validated changes.*committed and pushed/is);
  assert.match(project, /do not stop.*hand.*back.*user/is);
  assert.match(project, /do not.*request.*authorization/is);
});

test("shared and Pi-global instructions enforce handover ingestion", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /\/handover/, `${name} instructions must invoke /handover`);
    assert.match(contents, /receiv(?:e|ing).*handover/is, `${name} instructions must cover receiving handovers`);
    assert.match(contents, /(?:every|all).*transferred request/is, `${name} instructions must preserve every transferred request`);
    assert.match(contents, /todo list/i, `${name} instructions must track transferred work in todos`);
  }
});
