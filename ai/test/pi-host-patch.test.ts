import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const patch = readFileSync(new URL("../pi/patches/extension-context-reload.patch", import.meta.url), "utf8");

test("Pi host patch exposes reload without losing finalized messages on restart", () => {
  assert.match(patch, /dist\/core\/extensions\/runner\.js/);
  assert.match(patch, /reload: \(\) =>/);
  assert.match(patch, /handleReloadCommand\(true\)/);
  assert.match(patch, /Cannot reload while agent is streaming/);
  assert.match(patch, /if \(throwOnError\)/);
  assert.match(patch, /dist\/core\/agent-session\.js/);
  const persist = patch.indexOf("Persist finalized messages before notifying the TUI");
  const notify = patch.indexOf("Notify all listeners only after synchronous message persistence");
  assert.ok(persist >= 0 && notify > persist);
});
