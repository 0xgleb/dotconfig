import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shared = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const pi = readFileSync(new URL("../pi/AGENTS.md", import.meta.url), "utf8");

test("shared and Pi-global instructions enforce handover ingestion", () => {
  for (const [name, contents] of [["shared", shared], ["Pi global", pi]] as const) {
    assert.match(contents, /\/handover/, `${name} instructions must invoke /handover`);
    assert.match(contents, /receiv(?:e|ing).*handover/is, `${name} instructions must cover receiving handovers`);
    assert.match(contents, /(?:every|all).*transferred request/is, `${name} instructions must preserve every transferred request`);
    assert.match(contents, /todo list/i, `${name} instructions must track transferred work in todos`);
  }
});
