import assert from "node:assert/strict"
import test from "node:test"
import { aggregateUsage, resolveContextPercent } from "./usage.ts"

test("cache hit rate is weighted across all assistant messages", () => {
  assert.deepEqual(
    aggregateUsage([
      { input: 10, output: 5, cacheRead: 90, cacheWrite: 0 },
      { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    ]),
    { inputTokens: 110, outputTokens: 25, cacheHitRate: 45 },
  )
})

test("cache hit rate stays unknown when there are no prompt tokens", () => {
  assert.deepEqual(aggregateUsage([]), {
    inputTokens: 0,
    outputTokens: 0,
    cacheHitRate: undefined,
  })
})

test("active assistant usage repairs a spurious host-reported zero context percentage", () => {
  assert.equal(
    resolveContextPercent(0, 100_000, [
      { input: 2_000, output: 500, cacheRead: 7_500, cacheWrite: 0 },
    ]),
    10,
  )
})

test("unknown post-compaction usage stays unknown and valid host percentages win", () => {
  const usages = [
    { input: 2_000, output: 500, cacheRead: 7_500, cacheWrite: 0 },
  ]
  assert.equal(resolveContextPercent(undefined, 100_000, usages), undefined)
  assert.equal(resolveContextPercent(12.5, 100_000, usages), 12.5)
  assert.equal(resolveContextPercent(0, 0, usages), 0)
  assert.equal(resolveContextPercent(0, 100_000, []), 0)
})
