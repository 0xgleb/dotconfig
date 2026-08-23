import assert from "node:assert/strict"
import test from "node:test"
import {
  availableMemoryBytes,
  parseMemoryPressureCapacity,
} from "./memory-capacity.ts"

const pressureOutput = (availablePercent: number): string =>
  [
    "The system has 51539607552 (3145728 pages with a page size of 16384).",
    `System-wide memory free percentage: ${availablePercent}%`,
  ].join("\n")

test("macOS available memory includes reclaimable capacity from memory_pressure", () => {
  assert.equal(
    availableMemoryBytes({
      platform: "darwin",
      memoryPressureProbe: () => ({ status: 0, stdout: pressureOutput(91) }),
    }),
    46_901_042_872n,
  )
})

test("non-macOS available memory uses the operating system free-memory probe", () => {
  assert.equal(
    availableMemoryBytes({
      platform: "linux",
      freeMemoryBytes: () => 5_583_457_280,
    }),
    5_583_457_280n,
  )
})

test("macOS available-memory failures fail closed", () => {
  assert.throws(
    () =>
      availableMemoryBytes({
        platform: "darwin",
        memoryPressureProbe: () => ({ status: 1, stdout: "" }),
      }),
    /probe failed/,
  )
  assert.throws(
    () =>
      availableMemoryBytes({
        platform: "darwin",
        memoryPressureProbe: () => ({ status: 0, stdout: "unknown output" }),
      }),
    /unknown format/,
  )
  assert.equal(parseMemoryPressureCapacity("unknown output"), undefined)
})
