import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import type { HarnessLaunchPlan } from "./harness-adapter.ts"
import {
  toCommitSha,
  toJobId,
  type HarnessReviewHandoff,
} from "./harness-protocol.ts"
import { canonicalPath, type CanonicalPath } from "./review-duty-profile.ts"
import { decodeStoredJob, jobResult, type Job } from "./job-runtime.ts"
import {
  HarnessWorkerError,
  runNextHarnessAttempt,
  spawnHarnessExecutor,
  type HarnessSpawner,
  type HarnessWorkerOptions,
} from "./harness-worker.ts"
import { startControlPlaneServer } from "./server.ts"
import { makeSqliteJobStore, type SqliteJobStore } from "./sqlite-job-store.ts"

const canonical = (value: string): CanonicalPath => {
  const path = canonicalPath(value)
  assert.ok(path !== undefined, `invalid fixture path: ${value}`)
  return path
}

const commit = (value: string) => {
  const sha = toCommitSha(value)
  assert.ok(sha !== undefined, `invalid fixture commit: ${value}`)
  return sha
}

const fixtureJobId = (value: string) => {
  const id = toJobId(value)
  assert.ok(id !== undefined, `invalid fixture job id: ${value}`)
  return id
}

const withServer = async (
  run: (origin: string, store: SqliteJobStore, home: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-worker-test-"))
  const home = canonical(join(root, "home"))
  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite"), home),
  )
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store, home }),
  )
  try {
    await run(server.origin, store, home)
  } finally {
    await Effect.runPromise(server.close)
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

const headSha = commit("a".repeat(40))

const harnessEnqueueBody = (home: string) => ({
  kind: "harness.review",
  payload: {
    lane: "claude-code-max",
    task: "review-loop",
    profile: "personal-review",
    repository: "0xgleb/example",
    pullRequest: 7,
    kind: "own",
    inputHeadSha: headSha,
    repositoryRoot: `${home}/code/0xgleb/example`,
    isolation: "approved-worktree",
  },
  runAt: 0,
  maxAttempts: 2,
  idempotencyKey: "harness:personal:example:7:head",
})

const responseJob = async (response: Response): Promise<Job> => {
  const body: unknown = await response.json()
  assert.ok(typeof body === "object" && body !== null && "job" in body)
  return Effect.runPromise(decodeStoredJob(body.job))
}

const enqueueHarnessJob = async (
  origin: string,
  home: string,
): Promise<string> => {
  const response = await fetch(`${origin}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(harnessEnqueueBody(home)),
  })
  assert.equal(response.status, 201)
  return (await responseJob(response)).id
}

const handoffFor = (
  jobId: string,
  overrides: Partial<HarnessReviewHandoff> = {},
): HarnessReviewHandoff => ({
  protocolVersion: 1,
  jobId: fixtureJobId(jobId),
  attempt: 1,
  lane: "claude-code-max",
  repository: "0xgleb/example",
  pullRequest: 7,
  inputHeadSha: headSha,
  outputHeadSha: headSha,
  status: "clean",
  assessment: "No verified findings.",
  evidence: ["check:review-core"],
  verifier: "fable-clean",
  executorProvenance: "subscription-verified",
  ...overrides,
})

const stubSpawner =
  (
    execution: (plan: HarnessLaunchPlan) => HarnessExecutionResult,
    calls: HarnessLaunchPlan[] = [],
  ): HarnessSpawner =>
  plan => {
    calls.push(plan)
    const result = execution(plan)
    return result.kind === "spawned"
      ? Effect.succeed({ exitCode: result.exitCode, stdout: result.stdout })
      : Effect.fail(
          new HarnessWorkerError({
            code: "executor_failed",
            message: result.message,
          }),
        )
  }

type HarnessExecutionResult =
  | {
      readonly kind: "spawned"
      readonly exitCode: number
      readonly stdout: string
    }
  | { readonly kind: "spawn_error"; readonly message: string }

const workerOptions = (
  origin: string,
  home: string,
  spawner: HarnessSpawner,
): HarnessWorkerOptions => ({
  origin,
  workerId: "harness-supervisor",
  leaseTtlMs: 90_000,
  retryDelayMs: 0,
  allowedRoots: [`${home}/code/0xgleb/example`],
  home: canonical(home),
  spawner,
})

const jobState = async (origin: string, jobId: string): Promise<Job> => {
  const response = await fetch(`${origin}/v1/jobs`)
  const body: unknown = await response.json()
  assert.ok(typeof body === "object" && body !== null && "jobs" in body)
  assert.ok(Array.isArray(body.jobs))
  const documents: readonly unknown[] = body.jobs
  const jobs = await Effect.runPromise(
    Effect.forEach(documents, decodeStoredJob),
  )
  const job = jobs.find(candidate => candidate.id === jobId)
  assert.ok(job)
  return job
}

test("an empty queue leaves the worker idle without spawning", async () =>
  withServer(async (origin, store, home) => {
    const calls: HarnessLaunchPlan[] = []
    const outcome = await Effect.runPromise(
      runNextHarnessAttempt(
        workerOptions(
          origin,
          home,
          stubSpawner(
            () => ({ kind: "spawned", exitCode: 0, stdout: "" }),
            calls,
          ),
        ),
      ),
    )
    assert.deepEqual(outcome, { outcome: "idle" })
    assert.equal(calls.length, 0)
  }))

test("a matching executor handoff completes the claimed harness job", async () =>
  withServer(async (origin, store, home) => {
    const jobId = await enqueueHarnessJob(origin, home)
    const calls: HarnessLaunchPlan[] = []
    const outcome = await Effect.runPromise(
      runNextHarnessAttempt(
        workerOptions(
          origin,
          home,
          stubSpawner(
            () => ({
              kind: "spawned",
              exitCode: 0,
              stdout: `progress line\n${JSON.stringify(handoffFor(jobId))}\n`,
            }),
            calls,
          ),
        ),
      ),
    )
    assert.deepEqual(outcome, { outcome: "completed", jobId })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.lane, "claude-code-max")
    const persisted = await jobState(origin, jobId)
    assert.equal(persisted.state, "succeeded")
    assert.equal(jobResult(persisted)?.handoff.jobId, jobId)
  }))

test("blocked handoffs fail the attempt instead of completing the job", async () =>
  withServer(async (origin, store, home) => {
    const jobId = await enqueueHarnessJob(origin, home)
    const outcome = await Effect.runPromise(
      runNextHarnessAttempt(
        workerOptions(
          origin,
          home,
          stubSpawner(() => ({
            kind: "spawned",
            exitCode: 0,
            stdout: JSON.stringify(
              handoffFor(jobId, {
                status: "blocked",
                verifier: "unavailable",
                evidence: [],
                assessment: "Subscription auth is unavailable.",
              }),
            ),
          })),
        ),
      ),
    )
    assert.equal(outcome.outcome, "failed")
    const persisted = await jobState(origin, jobId)
    assert.equal(persisted.state, "retry_wait")
  }))

test("mismatched, malformed, and oversized executor output fails the attempt", async () => {
  const cases: ReadonlyArray<(jobId: string) => string> = [
    jobId =>
      JSON.stringify(
        handoffFor(jobId, { inputHeadSha: commit("b".repeat(40)) }),
      ),
    () => "not json at all",
    jobId => JSON.stringify({ ...handoffFor(jobId), prompt: "leaked" }),
    jobId => `${JSON.stringify(handoffFor(jobId))}${" ".repeat(70_000)}x`,
    () => `progress\n${"x".repeat(9_000)}`,
    () => `progress\n${"\u{1F389}".repeat(3_000)}`,
  ]
  for (const buildOutput of cases)
    await withServer(async (origin, store, home) => {
      const jobId = await enqueueHarnessJob(origin, home)
      const outcome = await Effect.runPromise(
        runNextHarnessAttempt(
          workerOptions(
            origin,
            home,
            stubSpawner(() => ({
              kind: "spawned",
              exitCode: 0,
              stdout: buildOutput(jobId),
            })),
          ),
        ),
      )
      assert.equal(outcome.outcome, "failed")
      const persisted = await jobState(origin, jobId)
      assert.equal(persisted.state, "retry_wait")
    })
})

test("spawn errors and nonzero exits fail the attempt within retry policy", async () =>
  withServer(async (origin, store, home) => {
    const jobId = await enqueueHarnessJob(origin, home)
    const first = await Effect.runPromise(
      runNextHarnessAttempt(
        workerOptions(
          origin,
          home,
          stubSpawner(() => ({
            kind: "spawn_error",
            message: "executable is unavailable",
          })),
        ),
      ),
    )
    assert.equal(first.outcome, "failed")
    assert.equal((await jobState(origin, jobId)).state, "retry_wait")

    const second = await Effect.runPromise(
      runNextHarnessAttempt(
        workerOptions(
          origin,
          home,
          stubSpawner(() => ({ kind: "spawned", exitCode: 1, stdout: "" })),
        ),
      ),
    )
    assert.equal(second.outcome, "failed")
    assert.equal((await jobState(origin, jobId)).state, "failed")
  }))

test("non-harness jobs are never claimed or executed by the harness worker", async () =>
  withServer(async (origin, store, home) => {
    const response = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "review-duty.scan",
        payload: { profile: "st0x-review" },
        runAt: 0,
        maxAttempts: 3,
        recurrence: { baseMs: 7_200_000, jitterMs: 3_600_000 },
        idempotencyKey: "review-duty:st0x-review",
      }),
    })
    assert.equal(response.status, 201)
    const jobId = (await responseJob(response)).id
    const calls: HarnessLaunchPlan[] = []
    const outcome = await Effect.runPromise(
      runNextHarnessAttempt(
        workerOptions(
          origin,
          home,
          stubSpawner(
            () => ({ kind: "spawned", exitCode: 0, stdout: "" }),
            calls,
          ),
        ),
      ),
    )
    assert.deepEqual(outcome, { outcome: "idle" })
    assert.equal(calls.length, 0)
    assert.equal((await jobState(origin, jobId)).state, "ready")
  }))

test("payload roots outside the registered workspaces fail before any spawn", async () =>
  withServer(async (origin, store, home) => {
    // The enqueue boundary binds harness payloads to checkouts registered
    // under the stated home, so a root outside them is refused before the
    // store ever sees a job.
    const response = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...harnessEnqueueBody(home),
        payload: {
          ...harnessEnqueueBody(home).payload,
          repositoryRoot: "/tmp/example",
        },
        idempotencyKey: "harness:personal:example:outside",
      }),
    })
    assert.equal(response.status, 400)
    const calls: HarnessLaunchPlan[] = []
    const outcome = await Effect.runPromise(
      runNextHarnessAttempt(
        workerOptions(
          origin,
          home,
          stubSpawner(
            () => ({ kind: "spawned", exitCode: 0, stdout: "" }),
            calls,
          ),
        ),
      ),
    )
    assert.equal(outcome.outcome, "idle")
    assert.equal(calls.length, 0)
  }))

test("malformed control-plane claim responses surface as typed request failures", async () => {
  const { createServer } = await import("node:http")
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({ job: { id: "job-a", attempt: "not-a-number" } }),
    )
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  try {
    const result = await Effect.runPromise(
      Effect.either(
        runNextHarnessAttempt(
          workerOptions(
            `http://127.0.0.1:${String(address.port)}`,
            "/Users/example",
            stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" })),
          ),
        ),
      ),
    )
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") {
      assert.equal(result.left.code, "request_failed")
      assert.equal(result.left.message, "claimed job payload is malformed")
    }
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
  }
})

