import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Fiber } from "effect"
import {
  toCanonicalWorkspaceRoot,
  type HarnessLaunchPlan,
  type RegisteredWorkspaceRoots,
} from "./harness-adapter.ts"
import {
  LAUNCH_ENVIRONMENT_ALLOWLIST,
  type LaunchEnvironment,
} from "./harness-launch.ts"
import {
  toCommitSha,
  toJobId,
  type CommitSha,
  type HarnessReviewHandoff,
  type JobId,
} from "./harness-protocol.ts"
import {
  harnessWorkerOptions,
  HarnessWorkerError,
  runNextHarnessAttempt,
  spawnHarnessExecutor,
  type HarnessAttemptOutcome,
  type HarnessSpawner,
} from "./harness-worker.ts"
import { canonicalPath, type CanonicalPath } from "./review-duty-profile.ts"
import { startControlPlaneServer } from "./server.ts"
import { makeSqliteJobStore, type SqliteJobStore } from "./sqlite-job-store.ts"

const canonical = (value: string): CanonicalPath => {
  const path = canonicalPath(value)
  if (path === undefined) throw new Error(`fixture is not canonical: ${value}`)
  return path
}

const commit = (value: string): CommitSha => {
  const sha = toCommitSha(value)
  if (sha === undefined) throw new Error(`fixture is not a commit sha: ${value}`)
  return sha
}

const jobIdentifier = (value: string): JobId => {
  const id = toJobId(value)
  if (id === undefined)
    throw new Error(`fixture is not a job identifier: ${value}`)
  return id
}

const workspaceRoot = (value: string): RegisteredWorkspaceRoots => {
  const root = toCanonicalWorkspaceRoot(value)
  if (root === undefined)
    throw new Error(`fixture is not a workspace root: ${value}`)
  return [root]
}

/**
 * The home the fixtures' checkout is registered under. It is stated here
 * rather than read from the machine, so the payloads below name a registered
 * checkout no matter which account runs the suite.
 */
const home = canonical("/Users/example")

const registeredCheckout = `${home}/code/0xgleb/example`

const environment: LaunchEnvironment = {
  HOME: home,
  PATH: "/usr/bin:/bin",
  ANTHROPIC_API_KEY: "sk-ant-provider-secret",
}

const withServer = async (
  run: (origin: string, store: SqliteJobStore) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-worker-test-"))
  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite"), home),
  )
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store, home }),
  )
  try {
    await run(server.origin, store)
  } finally {
    await Effect.runPromise(server.close)
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

const headSha = commit("a".repeat(40))

const harnessEnqueueBody = {
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
    repositoryRoot: registeredCheckout,
    isolation: "read-only",
  },
  runAt: 0,
  maxAttempts: 2,
  idempotencyKey: "harness:personal:example:7:head",
}

