import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const delegationSkill = readFileSync(new URL("../skills/pi-delegation/SKILL.md", import.meta.url), "utf8");

test("visible Zellij workers use human-readable Pi output", () => {
  assert.match(delegationSkill, /pi --print --no-session --tools read,grep,find,ls/);
  assert.doesNotMatch(delegationSkill, /pi[^\n]*--mode\s+json/);
  assert.match(delegationSkill, /dump-screen --full/);
});
