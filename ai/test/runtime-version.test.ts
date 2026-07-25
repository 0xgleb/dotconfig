import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("fleet diagnostics expose current behavior-bearing component versions", () => {
  assert.match(read("../pi/extensions/shared/runtime-version.ts"), /MANAGED_CONFIG_GENERATION = "2026\.07\.23\.107"/);
  assert.match(read("../pi/extensions/activity-status/index.ts"), /activity-status", "2026\.07\.23\.2"/);
  assert.match(read("../pi/extensions/agent-registry/index.ts"), /agent-registry", "2026\.07\.23\.16"/);
  assert.match(read("../pi/extensions/auto-reload/index.ts"), /auto-reload", "2026\.07\.23\.6"/);
  assert.match(read("../pi/extensions/browser-control/index.ts"), /browser-control", "2026\.07\.23\.1"/);
  assert.match(read("../pi/extensions/btw/index.ts"), /btw", "2026\.07\.23\.1"/);
  assert.match(read("../pi/extensions/classified-workflows/index.ts"), /classified-workflows", "2026\.07\.23\.74"/);
  assert.match(read("../pi/extensions/link-safety/index.ts"), /link-safety", "2026\.07\.23\.1"/);
  assert.match(read("../pi/extensions/questions/index.ts"), /questions", "2026\.07\.23\.8"/);
  assert.match(read("../pi/extensions/pi-vim/index.ts"), /pi-vim", "2026\.07\.23\.7"/);
  assert.match(read("../pi/extensions/remote-control/index.ts"), /remote-control", "2026\.07\.23\.2"/);
  assert.match(read("../pi/extensions/disk-pressure/index.ts"), /resource-pressure", "2026\.07\.23\.5"/);
  assert.match(read("../pi/extensions/safe-compaction/index.ts"), /safe-compaction", "2026\.07\.23\.2"/);
  assert.match(read("../pi/extensions/todo/index.ts"), /todo", "2026\.07\.23\.11"/);
});
