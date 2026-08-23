import assert from "node:assert/strict"
import test from "node:test"
import { compactionVisual } from "./visual.ts"

test("safe compaction causes use distinct glanceable backgrounds", () => {
  const manual = compactionVisual("manual", "preparing")
  const threshold = compactionVisual("threshold", "preparing")
  const overflow = compactionVisual("overflow", "resuming")

  assert.equal(
    new Set([manual.background, threshold.background, overflow.background])
      .size,
    3,
  )
  assert.match(manual.label, /manual request/i)
  assert.match(threshold.label, /context limit/i)
  assert.match(overflow.label, /context overflow/i)
  assert.match(manual.heading, /checkpoint/i)
  assert.match(overflow.heading, /restored/i)
})
