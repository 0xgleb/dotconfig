import assert from "node:assert/strict";
import test from "node:test";

import { isSafeHandoffName, managedPiWatchPaths } from "./core.ts";

test("auto reload watches only managed Pi source roots", () => {
  assert.deepEqual(managedPiWatchPaths("/Users/example/.config/ai"), [
    "/Users/example/.config/ai/AGENTS.md",
    "/Users/example/.config/ai/pi.settings.json",
    "/Users/example/.config/ai/pi/AGENTS.md",
    "/Users/example/.config/ai/pi/extensions",
    "/Users/example/.config/ai/pi/themes",
    "/Users/example/.config/ai/skills",
  ]);
  assert.equal(managedPiWatchPaths("relative").length, 0);
});

test("handoff watcher accepts only direct visible Markdown filenames", () => {
  assert.equal(isSafeHandoffName("2026-07-22-pi-browser.md"), true);
  assert.equal(isSafeHandoffName("nested/pi.md"), false);
  assert.equal(isSafeHandoffName("../pi.md"), false);
  assert.equal(isSafeHandoffName(".hidden.md"), false);
  assert.equal(isSafeHandoffName("pi.txt"), false);
});
