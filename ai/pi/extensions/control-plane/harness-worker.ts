import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process"
import { promisify } from "node:util"
import { Data, Effect } from "effect"
import {
  buildHarnessLaunchPlan,
  type HarnessLaunchPlan,
  type RegisteredWorkspaceRoots,
} from "./harness-adapter.ts"
import type { LaunchEnvironment } from "./harness-launch.ts"
import {
  decodeHarnessReviewHandoff,
  decodeHarnessReviewPayload,
  harnessHandoffAttemptMatch,
  includesAny,
  toJobId,
  type CommitSha,
  type HarnessReviewHandoff,
  type HarnessReviewPayload,
  type JobId,
} from "./harness-protocol.ts"
import { REGISTERED_JOB_KINDS, type RegisteredJobKind } from "./job-runtime.ts"
import type { CanonicalPath } from "./review-duty-profile.ts"

export interface HarnessExecution {
  readonly exitCode: number
  readonly stdout: string
  /**
   * Bounded diagnostic output. It carries no protocol: the handoff is read
   * from stdout, and this is only what the process said about a run that
   * ended badly.
   */
  readonly stderr: string
}

/**
 * An attempt the executor could not carry to a handoff. It is the only failure
 * a spawner may report, so a launch that fails is always charged to the job
 * through the fail route rather than escaping as a transport fault.
 */
export class ExecutorFailed extends Data.TaggedError("ExecutorFailed")<{
  readonly message: string
}> {}

/**
 * A checkout that could not be shown to hold the head its payload declares.
 * The launcher refuses to start an executor against an unproven head, so the
 * attempt is reported without one ever running.
 */
export class ProvenanceUnverified extends Data.TaggedError(
  "ProvenanceUnverified",
)<{
  readonly message: string
}> {}

/**
 * A control-plane request that did not complete. It says nothing about the
 * executor, so it is never reported as a spent attempt.
 */
export class ControlPlaneRequestFailed extends Data.TaggedError(
  "ControlPlaneRequestFailed",
)<{
  readonly message: string
}> {}

/** Settings no attempt may run under. */
export class InvalidWorkerOptions extends Data.TaggedError(
  "InvalidWorkerOptions",
)<{
  readonly message: string
}> {}

export type HarnessSpawner = (
  plan: HarnessLaunchPlan,
) => Effect.Effect<HarnessExecution, ExecutorFailed>

/**
 * Builds the spawner an attempt runs through. The worker options constructor
 * is the only caller, so the timeout it validated against the lease and the
 * environment it was handed are the ones every launch uses.
 */
export type HarnessSpawnerFactory = (
  executorTimeoutMs: number,
  environment: LaunchEnvironment,
) => HarnessSpawner

/**
 * The git the launcher needs from the checkout an attempt runs against.
 *
 * It is stated as a capability rather than called directly so an attempt can
 * be exercised without a repository on disk, and so the production
 * implementation is the single place that decides what a failed invocation
 * means for the attempt.
 */
export interface HarnessRepository {
  /**
   * Establishes that the checkout holds the head the payload declares. It
   * fails when the commit is absent or git cannot answer, so a head the
   * launcher could not resolve never reaches an executor.
   */
  readonly verifyHead: (
    repositoryRoot: CanonicalPath,
    head: CommitSha,
  ) => Effect.Effect<void, ProvenanceUnverified>
  /** Creates the job-scoped worktree an approved-worktree attempt runs in. */
  readonly addWorktree: (
    repositoryRoot: CanonicalPath,
    worktree: CanonicalPath,
    head: CommitSha,
  ) => Effect.Effect<void, ExecutorFailed>
  /**
   * Removes that worktree once the attempt is over. A removal that fails is
   * logged rather than reported: the attempt's own outcome is what the job
   * records, and a stale worktree is not a reason to lose it.
   */
  readonly removeWorktree: (
    repositoryRoot: CanonicalPath,
    worktree: CanonicalPath,
  ) => Effect.Effect<void>
}

/**
 * What one poll of the queue did.
 *
 * `unsupported` and `unsuitable` both leave the claimed job untouched: the
 * first is a kind this worker does not run, the second a harness job this
 * worker is not configured to launch. Neither reports an attempt, so a job
 * another worker can run is not spent by the worker that declined it.
 */
