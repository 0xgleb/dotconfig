import assert from "node:assert/strict"
import test from "node:test"
import type { Job } from "./job-runtime.ts"
import { jobSchedulePresentation } from "./job-presentation.ts"

const baseJob = {
  id: "job-a",
  spec: {
    kind: "review-duty.scan" as const,
    payload: { profile: "st0x-review" as const },
    runAt: 8,
    maxAttempts: 2,
  },
  state: "ready" as const,
  attempt: 0,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
} satisfies Job

test("job schedule presentation rejects implausible legacy timestamps", () => {
  assert.deepEqual(jobSchedulePresentation(baseJob, 1_800_000_000_000), {
    label: "Run",
    value: "Invalid schedule",
    stale: true,
  })
})

test("terminal jobs show completion age instead of obsolete run age", () => {
  const finishedAt = 1_800_000_000_000 - 3_600_000
  const terminal = {
    ...baseJob,
    state: "succeeded" as const,
    attempt: 1,
    updatedAt: finishedAt,
    finishedAt,
    summary: "scan complete",
  } satisfies Job
  assert.deepEqual(jobSchedulePresentation(terminal, 1_800_000_000_000), {
    label: "Finished",
    value: "1h ago",
    stale: false,
  })
})
