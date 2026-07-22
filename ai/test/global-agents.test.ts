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

test("shared and Pi-global instructions route work through the agent registry", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /check `agent_registry`/i, `${name} must discover role owners`);
    assert.match(contents, /delegate to the live role owner/i, `${name} must route owned work`);
    assert.match(contents, /unowned.*claim.*temporarily/is, `${name} must self-claim by default`);
    assert.match(contents, /role never grants authority/i, `${name} must separate routing from authority`);
    assert.match(contents, /operational role.*not done.*inbox.*empty/is, `${name} must preserve operational ownership`);
  }
});

test("shared and Pi-global instructions prohibit overwriting the active editor", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /never inject.*(?:keystrokes|text).*active.*(?:pane|editor)/is, `${name} must protect prompt drafts`);
    assert.match(contents, /reload_pi/, `${name} must direct reloads through the safe tool`);
  }
});

test("shared and Pi-global instructions preserve focus for autonomous background delegation", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /explicitly asks to spawn.*focusing.*allowed/is, `${name} must allow requested focus`);
    assert.match(contents, /snapshot.*active.*tab and pane.*restore.*exact focus/is, `${name} must restore background focus`);
    assert.match(contents, /cannot be verified.*classified background workflow/is, `${name} must fail closed on restoration`);
  }
});

test("shared and Pi-global instructions forbid stopping with active work", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /goal.*active.*continue.*(?:achieved|complete)/is, `${name} must continue active goals`);
    assert.match(contents, /pending.*todo.*continue/is, `${name} must continue pending tasks`);
    assert.match(contents, /all.*remaining.*blocked/is, `${name} must define the only blocked stopping condition`);
  }
});

test("shared and Pi-global instructions preserve manual interrupt pauses", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /manual user interrupt|double-cancel/i, `${name} must recognize manual interruption`);
    assert.match(contents, /do not.*automatically resume.*until.*next prompt/is, `${name} must wait for user redirection`);
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