const enqueueHarnessJob = async (
  origin: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<JobId> => {
  const response = await fetch(`${origin}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...harnessEnqueueBody, ...overrides }),
  })
  assert.equal(response.status, 201)
  return jobIdentifier(
    ((await response.json()) as { job: { id: string } }).job.id,
  )
}

const handoffFor = (
  jobId: JobId,
  overrides: Partial<HarnessReviewHandoff> = {},
): HarnessReviewHandoff => ({
  protocolVersion: 1,
  jobId,
  attempt: 1,
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
  ...overrides,
})

type HarnessExecutionResult =
  | {
      readonly kind: "spawned"
      readonly exitCode: number
      readonly stdout: string
      readonly stderr?: string
    }
  | { readonly kind: "spawn_error"; readonly message: string }

/**
 * A spawner whose recording is part of the effect it returns rather than of
 * the call that built it, so an attempt that describes a launch without
 * running it records nothing.
 */
const stubSpawner = (
  execution: (plan: HarnessLaunchPlan) => HarnessExecutionResult,
  calls: HarnessLaunchPlan[] = [],
): HarnessSpawner =>
  (plan) =>
    Effect.suspend(() => {
      calls.push(plan)
      const result = execution(plan)
      return result.kind === "spawned"
        ? Effect.succeed({
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr ?? "",
          })
        : Effect.fail(
            new HarnessWorkerError({
              code: "executor_failed",
              message: result.message,
            }),
          )
    })

const workerOptions = (
  origin: string,
  spawner: HarnessSpawner,
  allowedRoots: RegisteredWorkspaceRoots = workspaceRoot(registeredCheckout),
) =>
  harnessWorkerOptions({
    origin,
    workerId: "harness-supervisor",
    leaseTtlMs: 90_000,
    executorTimeoutMs: 30_000,
    retryDelayMs: 0,
    allowedRoots,
    home,
    environment,
    spawner: () => spawner,
  })

const runAttempt = (
  origin: string,
  spawner: HarnessSpawner,
  allowedRoots?: RegisteredWorkspaceRoots,
): Promise<HarnessAttemptOutcome> =>
  Effect.runPromise(
    Effect.flatMap(
      workerOptions(origin, spawner, allowedRoots),
      runNextHarnessAttempt,
    ),
  )

interface PersistedJob {
  readonly state: string
  readonly lastAttemptSummary?: string
  readonly summary?: string
  readonly result?: { readonly handoff: { jobId: string; status: string } }
}

const jobState = async (
  origin: string,
  jobId: JobId,
): Promise<PersistedJob> => {
  const response = await fetch(`${origin}/v1/jobs`)
  const jobs = (await response.json()) as {
    jobs: (PersistedJob & { readonly id: string })[]
  }
  const job = jobs.jobs.find((candidate) => candidate.id === jobId)
  assert.ok(job)
  return job
}

test("an empty queue leaves the worker idle without spawning", async () =>
  withServer(async (origin) => {
    const calls: HarnessLaunchPlan[] = []
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" }), calls),
    )
    assert.deepEqual(outcome, { outcome: "idle" })
    assert.equal(calls.length, 0)
  }))

test("a matching executor handoff completes the claimed harness job", async () =>
  withServer(async (origin) => {
    const jobId = await enqueueHarnessJob(origin)
    const calls: HarnessLaunchPlan[] = []
    const outcome = await runAttempt(
      origin,
      stubSpawner(
        () => ({
          kind: "spawned",
          exitCode: 0,
          stdout: `progress line\n${JSON.stringify(handoffFor(jobId))}\n`,
        }),
        calls,
      ),
    )
    assert.deepEqual(outcome, { outcome: "completed", jobId })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.lane, "cursor-subscription")
    const persisted = await jobState(origin, jobId)
    assert.equal(persisted.state, "succeeded")
    assert.equal(persisted.result?.handoff.jobId, jobId)
  }))

test("a blocked handoff ends the attempt with its evidence kept", async () =>
  withServer(async (origin) => {
    const jobId = await enqueueHarnessJob(origin, { maxAttempts: 1 })
    const outcome = await runAttempt(
      origin,
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
    )
    assert.deepEqual(outcome, {
      outcome: "failed",
      jobId,
      reason: "harness blocked: Subscription auth is unavailable.",
    })
    const persisted = await jobState(origin, jobId)
    assert.equal(persisted.state, "failed")
    assert.equal(persisted.result?.handoff.status, "blocked")
    assert.equal(
      persisted.summary,
      "harness blocked: Subscription auth is unavailable.",
    )
  }))

test("a blocked handoff with retries left keeps its evidence on the retry", async () =>
  withServer(async (origin) => {
    const jobId = await enqueueHarnessJob(origin)
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({
        kind: "spawned",
        exitCode: 0,
        stdout: JSON.stringify(
          handoffFor(jobId, {
            status: "failed",
            verifier: "fable-rejected",
            evidence: [],
            assessment: "The executor could not finish the review.",
          }),
        ),
      })),
    )
    assert.equal(outcome.outcome, "failed")
    const persisted = await jobState(origin, jobId)
    assert.equal(persisted.state, "retry_wait")
    assert.equal(
      persisted.lastAttemptSummary,
      "harness failed: The executor could not finish the review.",
    )
  }))

test("mismatched, malformed, and oversized executor output fails the attempt", async () => {
  const cases: ReadonlyArray<{
    readonly output: (jobId: JobId) => string
    readonly summary: string
  }> = [
    {
      output: (jobId) =>
        JSON.stringify(
          handoffFor(jobId, { inputHeadSha: commit("b".repeat(40)) }),
        ),
      summary: "executor handoff does not match the attempt: input-head",
    },
    {
      output: () => "not json at all",
      summary: "executor handoff is not valid JSON",
    },
    {
      output: (jobId) => JSON.stringify({ ...handoffFor(jobId), prompt: "leaked" }),
      summary: "executor handoff is malformed",
    },
    {
      output: (jobId) =>
        `${JSON.stringify(handoffFor(jobId))}${" ".repeat(70_000)}x`,
      summary: "executor output exceeded bounds",
    },
    {
      output: () => `progress\n${"x".repeat(9_000)}`,
      summary: "executor returned no bounded handoff line",
    },
    {
      output: () => `progress\n${"\u{1F389}".repeat(3_000)}`,
      summary: "executor returned no bounded handoff line",
    },
  ]
  for (const testCase of cases)
    await withServer(async (origin) => {
      const jobId = await enqueueHarnessJob(origin)
      const outcome = await runAttempt(
        origin,
        stubSpawner(() => ({
          kind: "spawned",
          exitCode: 0,
          stdout: testCase.output(jobId),
        })),
      )
      assert.deepEqual(outcome, {
        outcome: "failed",
        jobId,
        reason: testCase.summary,
      })
      const persisted = await jobState(origin, jobId)
      assert.equal(persisted.state, "retry_wait")
      assert.equal(persisted.lastAttemptSummary, testCase.summary)
    })
})

test("a spawn error fails the attempt within retry policy", async () =>
  withServer(async (origin) => {
    const jobId = await enqueueHarnessJob(origin)
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({
        kind: "spawn_error",
        message: "executable is unavailable",
      })),
    )
    assert.deepEqual(outcome, {
      outcome: "failed",
      jobId,
      reason: "executable is unavailable",
    })
    const persisted = await jobState(origin, jobId)
    assert.equal(persisted.state, "retry_wait")
    assert.equal(persisted.lastAttemptSummary, "executable is unavailable")
  }))

test("a nonzero exit reports a bounded prefix of what the executor said", async () =>
  withServer(async (origin) => {
    const jobId = await enqueueHarnessJob(origin, {
      maxAttempts: 1,
      idempotencyKey: "harness:personal:example:7:exit",
    })
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({
        kind: "spawned",
        exitCode: 1,
        stdout: "ignored progress",
        stderr: `subscription auth expired\n${"detail ".repeat(200)}`,
      })),
    )
    assert.equal(outcome.outcome, "failed")
    const persisted = await jobState(origin, jobId)
    assert.equal(persisted.state, "failed")
    const summary = persisted.summary ?? ""
    assert.equal(
      summary.startsWith("executor exited with code 1: subscription auth expired detail"),
      true,
    )
    assert.equal(summary.includes("ignored progress"), false)
    assert.equal(summary.length <= "executor exited with code 1: ".length + 400, true)
  }))

test("non-harness jobs are left to lease expiry instead of being executed", async () =>
  withServer(async (origin) => {
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
    const jobId = jobIdentifier(
      ((await response.json()) as { job: { id: string } }).job.id,
    )
    const calls: HarnessLaunchPlan[] = []
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" }), calls),
    )
    assert.deepEqual(outcome, { outcome: "unsupported", jobId })
    assert.equal(calls.length, 0)
    assert.equal((await jobState(origin, jobId)).state, "leased")
  }))

test("payload roots the enqueue boundary does not recognise never become jobs", async () =>
  withServer(async (origin) => {
    const response = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...harnessEnqueueBody,
        payload: {
          ...harnessEnqueueBody.payload,
          repositoryRoot: "/tmp/example",
        },
        idempotencyKey: "harness:personal:example:outside",
      }),
    })
    assert.equal(response.status, 400)
  }))

test("payload roots outside this worker's workspaces spend no attempt", async () =>
  withServer(async (origin) => {
    const jobId = await enqueueHarnessJob(origin)
    const calls: HarnessLaunchPlan[] = []
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" }), calls),
      workspaceRoot(`${home}/code/0xgleb/other`),
    )
    assert.equal(outcome.outcome, "unsuitable")
    assert.equal(calls.length, 0)
    const persisted = await jobState(origin, jobId)
    assert.equal(persisted.state, "leased")
    assert.equal(persisted.lastAttemptSummary, undefined)
  }))

test("malformed control-plane claim responses surface as typed request failures", async () => {
  const { createServer } = await import("node:http")
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ job: { id: "job-a", attempt: "not-a-number" } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  try {
    const result = await Effect.runPromise(
      Effect.either(
        Effect.flatMap(
          workerOptions(
            `http://127.0.0.1:${String(address.port)}`,
            stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" })),
          ),
          runNextHarnessAttempt,
        ),
      ),
    )
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") {
      assert.equal(result.left.code, "request_failed")
      assert.equal(result.left.message, "claimed job payload is malformed")
    }
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
})

