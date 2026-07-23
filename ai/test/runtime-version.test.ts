import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("fleet diagnostics expose current behavior-bearing component versions", () => {
  assert.match(read("../pi/extensions/shared/runtime-version.ts"), /MANAGED_CONFIG_GENERATION = "2026\.07\.23\.40"/);
  assert.match(read("../pi/extensions/activity-status/index.ts"), /activity-status", "2026\.07\.23\.1"/);
  assert.match(read("../pi/extensions/agent-registry/index.ts"), /agent-registry", "2026\.07\.23\.8"/);
  assert.match(read("../pi/extensions/auto-reload/index.ts"), /auto-reload", "2026\.07\.23\.3"/);
  assert.match(read("../pi/extensions/classified-workflows/index.ts"), /classified-workflows", "2026\.07\.23\.30"/);
  assert.match(read("../pi/extensions/questions/index.ts"), /questions", "2026\.07\.23\.6"/);
  assert.match(read("../pi/extensions/pi-vim/index.ts"), /pi-vim", "2026\.07\.23\.4"/);
  assert.match(read("../pi/extensions/safe-compaction/index.ts"), /safe-compaction", "2026\.07\.23\.1"/);
  assert.match(read("../pi/extensions/todo/index.ts"), /todo", "2026\.07\.23\.4"/);
});
