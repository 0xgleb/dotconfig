import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("critical memory incidents steer the active session instead of waiting passively", () => {
  assert.match(source, /customType: "resource-pressure\.incident"/);
  assert.match(source, /triggerTurn: true, deliverAs: "steer"/);
  assert.match(source, /This is an actionable incident, not a passive warning/);
  assert.match(source, /Bounded RSS aggregate \(command names only; no arguments\)/);
});