export type HarnessAttemptOutcome =
  | { readonly outcome: "idle" }
  | { readonly outcome: "unsupported"; readonly jobId: JobId }
  | {
      readonly outcome: "unsuitable"
      readonly jobId: JobId
      readonly reason: string
    }
  | { readonly outcome: "completed"; readonly jobId: JobId }
  | {
      readonly outcome: "failed"
      readonly jobId: JobId
      readonly reason: string
    }

/** What a caller states to obtain worker options. */
export interface HarnessWorkerSettings {
  readonly origin: string
  readonly workerId: string
  readonly leaseTtlMs: number
  /**
   * How long an executor may run. It must expire a reporting margin before the
   * lease it runs under, so an attempt is killed — and its outcome accepted —
   * while it still holds the lease its handoff is published against rather
   * than racing a second attempt of the same job.
   */
  readonly executorTimeoutMs: number
  /** Checkout roots this worker is registered to launch a harness in. */
  readonly allowedRoots: RegisteredWorkspaceRoots
  /**
   * Home the claimed payload's checkout is admitted against. The worker is
   * handed one rather than reading the environment, so the home a payload was
   * enqueued against is the home it is launched against.
   */
  readonly home: CanonicalPath
  /** The launcher's own environment, filtered to the launch allowlist. */
  readonly environment: LaunchEnvironment
  readonly repository: HarnessRepository
  readonly spawner: HarnessSpawnerFactory
}

/**
 * Settings an attempt may run under. `harnessWorkerOptions` is the only way to
 * obtain one, so no attempt can run with a timeout that outlives its lease or
 * with a spawner built from anything but the validated settings.
 */
export type HarnessWorkerOptions = Omit<HarnessWorkerSettings, "spawner"> & {
  readonly spawner: HarnessSpawner
  readonly __brand: "HarnessWorkerOptions"
}

/**
 * Lease time reserved for everything an attempt does around its executor: the
 * claim that opened it and the report that closes it. The executor's own
 * timeout is admitted against the lease minus this margin, so a run that uses
 * its full timeout still has a lease to report under.
 */
export const REPORTING_MARGIN_MS = 10_000

/**
 * Claims the next due job and carries one attempt of it to a reported outcome.
 *
 * Only an attempt the executor actually ran is charged to the job: a kind this
 * worker does not run, and a harness job it is not configured to launch, are
 * left to the lease they were claimed under.
 */
export const runNextHarnessAttempt = (
  options: HarnessWorkerOptions,
): Effect.Effect<HarnessAttemptOutcome, ControlPlaneRequestFailed> =>
  Effect.gen(function* () {
    const claimed = yield* claimDueJob(options)
    if (claimed === undefined) return { outcome: "idle" } as const
    if (claimed.kind !== "harness.review")
      return { outcome: "unsupported", jobId: claimed.id } as const
    const attempt = yield* prepareAttempt(claimed, options)
    if (attempt.kind === "unsuitable") {
      return {
        outcome: "unsuitable",
        jobId: claimed.id,
        reason: attempt.reason,
      } as const
    }
    // Only what the launch did ends the attempt through the fail route. A
    // control-plane request that failed says nothing about the executor, so it
    // surfaces as the transport fault it is instead of a spent attempt, and
    // the compiler proves the split: the two tags below are the only failures
    // a launch can express.
    return yield* Effect.catchTags(
      runPreparedAttempt(options, claimed, attempt),
      {
        ExecutorFailed: (failure) =>
          failAttempt(options, claimed, failure.message),
        ProvenanceUnverified: (failure) =>
          failAttempt(options, claimed, failure.message),
      },
    )
  })

/**
 * Admits the settings an attempt may run under.
 *
 * The executor timeout is checked against the lease TTL here because the
 * control plane has no lease renewal: an executor still running when its lease
 * expires is recovered as an abandoned attempt and re-leased, so a second
 * executor would run the same review while the first is still working. The
 * check reserves `REPORTING_MARGIN_MS` on top of the timeout because the
 * attempt's wall time also covers the claim and the report, neither of which
 * the timeout bounds.
 */
