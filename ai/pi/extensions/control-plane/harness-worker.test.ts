import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { Clock, Effect, Fiber } from "effect"
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
  ATTEMPT_SETUP_MARGIN_MS,
  CONTROL_PLANE_REQUEST_TIMEOUT_MS,
  EXECUTOR_CLEANUP_MARGIN_MS,
  ExecutorFailed,
  gitRepository,
  harnessWorkerOptions,
  MAX_CONTROL_PLANE_RESPONSE_BYTES,
  MAX_EXECUTOR_STDERR_BYTES,
  ProvenanceUnverified,
  READ_ONLY_VERIFICATION_MARGIN_MS,
  REPORTING_MARGIN_MS,
  runNextHarnessAttempt,
  spawnHarnessExecutor,
  type HarnessAttemptOutcome,
  type HarnessRepository,
  WORKTREE_SETUP_MARGIN_MS,
  type HarnessSpawner,
} from "./harness-worker.ts"
import {
  canonicalPath,
  WORKTREE_DIRECTORY,
  type CanonicalPath,
} from "./review-duty-profile.ts"
import { startControlPlaneServer } from "./server.ts"
import { makeSqliteJobStore, type SqliteJobStore } from "./sqlite-job-store.ts"

const canonical = (value: string): CanonicalPath => {
  const path = canonicalPath(value)
  if (path === undefined) throw new Error(`fixture is not canonical: ${value}`)
  return path
}