const executionPlan = (argv: readonly string[]): HarnessLaunchPlan => ({
  lane: "claude-code-max",
  cwd: canonical(tmpdir()),
  argv,
  environmentAllowlist: [],
})

test("the process spawner captures bounded stdout and exit codes", async () => {
  const spawner = spawnHarnessExecutor(10_000)
  const succeeded = await Effect.runPromise(
    spawner(executionPlan(["node", "-e", "console.log('handoff-line')"])),
  )
  assert.equal(succeeded.exitCode, 0)
  assert.equal(succeeded.stdout.includes("handoff-line"), true)

  const failed = await Effect.runPromise(
    spawner(executionPlan(["node", "-e", "process.exit(3)"])),
  )
  assert.equal(failed.exitCode, 3)
})

test("the process spawner kills executors whose output overflows the byte bound", async () => {
  const overflowed = await Effect.runPromise(
    Effect.either(
      spawnHarnessExecutor(30_000)(
        executionPlan([
          "node",
          "-e",
          "process.stdout.write('x'.repeat(200000))",
        ]),
      ),
    ),
  )
  assert.equal(overflowed._tag, "Left")
  if (overflowed._tag === "Left")
    assert.equal(overflowed.left.message, "executor output exceeded bounds")
})

test("the process spawner kills timed-out and unavailable executors", async () => {
  const timedOut = await Effect.runPromise(
    Effect.either(
      spawnHarnessExecutor(200)(
        executionPlan(["node", "-e", "setTimeout(() => {}, 60_000)"]),
      ),
    ),
  )
  assert.equal(timedOut._tag, "Left")

  const unavailable = await Effect.runPromise(
    Effect.either(
      spawnHarnessExecutor(1_000)(
        executionPlan(["pi-harness-missing-executable"]),
      ),
    ),
  )
  assert.equal(unavailable._tag, "Left")
})