test("claimed kinds the job runtime does not register are malformed claims", async () => {
  const { createServer } = await import("node:http")
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        job: {
          id: "job-a",
          attempt: 1,
          leaseToken: "lease-a",
          spec: { kind: "shell.run", payload: { command: "arbitrary" } },
        },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  try {
    const result = await Effect.runPromise(
      Effect.either(
        Effect.flatMap(
          workerOptions(
            `http://127.0.0.1:${String(address.port)}`,
            stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" })),
          ),
          runNextHarnessAttempt,
        ),
      ),
    )
    assert.equal(result._tag, "Left")
    if (result._tag === "Left")
      assert.equal(result.left.message, "claimed job payload is malformed")
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
})

test("an executor timeout that outlives its lease is refused", async () => {
  const refused = await Effect.runPromise(
    Effect.either(
      harnessWorkerOptions({
        origin: "http://127.0.0.1:1",
        workerId: "harness-supervisor",
        leaseTtlMs: 30_000,
        executorTimeoutMs: 30_000,
        retryDelayMs: 0,
        allowedRoots: workspaceRoot(registeredCheckout),
        home,
        environment,
        spawner: () => stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" })),
      }),
    ),
  )
  assert.equal(refused._tag, "Left")
  if (refused._tag === "Left") {
    assert.equal(refused.left.code, "invalid_options")
    assert.equal(
      refused.left.message,
      "executor timeout must expire before the lease it runs under",
    )
  }

  const admitted = await Effect.runPromise(
    harnessWorkerOptions({
      origin: "http://127.0.0.1:1",
      workerId: "harness-supervisor",
      leaseTtlMs: 30_000,
      executorTimeoutMs: 29_999,
      retryDelayMs: 0,
      allowedRoots: workspaceRoot(registeredCheckout),
      home,
      environment,
      spawner: (executorTimeoutMs) =>
        stubSpawner(() => ({
          kind: "spawned",
          exitCode: 0,
          stdout: String(executorTimeoutMs),
        })),
    }),
  )
  assert.equal(admitted.executorTimeoutMs, 29_999)
})

const executionPlan = (argv: readonly string[]): HarnessLaunchPlan => ({
  lane: "cursor-subscription",
  cwd: canonical(tmpdir()),
  argv,
  environmentAllowlist: LAUNCH_ENVIRONMENT_ALLOWLIST,
})

/** The launcher environment the spawner tests hand their executors. */
const spawnEnvironment: LaunchEnvironment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
}

