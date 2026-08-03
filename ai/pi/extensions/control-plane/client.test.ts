import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"
import { makeControlPlaneClient } from "./client.ts"
import type { HarnessReviewHandoff } from "./harness-protocol.ts"
import { startControlPlaneServer } from "./server.ts"
import { makeSqliteJobStore } from "./sqlite-job-store.ts"

const withServer = async (
  run: (origin: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "pi-control-plane-client-test-"))
  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite")),
  )
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store }),
  )
  try {
    await run(server.origin)
  } finally {
    await Effect.runPromise(server.close)
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

const scanSpec = {
  kind: "review-duty.scan",
  payload: { profile: "st0x-review" },
  runAt: 0,
  maxAttempts: 3,
  recurrence: { baseMs: 7_200_000, jitterMs: 3_600_000 },
  idempotencyKey: "review-duty:st0x-review",
} as const

const headSha = "a".repeat(40)

const harnessSpec = {
  kind: "harness.review",
  payload: {
    lane: "cursor-subscription",
    task: "review-probe",
    model: "composer-2.5",
    profile: "personal-review",
    repository: "0xgleb/example",
    pullRequest: 7,
    kind: "own",
    inputHeadSha: headSha,
    repositoryRoot: "/Users/example/code/0xgleb/example",
    isolation: "read-only",
  },
  runAt: 0,
  maxAttempts: 2,
  idempotencyKey: "harness:personal:example:7",
} as const

test("the client round-trips scan jobs through claim, fail, and completion", async () =>
  withServer(async (origin) => {
    const client = makeControlPlaneClient(origin)
    const health = await Effect.runPromise(client.health())
    assert.equal(health.status, "ok")

    const enqueued = await Effect.runPromise(client.enqueue(scanSpec))
    assert.equal(enqueued.created, true)
    const duplicate = await Effect.runPromise(client.enqueue(scanSpec))
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.job.id, enqueued.job.id)

    const missed = await Effect.runPromise(
      client.claimDue({
        workerId: "st0x-supervisor",
        ttlMs: 90_000,
        idempotencyKeys: ["review-duty:personal-review"],
      }),
    )
    assert.equal(missed, undefined)

    const claimed = await Effect.runPromise(
      client.claimDue({
        workerId: "st0x-supervisor",
        ttlMs: 90_000,
        kinds: ["review-duty.scan"],
        idempotencyKeys: ["review-duty:st0x-review"],
      }),
    )
    assert.equal(claimed?.id, enqueued.job.id)
    assert.equal(claimed.state, "leased")
    if (claimed.state !== "leased") return

    const failed = await Effect.runPromise(
      client.fail(claimed.id, claimed.leaseToken, 0, "scan blocked"),
    )
    assert.equal(failed.state, "retry_wait")

    const reclaimed = await Effect.runPromise(
      client.claimDue({ workerId: "st0x-supervisor", ttlMs: 90_000 }),
    )
    assert.equal(reclaimed?.id, enqueued.job.id)
    if (reclaimed.state !== "leased") return
    const completed = await Effect.runPromise(
      client.complete(reclaimed.id, reclaimed.leaseToken, {
        summary: "scan complete",
      }),
    )
    assert.equal(completed.state, "succeeded")

    const jobs = await Effect.runPromise(client.list())
    assert.equal(jobs.length, 2)
  }))

test("the client completes harness jobs with typed handoffs", async () =>
  withServer(async (origin) => {
    const client = makeControlPlaneClient(origin)
    const enqueued = await Effect.runPromise(client.enqueue(harnessSpec))
    const claimed = await Effect.runPromise(
      client.claimDue({
        workerId: "harness-supervisor",
        ttlMs: 90_000,
        kinds: ["harness.review"],
      }),
    )
    assert.equal(claimed?.id, enqueued.job.id)
    if (claimed?.state !== "leased") return
    const handoff: HarnessReviewHandoff = {
      protocolVersion: 1,
      jobId: claimed.id,
      attempt: claimed.attempt,
      lane: "cursor-subscription",
      repository: "0xgleb/example",
      pullRequest: 7,
      inputHeadSha: headSha,
      outputHeadSha: headSha,
      status: "clean",
      assessment: "No verified findings.",
      evidence: ["check:review-core"],
      verifier: "fable-clean",
      executorProvenance: "subscription-verified",
    }
    const completed = await Effect.runPromise(
      client.complete(claimed.id, claimed.leaseToken, { handoff }),
    )
    assert.equal(completed.state, "succeeded")
  }))

test("the client surfaces rejections and malformed responses as typed errors", async () =>
  withServer(async (origin) => {
    const client = makeControlPlaneClient(origin)
    const invalidSpec = await Effect.runPromise(
      Effect.either(client.enqueue({ ...scanSpec, kind: "unregistered" })),
    )
    assert.equal(Either.isLeft(invalidSpec), true)
    if (Either.isLeft(invalidSpec))
      assert.equal(invalidSpec.left.code, "rejected")

    const staleComplete = await Effect.runPromise(
      Effect.either(
        client.complete("missing-job", "lease-x", { summary: "done" }),
      ),
    )
    assert.equal(Either.isLeft(staleComplete), true)

    const unreachable = makeControlPlaneClient("http://127.0.0.1:9")
    const failedRequest = await Effect.runPromise(
      Effect.either(unreachable.health()),
    )
    assert.equal(Either.isLeft(failedRequest), true)
    if (Either.isLeft(failedRequest))
      assert.equal(failedRequest.left.code, "request_failed")
  }))
