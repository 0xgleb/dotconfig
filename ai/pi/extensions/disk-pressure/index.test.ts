import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const classifiedSource = readFileSync(new URL("../classified-workflows/index.ts", import.meta.url), "utf8");
const capacitySource = readFileSync(new URL("../shared/memory-capacity.ts", import.meta.url), "utf8");

test("macOS capacity uses the shared pressure-aware provider instead of raw free pages", () => {
  assert.match(source, /import \{ availableMemoryBytes \} from "\.\.\/shared\/memory-capacity\.ts"/);
  assert.match(source, /availableMemoryBytes\(\)/);
  assert.doesNotMatch(source, /\bfreemem\b/);
  assert.match(capacitySource, /memory_pressure", \["-Q"\]/);
  assert.match(capacitySource, /parseMemoryPressureCapacity\(result\.stdout\)/);
  assert.match(source, /only.*available.*reserve/is);
});

test("critical memory incidents steer the active session instead of waiting passively", () => {
  assert.match(source, /customType: "resource-pressure\.incident"/);
  assert.match(source, /triggerTurn: true, deliverAs: "steer"/);
  assert.match(source, /This is an actionable incident, not a passive warning/);
  assert.match(source, /Bounded RSS aggregate \(command names only; no arguments\)/);
});

test("classified expensive commands use a fresh authoritative resource preflight", () => {
  assert.match(source, /RESOURCE_PREFLIGHT_REQUEST_EVENT/);
  assert.match(source, /resourcePressureSnapshot/);
  assert.match(classifiedSource, /RESOURCE_PREFLIGHT_REQUEST_EVENT/);
  assert.match(classifiedSource, /resourcePreflightDisprovesBlock/);
});
