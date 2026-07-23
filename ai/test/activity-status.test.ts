import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const activity = readFileSync(new URL("../pi/extensions/activity-status/index.ts", import.meta.url), "utf8");
const activityCore = readFileSync(new URL("../pi/extensions/activity-status/core.ts", import.meta.url), "utf8");
const workflows = readFileSync(new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url), "utf8");

test("live activity phases derive from concrete Pi runtime events", () => {
  for (const event of [
    "agent_start",
    "turn_start",
    "message_update",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "session_before_compact",
    "session_compact",
  ]) {
    assert.match(activity, new RegExp(`pi\\.on\\(\\"${event}\\"`));
  }
  assert.match(activityCore, /REASONING · model generation · no tools implied/);
  assert.match(activity, /CLASSIFIER · \$\{event\.boundary\} · model generation/);
  assert.match(activityCore, /SUBAGENT/);
  assert.match(activity, /COMPACTING/);
});

test("classifier status is emitted only around actual model classifier calls", () => {
  assert.match(workflows, /onActivity\?\.\(true\)/);
  assert.match(workflows, /finally \{\s*onActivity\?\.\(false\)/);
  assert.match(workflows, /pi\.events\.emit\(ACTIVITY_PHASE_EVENT, event\)/);
});