test("the process spawner captures bounded stdout, stderr, and exit codes", async () => {
  const spawner = spawnHarnessExecutor(10_000, spawnEnvironment)
  const succeeded = await Effect.runPromise(
    spawner(executionPlan(["node", "-e", "console.log('handoff-line')"])),
  )
  assert.equal(succeeded.exitCode, 0)
  assert.equal(succeeded.stdout.includes("handoff-line"), true)

  const failed = await Effect.runPromise(
    spawner(
      executionPlan([
        "node",
        "-e",
        "console.error('executor diagnostic'); process.exit(3)",
      ]),
    ),
  )
  assert.equal(failed.exitCode, 3)
  assert.equal(failed.stderr.includes("executor diagnostic"), true)
})

test("the process spawner hands the child only the plan's allowlisted variables", async () => {
  process.env.PI_HARNESS_SPAWN_PROBE = "ambient-secret"
  try {
    const execution = await Effect.runPromise(
      spawnHarnessExecutor(10_000, {
        ...spawnEnvironment,
        ANTHROPIC_API_KEY: "sk-ant-provider-secret",
      })(
        executionPlan([
          "node",
          "-e",
          "process.stdout.write(JSON.stringify({probe: process.env.PI_HARNESS_SPAWN_PROBE ?? null, key: process.env.ANTHROPIC_API_KEY ?? null, path: process.env.PATH !== undefined}))",
        ]),
      ),
    )
    assert.deepEqual(JSON.parse(execution.stdout), {
      probe: null,
      key: null,
      path: true,
    })
  } finally {
    delete process.env.PI_HARNESS_SPAWN_PROBE
  }
})

