import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shared = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const pi = readFileSync(new URL("../pi/AGENTS.md", import.meta.url), "utf8");
const project = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");

test("shared and Pi-global instructions resist confirmation bias", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /do not mirror.*latest framing|agree reflexively/is, `${name} must avoid reflexive agreement`);
    assert.match(contents, /counter-hypothesis/i, `${name} must test contrary evidence`);
    assert.match(contents, /do not oscillate.*without changed/is, `${name} must keep conclusions evidence-stable`);
    assert.match(contents, /inspect existing code.*doc/is, `${name} must check for existing coverage`);
    assert.match(contents, /correct prior unsupported/i, `${name} must own unsupported answers`);
  }
});

test("shared and Pi-global TypeScript guidance keeps failures in typed Effect channels", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /expected failures.*Effect error type/is, `${name} must type expected failures`);
    assert.match(contents, /Effect\.try.*Effect\.tryPromise/is, `${name} must permit throwing interop translation`);
    assert.match(contents, /typed error handlers|typed.*rather than untyped.*try.*catch/is, `${name} must avoid untyped exception control flow`);
  }
});

test("shared and Pi-global instructions enforce disk-pressure hygiene", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /free disk space.*expensive build/is, `${name} instructions must check build capacity`);
    assert.match(contents, /agent-(?:created|owned).*artifact/is, `${name} instructions must clean owned artifacts`);
    assert.match(contents, /artifact_provenance/is, `${name} instructions must record Pi scratch provenance`);
    assert.match(contents, /never.*global.*(?:cache|garbage collection).*without explicit/is, `${name} instructions must protect global caches`);
  }
});

test("shared and Pi-global instructions route work through the agent registry", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /check `agent_registry`/i, `${name} must discover role owners`);
    assert.match(contents, /delegate\s+to the live role owner/i, `${name} must route owned work`);
    assert.match(contents, /unowned.*claim.*temporarily/is, `${name} must self-claim by default`);
    assert.match(contents, /role never\s+grants authority/i, `${name} must separate routing from authority`);
    assert.match(contents, /operational role.*not done.*inbox.*empty/is, `${name} must preserve operational ownership`);
  }
});

test("Pi-global instructions delegate Pi infrastructure bugs to the standing support operator", () => {
  assert.match(pi, /Pi host, extension, TUI, auto-classifier, delegation, reload, or operator/i);
  assert.match(pi, /project `\/Users\/0xgleb\/\.config`, role `pi-support`/i);
  assert.match(pi, /queue.*without self-claiming.*dedicated role/is);
  assert.match(pi, /continue.*primary project task.*without duplicating/is);
});

test("Pi-global instructions keep the Yielduck operational owner alive while implementation is blocked", () => {
  assert.match(pi, /dataclique\/yielduck.*managed `operator` role/is);
  assert.match(pi, /monitoring even when every.*todo is blocked/is);
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

test("shared and Pi-global instructions continue safely after classifier blocks", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /block is not.*permission to stop|correct block is not.*permission to stop/is, `${name} must continue active work`);
    assert.match(contents, /never.*--force.*bypass/is, `${name} must not invent force bypasses`);
    assert.match(contents, /return to the real active task.*safe path/is, `${name} must recover task focus`);
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
