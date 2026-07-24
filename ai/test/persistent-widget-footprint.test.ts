import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

const widgetCalls = (source: string, key: string): string[] =>
  source.split("\n").filter((line) => line.includes(`setWidget(${key}`));

const assertOnlyClearsPersistentWidget = (source: string, key: string): void => {
  const calls = widgetCalls(source, key);
  assert.ok(calls.length > 0, `expected at least one ${key} widget cleanup`);
  assert.equal(
    calls.every((line) => line.includes("undefined")),
    true,
    `${key} must never render persistent multi-line content`,
  );
};

test("persistent detail stays out of the editor while the bounded task HUD remains visible", () => {
  const workflows = read("../pi/extensions/classified-workflows/index.ts");
  const todos = read("../pi/extensions/todo/index.ts");
  const todoPresentation = read("../pi/extensions/todo/presentation.ts");
  const registry = read("../pi/extensions/agent-registry/index.ts");

  assert.match(todos, /taskHudLines\(state\)/);
  assert.match(todos, /placement: "aboveEditor"/);
  assert.match(todoPresentation, /TASK\/\/GRID/);
  assertOnlyClearsPersistentWidget(workflows, '"pi-loop",');
  assertOnlyClearsPersistentWidget(workflows, '"pi-goal",');
  assertOnlyClearsPersistentWidget(registry, "STATUS_KEY,");

  assert.match(todos, /setStatus\("todo"/);
  assert.match(workflows, /setStatus\("pi-loop"/);
  assert.match(workflows, /setStatus\("pi-goal"/);
  assert.match(registry, /setStatus\(STATUS_KEY/);

  assert.match(todos, /registerCommand\("kanban"/);
  assert.match(workflows, /registerCommand\("loop"/);
  assert.match(workflows, /registerCommand\("goal"/);
  assert.match(registry, /registerCommand\("agents"/);
});
