import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"
import { toJobId } from "./harness-protocol.ts"
import { decodeStoredJob, type Job } from "./job-runtime.ts"
import { canonicalPath } from "./review-duty-profile.ts"
import {
  legacyAgentopsResearchJobs,
  reconcileLegacyAgentopsResearchJobs,
} from "./research-ownership.ts"
import { makeSqliteJobStore } from "./sqlite-job-store.ts"

const legacyResearch = (
  id: string,
  profile: string,
  state: "ready" | "leased" | "succeeded",
): Job => {
  const jobId = toJobId(id)
  assert.ok(jobId !== undefined)

  const base = {
    id: jobId,
    spec: {
      kind: "harness.research" as const,
      payload: {
        lane: "subscription-plan" as const,
        harness: "claude-plan",
        profile,
        project: "yielduck",
        task: "bounded-task",
        repositoryRoot: "/Users/example/yielduck",
        isolation: "read-only" as const,
      },
      runAt: 1,
      maxAttempts: 2,
    },
    attempt: state === "ready" ? 0 : 1,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
  if (state === "ready") return { ...base, state }
  if (state === "leased")
    return {
      ...base,
      state,
      workerId: "legacy-worker",
      leaseToken: "legacy-token",
      leaseUntil: 10_000,
    }
  return {
    ...base,
    state,
    finishedAt: 1_000,
    summary: "historical result",
  }
}

test("stored research history rejects result data not supported by its job kind", async () => {
  const history = legacyResearch(
    "legacy-history",
    "agentops-yielduck",
    "succeeded",
  )

  assert.deepEqual(await Effect.runPromise(decodeStoredJob(history)), history)

  const result = await Effect.runPromise(
    Effect.either(
      decodeStoredJob({
        ...history,
        result: {
          kind: "harness.research",
          handoff: {
            protocolVersion: 1,
            jobId: history.id,
            attempt: 1,
            lane: "subscription-plan",
            profile: "agentops-yielduck",
            task: "bounded-task",
            status: "completed",
            summary: "historical result",
            evidence: ["bounded evidence"],
          },
        },
      }),
    ),
  )

  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "invalid_input")
  assert.match(result.left.message, /result is not valid for this job kind/u)
})

test("legacy agentops research reconciliation cancels only active mislabeled jobs", async () => {
  const jobs = [
    legacyResearch("legacy-ready", "agentops-yielduck", "ready"),
    legacyResearch("legacy-leased", "agentops-yielduck", "leased"),
    legacyResearch("legacy-history", "agentops-yielduck", "succeeded"),
    legacyResearch("project-ready", "yielduck-research", "ready"),
  ]
  assert.deepEqual(
    legacyAgentopsResearchJobs(jobs).map(({ id }) => id),
    ["legacy-ready", "legacy-leased"],
  )

  const root = await mkdtemp(join(tmpdir(), "pi-research-ownership-test-"))

  const home = canonicalPath(root)
  assert.ok(home !== undefined)

  const ready = jobs[0]
  assert.ok(ready)

  const leased = jobs[1]
  assert.ok(leased)

  const project = jobs[3]
  assert.ok(project)

  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite"), home),
  )
  try {
    await Effect.runPromise(store.enqueue(leased.spec, "legacy-leased", 1_000))
    await Effect.runPromise(
      store.claimDueResearch(
        "agentops-yielduck",
        "legacy-worker",
        "legacy-token",
        1_000,
        9_000,
      ),
    )
    await Effect.runPromise(store.enqueue(ready.spec, "legacy-ready", 1_001))
    await Effect.runPromise(store.enqueue(project.spec, "project-ready", 1_001))

    const result = await Effect.runPromise(
      reconcileLegacyAgentopsResearchJobs(store, 2_000),
    )
    assert.deepEqual(result, {
      cancelled: ["legacy-ready", "legacy-leased"],
    })
    const cancelledReady = await Effect.runPromise(store.get("legacy-ready"))
    assert.equal(cancelledReady.state, "cancelled")
    const cancellationRequested = await Effect.runPromise(
      store.get("legacy-leased"),
    )
    assert.equal(cancellationRequested.state, "leased")
    assert.equal(
      cancellationRequested.state === "leased"
        ? cancellationRequested.cancelRequestedAt
        : undefined,
      2_000,
    )
    assert.equal(
      (await Effect.runPromise(store.get("project-ready"))).state,
      "ready",
    )

    assert.deepEqual(
      await Effect.runPromise(
        reconcileLegacyAgentopsResearchJobs(store, 3_000),
      ),
      { cancelled: ["legacy-leased"] },
    )
    const unchangedCancellation = await Effect.runPromise(
      store.get("legacy-leased"),
    )
    assert.equal(unchangedCancellation.updatedAt, 2_000)

    assert.deepEqual(
      await Effect.runPromise(
        reconcileLegacyAgentopsResearchJobs(store, 11_000),
      ),
      { cancelled: ["legacy-leased"] },
    )
    const terminalCancellation = await Effect.runPromise(
      store.get("legacy-leased"),
    )
    assert.equal(terminalCancellation.state, "cancelled")
    assert.equal(
      terminalCancellation.state === "cancelled"
        ? terminalCancellation.finishedAt
        : undefined,
      11_000,
    )
    assert.equal(
      (await Effect.runPromise(store.get("project-ready"))).state,
      "ready",
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