export const harnessWorkerOptions = (
  settings: HarnessWorkerSettings,
): Effect.Effect<HarnessWorkerOptions, InvalidWorkerOptions> => {
  if (!isBoundedDuration(settings.leaseTtlMs, 1))
    return optionsFailure("lease ttl must be a positive bounded duration")
  if (!isBoundedDuration(settings.executorTimeoutMs, 1))
    return optionsFailure("executor timeout must be a positive bounded duration")
  if (settings.executorTimeoutMs + REPORTING_MARGIN_MS > settings.leaseTtlMs)
    return optionsFailure(
      `executor timeout must leave the lease ${String(REPORTING_MARGIN_MS)}ms to report the attempt`,
    )
  const options: HarnessWorkerOptions = {
    ...settings,
    spawner: settings.spawner(settings.executorTimeoutMs, settings.environment),
    __brand: "HarnessWorkerOptions",
  }
  return Effect.succeed(options)
}

export const MAX_EXECUTOR_STDOUT_BYTES = 65_536

/**
 * Runs a launch plan as a child process.
 *
 * The child is given an environment built from the plan's allowlist rather
 * than the launcher's own: a variable the allowlist does not name is absent
 * from the process the supervisor creates, not only from the executor that
 * plan's argv eventually execs. The child leads its own process group, so
 * every kill path here reaches the tool subprocesses an agent CLI starts
 * rather than only the process the supervisor spawned. An interrupted launch
 * takes that whole group with it.
 */
export const spawnHarnessExecutor = (
  executorTimeoutMs: number,
  environment: LaunchEnvironment,
): HarnessSpawner =>
  (plan) =>
    Effect.async<HarnessExecution, ExecutorFailed>((resume) => {
      const child = spawnChild(plan, environment)
      if (child === undefined) {
        resume(executorFailure("executor could not be spawned"))
        return
      }
      const chunks: Buffer[] = []
      const diagnostics: Buffer[] = []
      let byteLength = 0
      let diagnosticBytes = 0
      let settled = false
      let drain: NodeJS.Timeout | undefined
      // Nothing more is read once the outcome is decided, and a pipe a
      // surviving descendant still holds would keep the supervisor's own loop
      // alive long past the attempt that opened it.
      const releasePipes = (): void => {
        child.stdout.destroy()
        child.stderr.destroy()
      }
      const settle = (
        exit: Effect.Effect<HarnessExecution, ExecutorFailed>,
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (drain !== undefined) clearTimeout(drain)
        releasePipes()
        resume(exit)
      }
      const settleExit = (code: number | null): void =>
        settle(
          code === null
            ? executorFailure("executor terminated without an exit code")
            : Effect.succeed({
                exitCode: code,
                stdout: Buffer.concat(chunks).toString("utf8"),
                stderr: Buffer.concat(diagnostics).toString("utf8"),
              }),
        )
      const timer = setTimeout(() => {
        killGroup(child, "SIGKILL")
        settle(executorFailure("executor timed out"))
      }, executorTimeoutMs)
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
        byteLength += chunk.byteLength
        if (byteLength <= MAX_EXECUTOR_STDOUT_BYTES) return
        // The kill is asynchronous, so a listener left attached would keep
        // buffering output the refusal has already decided to discard.
        child.stdout.removeAllListeners("data")
        killGroup(child, "SIGKILL")
        settle(executorFailure("executor output exceeded bounds"))
      })
      child.stderr.on("data", (chunk: Buffer) => {
        if (diagnosticBytes >= MAX_EXECUTOR_STDERR_BYTES) return
        diagnostics.push(chunk)
        diagnosticBytes += chunk.byteLength
      })
      // A pipe that fails after its process was killed says nothing the
      // attempt's outcome does not already say, and an unhandled stream error
      // would take the supervisor down with it.
      child.stdout.on("error", ignoreStreamFailure)
      child.stderr.on("error", ignoreStreamFailure)
      child.on("error", () =>
        settle(executorFailure("executor could not be spawned")),
      )
      // The attempt ends when the executor does. Waiting only for `close`
      // would wait for every descendant that inherited its stdout, so a
      // finished review whose tool subprocess still holds the pipe is reported
      // after a bounded drain instead of being lost to the timeout.
      child.on("exit", (code) => {
        drain = setTimeout(() => settleExit(code), STDIO_DRAIN_MS)
      })
      child.on("close", (code) => settleExit(code))
      // Interrupting the attempt takes the executor with it: without this the
      // supervisor's own shutdown would abandon a running harness process.
      return Effect.sync(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (drain !== undefined) clearTimeout(drain)
        releasePipes()
        killGroup(child, "SIGTERM")
        const escalation = setTimeout(
          () => killGroup(child, "SIGKILL"),
          INTERRUPT_GRACE_MS,
        )
        escalation.unref()
      })
    })

