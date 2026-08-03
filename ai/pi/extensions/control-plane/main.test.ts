import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"
import { REVIEW_DUTY_PROFILES } from "./job-runtime.ts"
import { parseControlPlaneConfig, seedReviewDutyScans } from "./main.ts"
import { makeSqliteJobStore } from "./sqlite-job-store.ts"

const codeOf = (value: unknown): string | undefined => {
  const result = Effect.runSync(Effect.either(parseControlPlaneConfig(value)))
  if (Either.isRight(result)) return undefined
  return result.left.code
}

test("control-plane config is loopback-only with a state-root database", () => {
  assert.deepEqual(
    Effect.runSync(
      parseControlPlaneConfig({
        HOME: "/Users/example",
        XDG_STATE_HOME: "/Users/example/state",
        PI_CONTROL_PLANE_PORT: "43121",
        PI_CONTROL_PLANE_DASHBOARD_DIR: "/nix/store/dashboard",
      }),
    ),
    {
      host: "127.0.0.1",
      port: 43_121,
      databasePath: "/Users/example/state/pi/control-plane/jobs.sqlite",
      dashboardDirectory: "/nix/store/dashboard",
    },
  )
  assert.deepEqual(
    Effect.runSync(parseControlPlaneConfig({ HOME: "/Users/example" })),
    {
      host: "127.0.0.1",
      port: 43_121,
      databasePath: "/Users/example/.local/state/pi/control-plane/jobs.sqlite",
    },
  )
})

test("startup seeds one live recurring scan job per review profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-control-plane-seed-test-"))
  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite")),
  )
  try {
    await Effect.runPromise(seedReviewDutyScans(store, 1_000))
    await Effect.runPromise(seedReviewDutyScans(store, 2_000))
    const jobs = await Effect.runPromise(store.list())
    assert.equal(jobs.length, REVIEW_DUTY_PROFILES.length)
    for (const profile of REVIEW_DUTY_PROFILES) {
      const job = jobs.find(
        (candidate) =>
          candidate.spec.kind === "review-duty.scan" &&
          candidate.spec.idempotencyKey === `review-duty:${profile}`,
      )
      assert.ok(job)
      assert.deepEqual(job.spec.recurrence, {
        baseMs: 7_200_000,
        jitterMs: 3_600_000,
      })
      assert.equal(job.spec.runAt, 1_000)
    }
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("control-plane config rejects malformed external environment values", () => {
  assert.equal(codeOf({}), "invalid_config")
  assert.equal(codeOf({ HOME: "relative" }), "invalid_config")
  assert.equal(
    codeOf({ HOME: "/Users/example", XDG_STATE_HOME: "relative" }),
    "invalid_config",
  )
  assert.equal(
    codeOf({
      HOME: "/Users/example",
      PI_CONTROL_PLANE_DASHBOARD_DIR: "relative",
    }),
    "invalid_config",
  )
  assert.equal(
    codeOf({ HOME: "/Users/example", PI_CONTROL_PLANE_PORT: "0" }),
    "invalid_config",
  )
  assert.equal(
    codeOf({ HOME: "/Users/example", PI_CONTROL_PLANE_PORT: "70000" }),
    "invalid_config",
  )
  assert.equal(
    codeOf({ HOME: "/Users/example", PI_CONTROL_PLANE_PORT: "not-a-port" }),
    "invalid_config",
  )
})
