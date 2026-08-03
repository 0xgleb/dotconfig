import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const delegationSkill = readFileSync(new URL("../skills/pi-delegation/SKILL.md", import.meta.url), "utf8");

test("visible Zellij workers use human-readable Pi output", () => {
  assert.match(delegationSkill, /pi --print --no-session --tools read,grep,find,ls/);
  assert.doesNotMatch(delegationSkill, /pi[^\n]*--mode\s+json/);
  assert.match(delegationSkill, /dump-screen --full/);
});

test("Zellij delegation focuses requested agents and restores autonomous background focus", () => {
  assert.match(delegationSkill, /explicitly asks to spawn.*focusing.*allowed/is);
  assert.match(delegationSkill, /snapshot.*active tab.*pane IDs/is);
  assert.match(delegationSkill, /restore both before returning control/is);
  assert.match(delegationSkill, /verify.*structured Zellij state/is);
  assert.match(delegationSkill, /classified background workflow instead/is);
});
