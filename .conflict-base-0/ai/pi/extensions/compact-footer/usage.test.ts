import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage } from "./usage.ts";

test("cache hit rate is weighted across all assistant messages", () => {
  assert.deepEqual(
    aggregateUsage([
      { input: 10, output: 5, cacheRead: 90, cacheWrite: 0 },
      { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    ]),
    { inputTokens: 110, outputTokens: 25, cacheHitRate: 45 },
  );
});

test("cache hit rate stays unknown when there are no prompt tokens", () => {
  assert.deepEqual(aggregateUsage([]), {
    inputTokens: 0,
    outputTokens: 0,
    cacheHitRate: undefined,
  });
});
