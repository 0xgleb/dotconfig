import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url), "utf8");

test("reload_pi schedules a post-run reload that overtakes queued follow-ups", () => {
  assert.match(source, /manualReloadPending = true/);
  assert.match(source, /Reload scheduled for immediately after the current turn settles/);
  assert.match(source, /details: \{ status: "scheduled" \}[\s\S]*terminate: true/);
  assert.match(source, /const performManualReload[\s\S]*await ctx\.reload\(\)/);
  assert.match(source, /pi\.on\("agent_end"[\s\S]*await performManualReload\(ctx\)/);
  assert.match(source, /pi\.on\("agent_settled"[\s\S]*await performManualReload\(ctx\)/);
  assert.doesNotMatch(source, /details: \{ status: "reloaded" \}/);
});
