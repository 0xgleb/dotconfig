import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const patch = readFileSync(new URL("../pi/patches/extension-context-reload.patch", import.meta.url), "utf8");

test("Pi host patch exposes reload without losing finalized messages on restart", () => {
  assert.match(patch, /dist\/core\/extensions\/runner\.js/);
  assert.match(patch, /reload: \(\) =>/);
  assert.match(patch, /handleReloadCommand\(true\)/);
  assert.match(patch, /Cannot reload while agent is streaming/);
  assert.match(patch, /queuedBeforeReload/);
  assert.match(patch, /getSteeringMessages\(\)/);
  assert.match(patch, /getFollowUpMessages\(\)/);
  assert.match(patch, /Reload changed queued message order/);
  assert.match(patch, /pauseQueuedMessagesOnce\(\)/);
  assert.match(patch, /waitForIdle\(\)\.then/);
  assert.match(patch, /isolateFromQueuedMessages/);
  assert.match(patch, /skipInitialSteeringPoll: true/);
  assert.match(patch, /deliverAs === "resume"/);
  assert.match(patch, /if \(throwOnError\)/);
  assert.match(patch, /typeof item === "object" && item !== null && "type" in item/);
  assert.match(patch, /if \(item === undefined \|\| item === null\)/);
  assert.match(patch, /dist\/core\/event-bus\.js/);
  assert.match(patch, /detail\.replace.*slice\(0, 240\)/);
  assert.match(patch, /dist\/core\/agent-session\.js/);
  const persist = patch.indexOf("Persist finalized messages before notifying the TUI");
  const notify = patch.indexOf("Notify all listeners only after synchronous message persistence");
  assert.ok(persist >= 0 && notify > persist);
});