const commit = (value: string): CommitSha => {
  const sha = toCommitSha(value)
  if (sha === undefined)
    throw new Error(`fixture is not a commit sha: ${value}`)
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

/**
 * The lane whose isolation is a job-scoped worktree. Every other fixture runs
 * read-only, so this is the payload the worktree lifecycle is exercised with.
 */
const worktreeEnqueueBody = {
  kind: "harness.review",
  payload: {
    lane: "claude-code-max",
    task: "review-loop",
    profile: "personal-review",
    repository: "0xgleb/example",
    pullRequest: 7,
    kind: "own",
    inputHeadSha: headSha,
    repositoryRoot: registeredCheckout,
    isolation: "approved-worktree",
  },
  runAt: 0,
  maxAttempts: 2,
  idempotencyKey: "harness:personal:example:7:worktree",
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
const stubSpawner =
  (
    execution: (plan: HarnessLaunchPlan) => HarnessExecutionResult,
    calls: HarnessLaunchPlan[] = [],
  ): HarnessSpawner =>
  plan =>
    Effect.suspend(() => {
      calls.push(plan)
      const result = execution(plan)
      return result.kind === "spawned"
        ? Effect.succeed({
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr ?? "",
          })
        : Effect.fail(new ExecutorFailed({ message: result.message }))
    })

/**
 * A repository whose worktree lifecycle is recorded rather than performed, so
 * the order a launch creates, uses, and removes its worktree in can be
 * asserted without a checkout on disk. Heads outside `knownHeads` are refused
 * exactly as a checkout that cannot resolve them would refuse them.
 */
const recordingRepository = (
  log: string[] = [],
  knownHeads: readonly string[] = [headSha],
): HarnessRepository => ({
  verifyHead: (_repositoryRoot, head) =>
    knownHeads.includes(head)
      ? Effect.void
      : Effect.fail(
          new ProvenanceUnverified({
            message: "declared input head is not a commit in the checkout",
          }),
        ),
  addWorktree: (_repositoryRoot, worktree) =>
    Effect.sync(() => {
      log.push(`add ${worktree}`)
    }),
  verifyUnchanged: (_worktree, _expectedHead) =>
    Effect.sync(() => {
      log.push("clean")
    }),
  verifyOutputHead: (_worktree, expectedHead) =>
    Effect.sync(() => {
      log.push(`head ${expectedHead}`)
    }),
  removeWorktree: (_repositoryRoot, worktree) =>
    Effect.sync(() => {
      log.push(`remove ${worktree}`)
    }),
})

const workerOptions = (
  origin: string,
  spawner: HarnessSpawner,
  allowedRoots: RegisteredWorkspaceRoots = workspaceRoot(registeredCheckout),
  repository: HarnessRepository = recordingRepository(),
) =>
  harnessWorkerOptions({
    origin,
    workerId: "harness-supervisor",
    leaseTtlMs: 120_000,
    executorTimeoutMs: 30_000,
    allowedRoots,
    home,
    environment,
    repository,
    spawner: () => spawner,
  })

const runAttempt = (
  origin: string,
  spawner: HarnessSpawner,
  allowedRoots?: RegisteredWorkspaceRoots,
  repository?: HarnessRepository,
): Promise<HarnessAttemptOutcome> =>
  Effect.runPromise(
    Effect.flatMap(
      workerOptions(origin, spawner, allowedRoots, repository),
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
  const job = jobs.jobs.find(candidate => candidate.id === jobId)
  assert.ok(job)
  return job
}

test("an empty queue leaves the worker idle without spawning", async () =>
  withServer(async origin => {
    const calls: HarnessLaunchPlan[] = []
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" }), calls),
    )
    assert.deepEqual(outcome, { outcome: "idle" })
    assert.equal(calls.length, 0)
  }))

test("a matching executor handoff completes the claimed harness job", async () =>
  withServer(async origin => {
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
  withServer(async origin => {
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

test("a failed handoff with retries left records its summary and drops the handoff", async () =>
  withServer(async origin => {
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
    assert.equal(persisted.result, undefined)
  }))

test("mismatched, malformed, and oversized executor output fails the attempt", async () => {
  const cases: ReadonlyArray<{
    readonly output: (jobId: JobId) => string
    readonly summary: string
  }> = [
    {
      output: jobId =>
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
      output: jobId =>
        JSON.stringify({ ...handoffFor(jobId), prompt: "leaked" }),
      summary: "executor handoff is malformed",
    },
    {
      output: jobId =>
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
    await withServer(async origin => {
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
  withServer(async origin => {
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
  withServer(async origin => {
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
      summary.startsWith(
        "executor exited with code 1: subscription auth expired detail",
      ),
      true,
    )
    assert.equal(summary.includes("ignored progress"), false)
    assert.equal(
      summary.length <= "executor exited with code 1: ".length + 400,
      true,
    )
  }))

test("the harness worker leaves another job kind unclaimed", async () =>
  withServer(async origin => {
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
    assert.deepEqual(outcome, { outcome: "idle" })
    assert.equal(calls.length, 0)
    assert.equal((await jobState(origin, jobId)).state, "ready")
  }))

test("payload roots the enqueue boundary does not recognise never become jobs", async () =>
  withServer(async origin => {
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
  withServer(async origin => {
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

test("an approved-worktree launch runs in a worktree created for it and removed after", async () =>
  withServer(async origin => {
    const jobId = await enqueueHarnessJob(origin, worktreeEnqueueBody)
    const log: string[] = []
    const calls: HarnessLaunchPlan[] = []
    const outcome = await runAttempt(
      origin,
      stubSpawner(plan => {
        log.push(`spawn ${plan.cwd}`)
        return {
          kind: "spawned",
          exitCode: 0,
          stdout: JSON.stringify(
            handoffFor(jobId, { lane: "claude-code-max" }),
          ),
        }
      }, calls),
      undefined,
      recordingRepository(log),
    )
    assert.deepEqual(outcome, { outcome: "completed", jobId })
    const worktree = `${registeredCheckout}/${WORKTREE_DIRECTORY}/${jobId}-1`
    assert.equal(calls[0]?.cwd, worktree)
    assert.deepEqual(log, [
      `add ${worktree}`,
      `spawn ${worktree}`,
      `head ${headSha}`,
      `remove ${worktree}`,
    ])
  }))

test("approved worktree outcomes are reported before teardown", async () =>
  withServer(async origin => {
    const jobId = await enqueueHarnessJob(origin, worktreeEnqueueBody)
    let stateAtRemoval: string | undefined
    const repository: HarnessRepository = {
      ...recordingRepository(),
      removeWorktree: (_repositoryRoot, _worktree) =>
        Effect.promise(async () => {
          stateAtRemoval = (await jobState(origin, jobId)).state
        }),
    }
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({
        kind: "spawned",
        exitCode: 0,
        stdout: JSON.stringify(handoffFor(jobId, { lane: "claude-code-max" })),
      })),
      undefined,
      repository,
    )
    assert.deepEqual(outcome, { outcome: "completed", jobId })
    assert.equal(stateAtRemoval, "succeeded")
  }))

test("an unconfirmed executor cleanup quarantines its worktree", async () =>
  withServer(async origin => {
    const jobId = await enqueueHarnessJob(origin, worktreeEnqueueBody)
    const log: string[] = []
    const spawner: HarnessSpawner = (_plan, quarantineWorktree) =>
      Effect.sync(() => {
        quarantineWorktree?.()
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            handoffFor(jobId, { lane: "claude-code-max" }),
          ),
          stderr: "",
        }
      })
    const outcome = await runAttempt(
      origin,
      spawner,
      undefined,
      recordingRepository(log),
    )
    assert.deepEqual(outcome, { outcome: "completed", jobId })
    assert.equal(
      log.some(entry => entry.startsWith("remove ")),
      false,
    )
  }))

test("approved worktree handoffs must match the commit actually produced", async () =>
  withServer(async origin => {
    const jobId = await enqueueHarnessJob(origin, worktreeEnqueueBody)
    const outputHead = commit("b".repeat(40))
    let verifiedHead: CommitSha | undefined
    const repository: HarnessRepository = {
      ...recordingRepository(),
      verifyOutputHead: (_worktree, expectedHead) => {
        verifiedHead = expectedHead
        return Effect.fail(
          new ExecutorFailed({
            message: "executor output head does not match its worktree",
          }),
        )
      },
    }
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({
        kind: "spawned",
        exitCode: 0,
        stdout: JSON.stringify(
          handoffFor(jobId, {
            lane: "claude-code-max",
            status: "findings_fixed",
            outputHeadSha: outputHead,
            evidence: [`commit:${outputHead}`],
          }),
        ),
      })),
      undefined,
      repository,
    )
    assert.deepEqual(outcome, {
      outcome: "failed",
      jobId,
      reason: "executor output head does not match its worktree",
    })
    assert.equal(verifiedHead, outputHead)
  }))

test("read-only launches run from a pinned clean worktree", async () =>
  withServer(async origin => {
    const jobId = await enqueueHarnessJob(origin)
    const log: string[] = []
    const outcome = await runAttempt(
      origin,
      stubSpawner(plan => {
        log.push(`spawn ${plan.cwd}`)
        const workspaceIndex = plan.argv.indexOf("--workspace")
        assert.equal(plan.argv[workspaceIndex + 1], plan.cwd)
        return {
          kind: "spawned",
          exitCode: 0,
          stdout: JSON.stringify(handoffFor(jobId)),
        }
      }),
      undefined,
      recordingRepository(log),
    )
    const worktree = `${registeredCheckout}/${WORKTREE_DIRECTORY}/${jobId}-1`
    assert.deepEqual(outcome, { outcome: "completed", jobId })
    assert.deepEqual(log, [
      `add ${worktree}`,
      `spawn ${worktree}`,
      "clean",
      `remove ${worktree}`,
    ])
  }))

test("read-only launches fail when the executor mutates its worktree", async () =>
  withServer(async origin => {
    const jobId = await enqueueHarnessJob(origin)
    const repository: HarnessRepository = {
      ...recordingRepository(),
      verifyUnchanged: () =>
        Effect.fail(
          new ExecutorFailed({
            message: "read-only executor mutated its worktree",
          }),
        ),
    }
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({
        kind: "spawned",
        exitCode: 0,
        stdout: JSON.stringify(handoffFor(jobId)),
      })),
      undefined,
      repository,
    )
    assert.deepEqual(outcome, {
      outcome: "failed",
      jobId,
      reason: "read-only executor mutated its worktree",
    })
    assert.equal((await jobState(origin, jobId)).state, "retry_wait")
  }))

test("a launch is refused unless the checkout resolves the head it declares", async () => {
  await withServer(async origin => {
    const jobId = await enqueueHarnessJob(origin)
    const calls: HarnessLaunchPlan[] = []
    const outcome = await runAttempt(
      origin,
      stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" }), calls),
      undefined,
      recordingRepository([], []),
    )
    assert.deepEqual(outcome, {
      outcome: "failed",
      jobId,
      reason: "declared input head is not a commit in the checkout",
    })
    assert.equal(calls.length, 0)
    const persisted = await jobState(origin, jobId)
    assert.equal(persisted.state, "retry_wait")
    assert.equal(
      persisted.lastAttemptSummary,
      "declared input head is not a commit in the checkout",
    )
  })

  await withServer(async origin => {
    const jobId = await enqueueHarnessJob(origin)
    const calls: HarnessLaunchPlan[] = []
    const outcome = await runAttempt(
      origin,
      stubSpawner(
        () => ({
          kind: "spawned",
          exitCode: 0,
          stdout: JSON.stringify(handoffFor(jobId)),
        }),
        calls,
      ),
      undefined,
      recordingRepository([], [headSha]),
    )
    assert.deepEqual(outcome, { outcome: "completed", jobId })
    assert.equal(calls.length, 1)
  })
})

type ClaimAttemptResult =
  | { readonly kind: "reported"; readonly reported: HarnessAttemptOutcome }
  | { readonly kind: "refused"; readonly message: string }

/** The registered spec a stub control plane hands back with a claim. */
const claimedHarnessSpec = {
  kind: "harness.review",
  payload: harnessEnqueueBody.payload,
}

/**
 * Runs one attempt against a control plane that answers every request with the
 * given job, so a claim the real store could not produce can be handed to the
 * worker's own boundary.
 */
interface ClaimRuntime {
  readonly spawner?: HarnessSpawner
  readonly repository?: HarnessRepository
  readonly clock?: Clock.Clock
}

const attemptAgainstClaimResponse = async (
  responseChunks: readonly string[],
  calls: HarnessLaunchPlan[] = [],
  requests: string[] = [],
  runtime: ClaimRuntime = {},
): Promise<ClaimAttemptResult> => {
  const { createServer } = await import("node:http")
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    response.writeHead(200, { "content-type": "application/json" })
    for (const chunk of responseChunks) response.write(chunk)
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  try {
    const attempt = Effect.flatMap(
      workerOptions(
        `http://127.0.0.1:${String(address.port)}`,
        runtime.spawner ??
          stubSpawner(
            () => ({ kind: "spawned", exitCode: 0, stdout: "" }),
            calls,
          ),
        undefined,
        runtime.repository,
      ),
      runNextHarnessAttempt,
    )
    const result = await Effect.runPromise(
      Effect.either(
        runtime.clock === undefined
          ? attempt
          : Effect.provideService(attempt, Clock.Clock, runtime.clock),
      ),
    )
    return result._tag === "Left"
      ? { kind: "refused", message: result.left.message }
      : { kind: "reported", reported: result.right }
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
  }
}

const attemptAgainstClaim = async (
  job: unknown,
  calls: HarnessLaunchPlan[] = [],
  requests: string[] = [],
  runtime: ClaimRuntime = {},
): Promise<ClaimAttemptResult> =>
  attemptAgainstClaimResponse(
    [JSON.stringify({ job })],
    calls,
    requests,
    runtime,
  )

test("malformed control-plane claim responses surface as typed request failures", async () => {
  const malformed: readonly unknown[] = [
    { id: "job-a", attempt: "not-a-number" },
    {
      id: "job-a",
      attempt: 0,
      leaseToken: "lease-a",
      spec: claimedHarnessSpec,
    },
    {
      id: "job-a",
      attempt: 101,
      leaseToken: "lease-a",
      spec: claimedHarnessSpec,
    },
    {
      id: "job-a",
      attempt: 1,
      leaseToken: "lease-a",
      leaseUntil: Date.now() + 60_000,
      spec: {
        ...claimedHarnessSpec,
        payload: { ...harnessEnqueueBody.payload, pullRequest: "seven" },
      },
    },
  ]
  for (const job of malformed) {
    const calls: HarnessLaunchPlan[] = []
    assert.deepEqual(await attemptAgainstClaim(job, calls), {
      kind: "refused",
      message: "claimed job payload is malformed",
    })
    assert.equal(calls.length, 0)
  }
})

test("control-plane claim responses are bounded before JSON decoding", async () => {
  const claim = JSON.stringify({
    job: {
      id: "job-a",
      attempt: 1,
      leaseToken: "lease-a",
      leaseUntil: Date.now() + 120_000,
      spec: claimedHarnessSpec,
    },
  })
  assert.equal(
    Buffer.byteLength(claim) < MAX_CONTROL_PLANE_RESPONSE_BYTES,
    true,
  )

  const admittedCalls: HarnessLaunchPlan[] = []
  const admittedBody =
    claim +
    " ".repeat(MAX_CONTROL_PLANE_RESPONSE_BYTES - Buffer.byteLength(claim))
  const admitted = await attemptAgainstClaimResponse(
    [admittedBody],
    admittedCalls,
  )
  assert.equal(admitted.kind, "reported")
  assert.equal(admittedCalls.length, 1)

  const refusedCalls: HarnessLaunchPlan[] = []
  const refused = await attemptAgainstClaimResponse(
    [admittedBody, " "],
    refusedCalls,
  )
  assert.deepEqual(refused, {
    kind: "refused",
    message: "control plane response from /v1/worker/claim exceeded bounds",
  })
  assert.equal(refusedCalls.length, 0)
})

test("aborting a response read handles reader cancellation failures", async () => {
  const originalFetch = globalThis.fetch
  const unhandled: unknown[] = []
  const onUnhandled = (failure: unknown): void => {
    unhandled.push(failure)
  }
  let pulled!: () => void
  const readerPulled = new Promise<void>(resolve => {
    pulled = resolve
  })
  let cancelCalls = 0
  const body = new ReadableStream<Uint8Array>({
    pull: () => {
      pulled()
    },
    cancel: () => {
      cancelCalls += 1
      return Promise.reject(new Error("cancel failed"))
    },
  })
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch
  process.on("unhandledRejection", onUnhandled)
  try {
    const attempt = Effect.flatMap(
      workerOptions(
        "http://127.0.0.1:1",
        stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" })),
      ),
      runNextHarnessAttempt,
    )
    const fiber = Effect.runFork(attempt)
    await Promise.race([
      readerPulled,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("response reader did not start")),
          1_000,
        ),
      ),
    ])
    await Effect.runPromise(Fiber.interrupt(fiber))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(cancelCalls, 1)
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
    globalThis.fetch = originalFetch
  }
})

test("attempt numbers at the bounds of the protocol's range are claimed", async () => {
  for (const attempt of [1, 100]) {
    const result = await attemptAgainstClaim({
      id: "job-a",
      attempt,
      leaseToken: "lease-a",
      leaseUntil: Date.now() + 120_000,
      spec: claimedHarnessSpec,
    })
    assert.equal(result.kind, "reported")
  }
})

test("a claim without enough remaining lease never launches or reports", async () => {
  const calls: HarnessLaunchPlan[] = []
  const requests: string[] = []
  const result = await attemptAgainstClaim(
    {
      id: "job-a",
      attempt: 1,
      leaseToken: "lease-a",
      leaseUntil: Date.now() + REPORTING_MARGIN_MS - 1,
      spec: claimedHarnessSpec,
    },
    calls,
    requests,
  )
  assert.deepEqual(result, {
    kind: "refused",
    message: "attempt has insufficient lease remaining",
  })
  assert.equal(calls.length, 0)
  assert.deepEqual(requests, ["/v1/worker/claim"])
})

test("worker admission reserves every bounded Git phase", async () => {
  assert.equal(
    ATTEMPT_SETUP_MARGIN_MS,
    WORKTREE_SETUP_MARGIN_MS + READ_ONLY_VERIFICATION_MARGIN_MS,
  )
  const options = await Effect.runPromise(
    Effect.either(
      harnessWorkerOptions({
        origin: "http://127.0.0.1:1",
        workerId: "harness-supervisor",
        leaseTtlMs:
          30_000 +
          ATTEMPT_SETUP_MARGIN_MS +
          EXECUTOR_CLEANUP_MARGIN_MS +
          REPORTING_MARGIN_MS -
          1,
        executorTimeoutMs: 30_000,
        allowedRoots: workspaceRoot(registeredCheckout),
        home,
        environment,
        repository: recordingRepository(),
        spawner: () =>
          stubSpawner(() => ({ kind: "spawned", exitCode: 0, stdout: "" })),
      }),
    ),
  )
  assert.equal(options._tag, "Left")
})

test("verification failure after bounded executor cleanup and lease exhaustion never reaches the fail route", async () => {
  let now = 1_000_000
  const liveClock = Clock.make()
  const clock: Clock.Clock = {
    ...liveClock,
    unsafeCurrentTimeMillis: () => now,
    currentTimeMillis: Effect.sync(() => now),
  }
  const elapse = (milliseconds: number): Effect.Effect<void> =>
    Effect.sync(() => {
      now += milliseconds
    })
  const repository: HarnessRepository = {
    verifyHead: () => elapse(WORKTREE_SETUP_MARGIN_MS / 2),
    addWorktree: () => elapse(WORKTREE_SETUP_MARGIN_MS / 2),
    verifyUnchanged: () =>
      Effect.andThen(
        elapse(READ_ONLY_VERIFICATION_MARGIN_MS + 1),
        Effect.fail(
          new ExecutorFailed({
            message: "read-only executor mutated its worktree",
          }),
        ),
      ),
    verifyOutputHead: () => Effect.void,
    removeWorktree: () => Effect.void,
  }
  const spawner: HarnessSpawner = () =>
    Effect.andThen(
      elapse(30_000 + EXECUTOR_CLEANUP_MARGIN_MS),
      Effect.succeed({ exitCode: 1, stdout: "", stderr: "failed" }),
    )
  const requests: string[] = []
  const result = await attemptAgainstClaim(
    {
      id: "job-a",
      attempt: 1,
      leaseToken: "lease-a",
      leaseUntil:
        now +
        30_000 +
        ATTEMPT_SETUP_MARGIN_MS +
        EXECUTOR_CLEANUP_MARGIN_MS +
        REPORTING_MARGIN_MS,
      spec: claimedHarnessSpec,
    },
    [],
    requests,
    { spawner, repository, clock },
  )
  assert.deepEqual(result, {
    kind: "refused",
    message: "attempt has insufficient lease remaining",
  })
  assert.deepEqual(requests, ["/v1/worker/claim"])
})

test("status-only control-plane responses are cancelled", async () => {
  const { createServer } = await import("node:http")
  const jobId = jobIdentifier("job-a")
  for (const route of ["claim", "complete"] as const) {
    let responseClosed = false
    const server = createServer((request, response) => {
      if (route === "complete" && request.url === "/v1/worker/claim") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            job: {
              id: jobId,
              attempt: 1,
              leaseToken: "lease-a",
              leaseUntil: Date.now() + 120_000,
              spec: claimedHarnessSpec,
            },
          }),
        )
        return
      }
      response.on("close", () => {
        responseClosed = true
      })
      response.writeHead(route === "claim" ? 503 : 200, {
        "content-type": "application/json",
      })
      response.write("x".repeat(MAX_CONTROL_PLANE_RESPONSE_BYTES + 1))
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    try {
      const result = await Effect.runPromise(
        Effect.either(
          Effect.flatMap(
            workerOptions(
              `http://127.0.0.1:${String(address.port)}`,
              stubSpawner(() => ({
                kind: "spawned",
                exitCode: 0,
                stdout: JSON.stringify(handoffFor(jobId)),
              })),
            ),
            runNextHarnessAttempt,
          ),
        ),
      )
      if (route === "claim") {
        assert.equal(result._tag, "Left")
      } else {
        if (result._tag === "Left") assert.fail(result.left.message)
        assert.deepEqual(result.right, { outcome: "completed", jobId })
      }
      for (let attempt = 0; attempt < 50 && !responseClosed; attempt += 1)
        await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(responseClosed, true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
})

test("control-plane requests fail within their bounded timeout", async () => {
  const { createServer } = await import("node:http")
  const server = createServer(() => undefined)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const started = Date.now()
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
    if (result._tag === "Right") assert.fail("expected request timeout")
    assert.equal(
      result.left.message,
      "control plane request to /v1/worker/claim failed",
    )
    assert.equal(
      Date.now() - started < CONTROL_PLANE_REQUEST_TIMEOUT_MS + 2_000,
      true,
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test("claimed kinds the job runtime does not register are malformed claims", async () => {
  assert.deepEqual(
    await attemptAgainstClaim({
      id: "job-a",
      attempt: 1,
      leaseToken: "lease-a",
      leaseUntil: Date.now() + 60_000,
      spec: { kind: "shell.run", payload: { command: "arbitrary" } },
    }),
    { kind: "refused", message: "claimed job payload is malformed" },
  )
})

test("an executor timeout that leaves no setup, cleanup, verification, and reporting margin is refused", async () => {
  const leaseTtlMs = 90_000
  const requiredMarginMs =
    ATTEMPT_SETUP_MARGIN_MS + EXECUTOR_CLEANUP_MARGIN_MS + REPORTING_MARGIN_MS
  const timeoutOptions = (executorTimeoutMs: number) =>
    harnessWorkerOptions({
      origin: "http://127.0.0.1:1",
      workerId: "harness-supervisor",
      leaseTtlMs,
      executorTimeoutMs,
      allowedRoots: workspaceRoot(registeredCheckout),
      home,
      environment,
      repository: recordingRepository(),
      spawner: timeout =>
        stubSpawner(() => ({
          kind: "spawned",
          exitCode: 0,
          stdout: String(timeout),
        })),
    })

  // A timeout inside the lease by less than the bounded setup, cleanup,
  // verification, and reporting margin can outlive the lease.
  for (const executorTimeoutMs of [
    leaseTtlMs,
    leaseTtlMs - 1,
    leaseTtlMs - requiredMarginMs + 1,
  ]) {
    const refused = await Effect.runPromise(
      Effect.either(timeoutOptions(executorTimeoutMs)),
    )
    if (refused._tag === "Right") assert.fail("expected refused options")
    assert.equal(refused.left._tag, "InvalidWorkerOptions")
    assert.equal(
      refused.left.message,
      `executor timeout must leave the lease ${String(requiredMarginMs)}ms for setup, cleanup, verification, and reporting`,
    )
  }

  const admittedTimeoutMs = leaseTtlMs - requiredMarginMs
  const admitted = await Effect.runPromise(timeoutOptions(admittedTimeoutMs))
  assert.equal(admitted.executorTimeoutMs, admittedTimeoutMs)
  const launched = await Effect.runPromise(
    admitted.spawner(executionPlan(["node", "-e", ""])),
  )
  assert.equal(launched.stdout, String(admittedTimeoutMs))
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

  const truncated = await Effect.runPromise(
    spawner(
      executionPlan([
        "node",
        "-e",
        `process.stderr.write("x".repeat(${String(MAX_EXECUTOR_STDERR_BYTES + 1)})); process.exit(3)`,
      ]),
    ),
  )
  assert.equal(Buffer.byteLength(truncated.stderr), MAX_EXECUTOR_STDERR_BYTES)
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
      spawnHarnessExecutor(
        30_000,
        spawnEnvironment,
      )(
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
      spawnHarnessExecutor(
        200,
        spawnEnvironment,
      )(executionPlan(["node", "-e", "setTimeout(() => {}, 60_000)"])),
    ),
  )
  assert.equal(timedOut._tag, "Left")
  if (timedOut._tag === "Left")
    assert.equal(timedOut.left.message, "executor timed out")

  let unavailableQuarantined = false
  const unavailable = await Effect.runPromise(
    Effect.either(
      spawnHarnessExecutor(1_000, spawnEnvironment)(
        executionPlan(["pi-harness-missing-executable"]),
        () => {
          unavailableQuarantined = true
        },
      ),
    ),
  )
  assert.equal(unavailable._tag, "Left")
  if (unavailable._tag === "Left")
    assert.equal(unavailable.left.message, "executor could not be spawned")
  assert.equal(unavailableQuarantined, false)
})

test("an exited executor cannot time out while its inherited pipe drains", async () => {
  const execution = await Effect.runPromise(
    spawnHarnessExecutor(
      100,
      spawnEnvironment,
    )(
      executionPlan([
        "node",
        "-e",
        `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 180)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] }); child.unref(); console.log("handoff-line")`,
      ]),
    ),
  )
  assert.equal(execution.exitCode, 0)
  assert.equal(execution.stdout.includes("handoff-line"), true)
})

test("an executor that exits terminates descendants before it is reported", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-exit-test-"))
  const pidFile = join(root, "descendant.pid")
  try {
    const execution = await Effect.runPromise(
      spawnHarnessExecutor(
        5_000,
        spawnEnvironment,
      )(
        executionPlan([
          "node",
          "-e",
          `const fs = require("node:fs"); const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "ignore"] }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref(); console.log("handoff-line")`,
        ]),
      ),
    )
    const pid = Number((await readFile(pidFile, "utf8")).trim())
    assert.equal(Number.isSafeInteger(pid) && pid > 0, true)
    assert.equal(execution.exitCode, 0)
    assert.equal(execution.stdout.includes("handoff-line"), true)
    assert.equal(isRunning(pid), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an unobservable process group is quarantined rather than treated as absent", async () => {
  let quarantined = false
  const denyGroupSignals = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) {
      const denied = new Error(
        "operation not permitted",
      ) as NodeJS.ErrnoException
      denied.code = "EPERM"
      throw denied
    }
    return process.kill(pid, signal)
  }) as typeof process.kill
  const result = await Effect.runPromise(
    Effect.either(
      spawnHarnessExecutor(
        50,
        spawnEnvironment,
        denyGroupSignals,
      )(executionPlan(["node", "-e", "setTimeout(() => {}, 60_000)"]), () => {
        quarantined = true
      }),
    ),
  )
  assert.equal(result._tag, "Left")
  if (result._tag === "Left")
    assert.equal(result.left.message, "executor descendants did not terminate")
  assert.equal(quarantined, true)
})

test("interrupting a launch kills the executor and the subprocesses it started", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-interrupt-test-"))
  const pidFile = join(root, "executor.pid")
  try {
    const launched = Effect.runFork(
      spawnHarnessExecutor(
        30_000,
        spawnEnvironment,
      )(
        executionPlan([
          "node",
          "-e",
          `const fs = require("node:fs"); const { spawn } = require("node:child_process"); const path = ${JSON.stringify(pidFile)}; const tool = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); fs.writeFileSync(path + ".partial", JSON.stringify([process.pid, tool.pid])); fs.renameSync(path + ".partial", path); setInterval(() => {}, 1000)`,
        ]),
      ),
    )
    const pids = await reportedPids(pidFile)
    assert.equal(pids.length, 2)
    await Effect.runPromise(Fiber.interrupt(launched))
    for (const pid of pids) await untilExited(pid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const runGit = promisify(execFile)

/** Git run against the fixture checkout, with the suite's own identity. */
const gitFixture = async (
  checkout: string,
  args: readonly string[],
): Promise<string> =>
  (
    await runGit("git", [
      "-C",
      checkout,
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "user.name=Harness Fixture",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ])
  ).stdout

test("the git repository verifies a head and builds the worktree a launch runs in", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-git-test-"))
  try {
    const checkout = canonical(join(root, "checkout"))
    await mkdir(checkout)
    await gitFixture(checkout, ["init", "-b", "main"])
    await writeFile(join(checkout, ".gitignore"), "ignored.txt\n")
    await writeFile(join(checkout, "tracked.txt"), "original\n")
    await gitFixture(checkout, ["add", ".gitignore", "tracked.txt"])
    await gitFixture(checkout, ["commit", "-m", "fixture"])
    const head = commit(
      (await gitFixture(checkout, ["rev-parse", "HEAD"])).trim(),
    )

    await Effect.runPromise(gitRepository.verifyHead(checkout, head))
    const unresolved = await Effect.runPromise(
      Effect.either(gitRepository.verifyHead(checkout, commit("b".repeat(40)))),
    )
    assert.equal(unresolved._tag, "Left")
    if (unresolved._tag === "Left")
      assert.equal(unresolved.left._tag, "ProvenanceUnverified")

    const worktree = canonical(join(checkout, WORKTREE_DIRECTORY, "job-a-1"))
    await Effect.runPromise(gitRepository.addWorktree(checkout, worktree, head))
    assert.equal(existsSync(worktree), true)
    await Effect.runPromise(gitRepository.verifyUnchanged(worktree, head))
    await Effect.runPromise(gitRepository.verifyOutputHead(worktree, head))

    await writeFile(join(worktree, "ignored.txt"), "hidden mutation")
    const ignored = await Effect.runPromise(
      Effect.either(gitRepository.verifyUnchanged(worktree, head)),
    )
    assert.equal(ignored._tag, "Left")
    if (ignored._tag === "Left")
      assert.equal(
        ignored.left.message,
        "read-only executor mutated its worktree",
      )
    await rm(join(worktree, "ignored.txt"))

    await gitFixture(worktree, [
      "update-index",
      "--assume-unchanged",
      "tracked.txt",
    ])
    await writeFile(
      join(worktree, "tracked.txt"),
      "hidden by assume-unchanged\n",
    )
    const assumed = await Effect.runPromise(
      Effect.either(gitRepository.verifyUnchanged(worktree, head)),
    )
    assert.equal(assumed._tag, "Left")
    if (assumed._tag === "Left")
      assert.equal(
        assumed.left.message,
        "read-only executor mutated its worktree",
      )
    await gitFixture(worktree, [
      "update-index",
      "--no-assume-unchanged",
      "tracked.txt",
    ])
    await gitFixture(worktree, ["checkout", "--", "tracked.txt"])

    await gitFixture(worktree, [
      "update-index",
      "--skip-worktree",
      "tracked.txt",
    ])
    await writeFile(join(worktree, "tracked.txt"), "hidden by skip-worktree\n")
    const skipped = await Effect.runPromise(
      Effect.either(gitRepository.verifyUnchanged(worktree, head)),
    )
    assert.equal(skipped._tag, "Left")
    if (skipped._tag === "Left")
      assert.equal(
        skipped.left.message,
        "read-only executor mutated its worktree",
      )
    await gitFixture(worktree, [
      "update-index",
      "--no-skip-worktree",
      "tracked.txt",
    ])
    await gitFixture(worktree, ["checkout", "--", "tracked.txt"])

    await gitFixture(worktree, ["commit", "--allow-empty", "-m", "moved"])
    const moved = await Effect.runPromise(
      Effect.either(gitRepository.verifyUnchanged(worktree, head)),
    )
    assert.equal(moved._tag, "Left")
    if (moved._tag === "Left")
      assert.equal(
        moved.left.message,
        "read-only executor moved its worktree head",
      )
    await Effect.runPromise(gitRepository.removeWorktree(checkout, worktree))
    assert.equal(existsSync(worktree), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** Attempts of a bounded poll, each a hundredth of the second it may take. */
const POLL_ATTEMPTS = 500
const POLL_INTERVAL_MS = 10

const pause = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const reportedPids = async (pidFile: string): Promise<readonly number[]> => {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const reported = await readFile(pidFile, "utf8").catch(() => "")
    const pids = parsePids(reported)
    if (pids !== undefined) return pids
    await pause(POLL_INTERVAL_MS)
  }
  throw new Error("the executor never reported its process identifiers")
}

const parsePids = (reported: string): readonly number[] | undefined => {
  if (reported.length === 0) return undefined
  const parsed: unknown = JSON.parse(reported)
  return Array.isArray(parsed) &&
    parsed.every(
      pid => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0,
    )
    ? (parsed as readonly number[])
    : undefined
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
