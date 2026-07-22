import assert from "node:assert/strict";
import test from "node:test";

import { isSafeHandoffName, managedPiWatchPaths, parseSeenHandoffNames, unseenHandoffNames } from "./core.ts";

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
  assert.equal(isSafeHandoffName("unrelated-notes.md"), false);
});

test("persisted handoff names are decoded defensively", () => {
  assert.deepEqual(parseSeenHandoffNames({ names: ["pi-one.md", "handoff-two.md"] }), ["pi-one.md", "handoff-two.md"]);
  assert.deepEqual(parseSeenHandoffNames({ names: ["pi-one.md", 7] }), []);
  assert.deepEqual(parseSeenHandoffNames(null), []);
});

test("handoff reconciliation returns safe unseen Pi requests", () => {
  assert.deepEqual(
    unseenHandoffNames(
      ["2026-pi-browser.md", "handoff-classifier.md", "unrelated.md", ".hidden-pi.md"],
      new Set(["2026-pi-browser.md"]),
    ),
    ["handoff-classifier.md"],
  );
});