/**
 * The git a live checkout answers with.
 *
 * Provenance is established by resolving the declared head in the checkout
 * itself rather than trusting the payload it arrived in, and the job-scoped
 * worktree an approved-worktree attempt needs is created here — the launch
 * plan only names it.
 */
export const gitRepository: HarnessRepository = {
  verifyHead: (repositoryRoot, head) =>
    Effect.mapError(
      git(repositoryRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${head}^{commit}`,
      ]),
      () =>
        new ProvenanceUnverified({
          message: "declared input head is not a commit in the checkout",
        }),
    ),
  addWorktree: (repositoryRoot, worktree, head) =>
    Effect.mapError(
      git(repositoryRoot, ["worktree", "add", "--detach", worktree, head]),
      () => new ExecutorFailed({ message: "job worktree could not be created" }),
    ),
  removeWorktree: (repositoryRoot, worktree) =>
    Effect.catchAll(
      git(repositoryRoot, ["worktree", "remove", "--force", worktree]),
      () =>
        Effect.logError(
          `pi-control-plane could not remove the job worktree ${worktree}`,
        ),
    ),
}

/** Stderr kept for a failing run, beyond which further output is dropped. */
const MAX_EXECUTOR_STDERR_BYTES = 8_192

/** Diagnostic characters a failure summary carries from the executor. */
const MAX_EXECUTOR_DIAGNOSTIC_CHARS = 400

/** Grace an interrupted executor gets to exit before it is killed outright. */
const INTERRUPT_GRACE_MS = 2_000

/** Grace a finished executor's pipes get to deliver what it already wrote. */
const STDIO_DRAIN_MS = 250

/** Output a git invocation may produce before it is treated as a failure. */
const MAX_GIT_OUTPUT_BYTES = 64 * 1_024

/** How long a git invocation the launcher makes may take. */
const GIT_TIMEOUT_MS = 60_000

/**
 * The retry delay the fail envelope carries. The route requires the field, but
 * the control plane replaces it with the harness backoff for every harness
 * review, which is the only kind this worker fails — so the value sent here
 * never decides when the job runs again.
 */
const REPORTED_RETRY_DELAY_MS = 0

const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000

const MAX_HANDOFF_LINE_BYTES = 8_192

const MIN_CLAIM_ATTEMPT = 1
const MAX_CLAIM_ATTEMPT = 100

const LOWEST_PRINTABLE_CODE_POINT = 0x20
const DELETE_CODE_POINT = 0x7f

const SUCCESSFUL_HANDOFF_STATUSES = [
  "clean",
  "findings_fixed",
  "findings_pending",
] as const

class GitInvocationFailed extends Data.TaggedError("GitInvocationFailed")<{
  readonly message: string
}> {}

const runGit = promisify(execFile)

const git = (
  repositoryRoot: CanonicalPath,
  args: readonly string[],
): Effect.Effect<void, GitInvocationFailed> =>
  Effect.asVoid(
    Effect.tryPromise({
      // The signal the runtime hands the callback is aborted when the fiber is
      // interrupted, so an abandoned attempt leaves no git process behind.
      try: (signal) =>
        runGit("git", ["-C", repositoryRoot, ...args], {
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          signal,
          timeout: GIT_TIMEOUT_MS,
        }),
      catch: () =>
        new GitInvocationFailed({
          message: `git ${args[0] ?? "invocation"} failed`,
        }),
    }),
  )

interface ClaimedJob {
  readonly id: JobId
  readonly attempt: number
  readonly leaseToken: string
  readonly kind: RegisteredJobKind
  readonly payload: unknown
}

/**
 * A launch this worker admitted, or the reason it declined.
 *
 * Admission decides containment against *this worker's* home and registered
 * roots, and the payload's own form was already admitted by the enqueue
 * boundary that stored it. A refusal here therefore names a worker that cannot
 * launch the job rather than a job no worker can launch, so it is reported as
 * unsuitable instead of being charged to the job's attempt budget. The control
 * plane has no route that returns a claimed job without spending an attempt,
 * so the job is left to its lease, exactly as an unsupported kind is.
 */
type PreparedAttempt =
  | {
      readonly kind: "prepared"
      readonly payload: HarnessReviewPayload
      readonly plan: HarnessLaunchPlan
    }
  | { readonly kind: "unsuitable"; readonly reason: string }

type PreparedLaunch = Extract<PreparedAttempt, { readonly kind: "prepared" }>

const ignoreStreamFailure = (): void => undefined

/**
 * Signals the executor's whole process group. The child leads one, so the tool
 * subprocesses an agent CLI starts stop with it instead of outliving the lease
 * their parent held. A group that is already gone is signalled directly, which
 * is a no-op on a reaped child.
 */
const killGroup = (
  child: ChildProcessWithoutNullStreams,
  signal: "SIGTERM" | "SIGKILL",
): void => {
  const pid = child.pid
  if (pid === undefined) {
    child.kill(signal)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    child.kill(signal)
  }
}

const spawnChild = (
  plan: HarnessLaunchPlan,
  environment: LaunchEnvironment,
): ChildProcessWithoutNullStreams | undefined => {
  const [command, ...args] = plan.argv
  if (command === undefined) return undefined
  try {
    return spawn(command, args, {
      cwd: plan.cwd,
      detached: true,
      env: allowlistedEnvironment(plan, environment),
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch {
    return undefined
  }
}

const runPreparedAttempt = (
  options: HarnessWorkerOptions,
  claimed: ClaimedJob,
  attempt: PreparedLaunch,
): Effect.Effect<
  HarnessAttemptOutcome,
  ExecutorFailed | ProvenanceUnverified | ControlPlaneRequestFailed
> =>
  Effect.gen(function* () {
    // The executor's own handoff repeats the head it was launched against, so
    // the only place the declared head can be checked against the repository
    // is before anything runs.
    yield* options.repository.verifyHead(
      attempt.payload.repositoryRoot,
      attempt.payload.inputHeadSha,
    )
    const execution = yield* inLaunchDirectory(
      options,
      attempt,
      options.spawner(attempt.plan),
    )
    if (execution.exitCode !== 0)
      return yield* failAttempt(options, claimed, exitFailureSummary(execution))
    const handoff = yield* extractHandoff(
      execution.stdout,
      attempt.payload,
      claimed.id,
      claimed.attempt,
    )
    // Every decoded handoff is published through the completion route,
    // including a blocked or failed one: the route stores the typed handoff
    // with the attempt and owns the harness backoff, so the evidence and the
    // wait do not depend on which caller reported the outcome.
    yield* publishHandoff(options, claimed, handoff)
    return includesAny(SUCCESSFUL_HANDOFF_STATUSES, handoff.status)
      ? ({ outcome: "completed", jobId: claimed.id } as const)
      : ({
          outcome: "failed",
          jobId: claimed.id,
          reason: `harness ${handoff.status}: ${handoff.assessment}`,
        } as const)
  })

/**
 * Runs a launch in the directory its plan names. Read-only work runs in the
 * checkout it reviews, which already exists; approved-worktree work runs in a
 * job-scoped worktree that exists only for the attempt, so it is created
 * before the executor starts and removed however the attempt ends.
 */
const inLaunchDirectory = (
  options: HarnessWorkerOptions,
  attempt: PreparedLaunch,
  launch: Effect.Effect<HarnessExecution, ExecutorFailed>,
): Effect.Effect<HarnessExecution, ExecutorFailed> =>
  attempt.payload.isolation === "read-only"
    ? launch
    : Effect.acquireUseRelease(
        options.repository.addWorktree(
          attempt.payload.repositoryRoot,
          attempt.plan.cwd,
          attempt.payload.inputHeadSha,
        ),
        () => launch,
        () =>
          options.repository.removeWorktree(
            attempt.payload.repositoryRoot,
            attempt.plan.cwd,
          ),
      )

/**
 * The summary a non-zero exit is reported with. The executor's own output is
 * untrusted text, so only a bounded prefix reaches the record and every
 * control character in it becomes a space: the reason stays diagnosable
 * without letting the executor choose the shape of the record it lands in.
 */
const exitFailureSummary = (execution: HarnessExecution): string => {
  const reason = `executor exited with code ${String(execution.exitCode)}`
  const diagnostic = executorDiagnostic(execution)
  return diagnostic === "" ? reason : `${reason}: ${diagnostic}`
}

const executorDiagnostic = (execution: HarnessExecution): string =>
  printableText(
    execution.stderr.trim().length > 0 ? execution.stderr : execution.stdout,
  )
    .trim()
    .slice(0, MAX_EXECUTOR_DIAGNOSTIC_CHARS)
    .trim()

const printableText = (value: string): string =>
  Array.from(value, (character) =>
    isControlCharacter(character) ? " " : character,
  ).join("")

const isControlCharacter = (character: string): boolean => {
  const code = character.codePointAt(0)
  return (
    code !== undefined &&
    (code < LOWEST_PRINTABLE_CODE_POINT || code === DELETE_CODE_POINT)
  )
}

const allowlistedEnvironment = (
  plan: HarnessLaunchPlan,
  environment: LaunchEnvironment,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    plan.environmentAllowlist.flatMap((name): readonly [string, string][] => {
      const value = environment[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )

const isBoundedDuration = (value: number, minimum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= MAX_DURATION_MS

/**
 * The attempt numbers a claim may carry. The launch adapter and the handoff
 * decoder admit the same range, so a claim outside it is a control plane
 * breaking its own contract rather than a job this worker declines.
 */
const isClaimableAttempt = (value: unknown): boolean =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= MIN_CLAIM_ATTEMPT &&
  value <= MAX_CLAIM_ATTEMPT

const optionsFailure = <A>(
  message: string,
): Effect.Effect<A, InvalidWorkerOptions> =>
  Effect.fail(new InvalidWorkerOptions({ message }))

const requestFailure = (message: string): ControlPlaneRequestFailed =>
  new ControlPlaneRequestFailed({ message })

const executorFailure = <A>(
  message: string,
): Effect.Effect<A, ExecutorFailed> =>
  Effect.fail(new ExecutorFailed({ message }))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isRegisteredJobKind = (value: unknown): value is RegisteredJobKind =>
  typeof value === "string" && includesAny(REGISTERED_JOB_KINDS, value)

const postJson = (
  origin: string,
  path: string,
  body: unknown,
): Effect.Effect<Response, ControlPlaneRequestFailed> =>
  Effect.tryPromise({
    // The signal the runtime hands the callback is aborted when the fiber is
    // interrupted, so an abandoned attempt leaves no request in flight.
    try: (signal) =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    catch: () => requestFailure(`control plane request to ${path} failed`),
  })

const readJson = (
  response: Response,
  path: string,
): Effect.Effect<unknown, ControlPlaneRequestFailed> =>
  Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () => requestFailure(`control plane response from ${path} is not JSON`),
  })

const claimDueJob = (
  options: HarnessWorkerOptions,
): Effect.Effect<ClaimedJob | undefined, ControlPlaneRequestFailed> =>
  Effect.gen(function* () {
    const response = yield* postJson(options.origin, "/v1/worker/claim", {
      workerId: options.workerId,
      ttlMs: options.leaseTtlMs,
    })
    if (response.status === 204) return undefined
    if (response.status !== 200)
      return yield* Effect.fail(requestFailure("worker claim was rejected"))
    const body = yield* readJson(response, "/v1/worker/claim")
    const job = isRecord(body) && isRecord(body.job) ? body.job : undefined
    const spec = job !== undefined && isRecord(job.spec) ? job.spec : undefined
    const id =
      job !== undefined && typeof job.id === "string"
        ? toJobId(job.id)
        : undefined
    // The kind is narrowed to the registered set at the boundary that narrows
    // the identifier, so a kind the job runtime does not recognise is a
    // malformed claim rather than a bare string the worker carries onward.
    const kind =
      spec !== undefined && isRegisteredJobKind(spec.kind)
        ? spec.kind
        : undefined
    if (
      job === undefined ||
      spec === undefined ||
      id === undefined ||
      kind === undefined ||
      !isClaimableAttempt(job.attempt) ||
      typeof job.leaseToken !== "string" ||
      job.leaseToken.length < 1
    ) {
      return yield* Effect.fail(
        requestFailure("claimed job payload is malformed"),
      )
    }
    return {
      id,
      attempt: Number(job.attempt),
      leaseToken: job.leaseToken,
      kind,
      payload: spec.payload,
    }
  })

const prepareAttempt = (
  claimed: ClaimedJob,
  options: HarnessWorkerOptions,
): Effect.Effect<PreparedAttempt> =>
  Effect.catchAll(
    Effect.gen(function* () {
      const payload = yield* decodeHarnessReviewPayload(
        claimed.payload,
        options.home,
      )
      const plan = yield* buildHarnessLaunchPlan(
        claimed.payload,
        claimed.id,
        claimed.attempt,
        options.allowedRoots,
        options.home,
        options.environment,
      )
      return { kind: "prepared", payload, plan } as const
    }),
    (failure) =>
      Effect.succeed({ kind: "unsuitable", reason: failure.message } as const),
  )

const extractHandoff = (
  stdout: string,
  payload: HarnessReviewPayload,
  jobId: JobId,
  attempt: number,
): Effect.Effect<HarnessReviewHandoff, ExecutorFailed> => {
  if (Buffer.byteLength(stdout, "utf8") > MAX_EXECUTOR_STDOUT_BYTES)
    return executorFailure("executor output exceeded bounds")
  const line = stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .at(-1)
  if (
    line === undefined ||
    Buffer.byteLength(line, "utf8") > MAX_HANDOFF_LINE_BYTES
  ) {
    return executorFailure("executor returned no bounded handoff line")
  }
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(line) as unknown,
      catch: () =>
        new ExecutorFailed({ message: "executor handoff is not valid JSON" }),
    })
    const handoff = yield* Effect.mapError(
      decodeHarnessReviewHandoff(parsed),
      () => new ExecutorFailed({ message: "executor handoff is malformed" }),
    )
    const match = harnessHandoffAttemptMatch(handoff, payload, jobId, attempt)
    // The matcher names the binding that failed, so a rejected attempt
    // records which invariant the executor broke rather than a single
    // undiagnosable refusal. The name is one of a fixed set of literals,
    // so nothing the executor wrote reaches the summary.
    if (match.outcome !== "matched") {
      return yield* executorFailure(
        `executor handoff does not match the attempt: ${match.mismatch}`,
      )
    }
    return handoff
  })
}

/**
 * Reports an attempt that produced no handoff: an executor that could not run,
 * exited badly, or wrote output no handoff could be read from. An attempt that
 * did produce one is published instead, whatever the handoff says.
 */
const failAttempt = (
  options: HarnessWorkerOptions,
  claimed: ClaimedJob,
  reason: string,
): Effect.Effect<HarnessAttemptOutcome, ControlPlaneRequestFailed> =>
  Effect.gen(function* () {
    const response = yield* postJson(
      options.origin,
      `/v1/jobs/${claimed.id}/fail`,
      {
        leaseToken: claimed.leaseToken,
        retryDelayMs: REPORTED_RETRY_DELAY_MS,
        summary: reason,
      },
    )
    if (response.status !== 200)
      return yield* Effect.fail(requestFailure("attempt failure was rejected"))
    return { outcome: "failed", jobId: claimed.id, reason } as const
  })

const publishHandoff = (
  options: HarnessWorkerOptions,
  claimed: ClaimedJob,
  handoff: HarnessReviewHandoff,
): Effect.Effect<void, ControlPlaneRequestFailed> =>
  Effect.gen(function* () {
    const response = yield* postJson(
      options.origin,
      `/v1/jobs/${claimed.id}/complete`,
      { leaseToken: claimed.leaseToken, handoff },
    )
    if (response.status !== 200)
      return yield* Effect.fail(requestFailure("attempt handoff was rejected"))
  })