test("the process spawner kills executors whose output overflows the byte bound", async () => {
  const overflowed = await Effect.runPromise(
    Effect.either(
      spawnHarnessExecutor(30_000, spawnEnvironment)(
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
      spawnHarnessExecutor(200, spawnEnvironment)(
        executionPlan(["node", "-e", "setTimeout(() => {}, 60_000)"]),
      ),
    ),
  )
  assert.equal(timedOut._tag, "Left")

  const unavailable = await Effect.runPromise(
    Effect.either(
      spawnHarnessExecutor(1_000, spawnEnvironment)(
        executionPlan(["pi-harness-missing-executable"]),
      ),
    ),
  )
  assert.equal(unavailable._tag, "Left")
})

test("interrupting a launch kills the executor it started", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-interrupt-test-"))
  const pidFile = join(root, "executor.pid")
  try {
    const launched = Effect.runFork(
      spawnHarnessExecutor(30_000, spawnEnvironment)(
        executionPlan([
          "node",
          "-e",
          `const fs = require("node:fs"); const path = ${JSON.stringify(pidFile)}; fs.writeFileSync(path + ".partial", String(process.pid)); fs.renameSync(path + ".partial", path); setInterval(() => {}, 1000)`,
        ]),
      ),
    )
    const pid = await reportedPid(pidFile)
    await Effect.runPromise(Fiber.interrupt(launched))
    await untilExited(pid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Attempts of a bounded poll, each a hundredth of the second it may take. */
const POLL_ATTEMPTS = 500
const POLL_INTERVAL_MS = 10

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const reportedPid = async (pidFile: string): Promise<number> => {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const reported = await readFile(pidFile, "utf8").catch(() => "")
    const pid = Number.parseInt(reported, 10)
    if (Number.isSafeInteger(pid) && pid > 0) return pid
    await pause(POLL_INTERVAL_MS)
  }
  throw new Error("the executor never reported its process identifier")
}

const untilExited = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (!isRunning(pid)) return
    await pause(POLL_INTERVAL_MS)
  }
  throw new Error(`executor ${String(pid)} survived the interruption`)
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
