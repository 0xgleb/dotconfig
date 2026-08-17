import { execFile, spawn, type ChildProcessByStdio } from "node:child_process"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { promisify } from "node:util"
import { Clock, Data, Effect } from "effect"
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
  toCommitSha,
  toJobId,
  type CommitSha,
  type HarnessReviewHandoff,
  type HarnessReviewPayload,
  type JobId,
} from "./harness-protocol.ts"
import { REGISTERED_JOB_KINDS, type RegisteredJobKind } from "./job-runtime.ts"
import {
  canonicalPath,
  WORKTREE_DIRECTORY,
  type CanonicalPath,
} from "./review-duty-profile.ts"

type HarnessChildProcess = ChildProcessByStdio<null, Readable, Readable>

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
 * A control-plane exchange that cannot safely complete. This includes a
 * failed or malformed request/response and a claim whose lease no longer
 * covers the next phase. It says nothing chargeable about the executor, so it
 * is never reported as a spent attempt.
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
  quarantineWorktree?: () => void,
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
  /** Creates the commit-pinned job worktree an attempt runs in. */
  readonly addWorktree: (
    repositoryRoot: CanonicalPath,
    worktree: CanonicalPath,
    head: CommitSha,
  ) => Effect.Effect<void, ExecutorFailed>
  /** Refuses a read-only result if its pinned head or files were mutated. */
  readonly verifyUnchanged: (
    worktree: CanonicalPath,
    expectedHead: CommitSha,
  ) => Effect.Effect<void, ExecutorFailed>
  /** Binds an approved-worktree handoff to the commit it actually produced. */
  readonly verifyOutputHead: (
    worktree: CanonicalPath,
    expectedHead: CommitSha,
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
 * Lease time reserved after execution for the bounded control-plane report.
 * Setup has its own statically admitted margin and the claimed absolute lease
 * deadline is checked again before setup, execution, and publication.
 */
export const REPORTING_MARGIN_MS = 10_000

/** Maximum wall time of one loopback control-plane request. */
export const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 1_000

/** Maximum bytes accepted from one loopback control-plane response. */
export const MAX_CONTROL_PLANE_RESPONSE_BYTES = 16_384

/** How long a git invocation the launcher makes may take. */
const GIT_TIMEOUT_MS = 10_000

/** Grace a finished executor's pipes get to deliver what it already wrote. */
const STDIO_DRAIN_MS = 250

/** Maximum wait for a process group after it receives SIGKILL. */
const FORCED_TERMINATION_WAIT_MS = 1_000

/** Worst-case post-execution drain and descendant-cleanup wall time. */
export const EXECUTOR_CLEANUP_MARGIN_MS =
  STDIO_DRAIN_MS + FORCED_TERMINATION_WAIT_MS

/** Head verification plus creation of the commit-pinned attempt worktree. */
export const WORKTREE_SETUP_MARGIN_MS = 2 * GIT_TIMEOUT_MS

/** Index flags, pinned HEAD, and complete worktree-state verification. */
export const READ_ONLY_VERIFICATION_MARGIN_MS = 3 * GIT_TIMEOUT_MS

/** Worst-case bounded Git work from setup through read-only verification. */
export const ATTEMPT_SETUP_MARGIN_MS =
  WORKTREE_SETUP_MARGIN_MS + READ_ONLY_VERIFICATION_MARGIN_MS

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
    return yield* runPreparedAttempt(options, claimed, attempt)
  })

/**
 * Admits the settings an attempt may run under.
 *
 * The executor timeout is checked against the lease TTL here because the
 * control plane has no lease renewal: an executor still running when its lease
 * expires is recovered as an abandoned attempt and re-leased. The check
 * reserves bounded git setup plus reporting time, while the worker also checks
 * the absolute lease deadline returned by the claim before every phase.
 */
export const harnessWorkerOptions = (
  settings: HarnessWorkerSettings,
): Effect.Effect<HarnessWorkerOptions, InvalidWorkerOptions> => {
  if (!isBoundedDuration(settings.leaseTtlMs, 1))
    return optionsFailure("lease ttl must be a positive bounded duration")
  if (!isBoundedDuration(settings.executorTimeoutMs, 1))
    return optionsFailure(
      "executor timeout must be a positive bounded duration",
    )
  const requiredMarginMs =
    ATTEMPT_SETUP_MARGIN_MS + EXECUTOR_CLEANUP_MARGIN_MS + REPORTING_MARGIN_MS
  if (settings.executorTimeoutMs + requiredMarginMs > settings.leaseTtlMs)
    return optionsFailure(
      `executor timeout must leave the lease ${String(requiredMarginMs)}ms for setup, cleanup, verification, and reporting`,
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
 * plan's argv eventually execs. The child leads its own process group, so kill
 * paths reach ordinary tool subprocesses that remain in that group rather than
 * only the process the supervisor spawned. This is a lifecycle boundary, not
 * an OS sandbox: deliberate new sessions remain governed by the existing
 * constrained-tool authority model rather than this group signal.
 */
export const spawnHarnessExecutor =
  (
    executorTimeoutMs: number,
    environment: LaunchEnvironment,
    processKill: typeof process.kill = process.kill,
  ): HarnessSpawner =>
  (plan, quarantineWorktree = ignoreStreamFailure) =>
    Effect.async<HarnessExecution, ExecutorFailed>(resume => {
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
      let terminating = false
      let exitObserved = false
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
      const terminateAndSettle = (
        signal: "SIGTERM" | "SIGKILL",
        exit: Effect.Effect<HarnessExecution, ExecutorFailed>,
      ): void => {
        if (settled || terminating) return
        terminating = true
        clearTimeout(timer)
        if (drain !== undefined) clearTimeout(drain)
        releasePipes()
        terminateProcessGroup(child, signal, processKill, terminated => {
          if (!terminated) quarantineWorktree()
          settle(
            terminated
              ? exit
              : executorFailure("executor descendants did not terminate"),
          )
        })
      }
      const timer = setTimeout(
        () =>
          terminateAndSettle("SIGKILL", executorFailure("executor timed out")),
        executorTimeoutMs,
      )
      child.stdout.on("data", (chunk: Buffer) => {
        if (byteLength + chunk.byteLength > MAX_EXECUTOR_STDOUT_BYTES) {
          // The kill is asynchronous, so a listener left attached would keep
          // buffering output the refusal has already decided to discard.
          child.stdout.removeAllListeners("data")
          terminateAndSettle(
            "SIGKILL",
            executorFailure("executor output exceeded bounds"),
          )
          return
        }
        chunks.push(chunk)
        byteLength += chunk.byteLength
      })
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = MAX_EXECUTOR_STDERR_BYTES - diagnosticBytes
        if (remaining <= 0) return
        const bounded =
          chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
        diagnostics.push(bounded)
        diagnosticBytes += bounded.byteLength
      })
      // A pipe that fails after its process was killed says nothing the
      // attempt's outcome does not already say, and an unhandled stream error
      // would take the supervisor down with it.
      child.stdout.on("error", ignoreStreamFailure)
      child.stderr.on("error", ignoreStreamFailure)
      child.on("error", () => {
        const failure = executorFailure<HarnessExecution>(
          "executor could not be spawned",
        )
        if (child.pid === undefined) {
          settle(failure)
          return
        }
        terminateAndSettle("SIGKILL", failure)
      })
      // The attempt ends when the executor does. Waiting only for `close`
      // would wait for every descendant that inherited its stdout, so a
      // finished review whose tool subprocess still holds the pipe is reported
      // after a bounded drain instead of being lost to the timeout.
      child.on("exit", code => {
        exitObserved = true
        // The executor itself has finished. From here only bounded pipe drain
        // and descendant cleanup remain; the execution timeout must not
        // relabel that post-exit bookkeeping as an executor timeout.
        clearTimeout(timer)
        // Signal immediately while the just-observed leader still identifies
        // its process group; never wait through the stdio drain before using
        // the numeric PGID, when it could have been recycled.
        killGroup(child, "SIGKILL", processKill)
        drain = setTimeout(() => {
          if (settled || terminating) return
          terminating = true
          releasePipes()
          // The parent already exited and its group was signalled immediately.
          // Await that group so an ordinary tool subprocess cannot race
          // worktree verification or teardown.
          terminateProcessGroup(child, undefined, processKill, terminated => {
            if (!terminated) quarantineWorktree()
            if (terminated) settleExit(code)
            else
              settle(executorFailure("executor descendants did not terminate"))
          })
        }, STDIO_DRAIN_MS)
      })
      child.on("close", code => {
        if (exitObserved) return
        terminateAndSettle(
          "SIGKILL",
          code === null
            ? executorFailure("executor terminated without an exit code")
            : Effect.succeed({
                exitCode: code,
                stdout: Buffer.concat(chunks).toString("utf8"),
                stderr: Buffer.concat(diagnostics).toString("utf8"),
              }),
        )
      })
      // Interrupting the attempt takes the executor with it: without this the
      // supervisor's own shutdown would abandon a running harness process.
      return Effect.async<void>(cleanupResume => {
        if (settled) {
          cleanupResume(Effect.void)
          return
        }
        settled = true
        clearTimeout(timer)
        if (drain !== undefined) clearTimeout(drain)
        releasePipes()
        terminateProcessGroup(child, "SIGTERM", processKill, terminated => {
          if (!terminated) quarantineWorktree()
          cleanupResume(Effect.void)
        })
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
      () =>
        new ExecutorFailed({ message: "job worktree could not be created" }),
    ),
  verifyUnchanged: (worktree, expectedHead) =>
    Effect.andThen(
      Effect.flatMap(
        Effect.mapError(
          gitOutput(worktree, ["ls-files", "-v", "-z"]),
          () =>
            new ExecutorFailed({
              message: "read-only worktree state could not be verified",
            }),
        ),
        output =>
          output
            .split("\0")
            .some(
              entry =>
                entry.startsWith("h ") ||
                entry.startsWith("s ") ||
                entry.startsWith("S "),
            )
            ? executorFailure("read-only executor mutated its worktree")
            : Effect.void,
      ),
      Effect.andThen(
        verifyWorktreeHead(
          worktree,
          expectedHead,
          "read-only executor moved its worktree head",
        ),
        Effect.flatMap(
          Effect.mapError(
            gitOutput(worktree, [
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
              "--ignored=matching",
            ]),
            () =>
              new ExecutorFailed({
                message: "read-only worktree state could not be verified",
              }),
          ),
          output =>
            output.length === 0
              ? Effect.void
              : executorFailure("read-only executor mutated its worktree"),
        ),
      ),
    ),
  verifyOutputHead: (worktree, expectedHead) =>
    verifyWorktreeHead(
      worktree,
      expectedHead,
      "executor output head does not match its worktree",
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
export const MAX_EXECUTOR_STDERR_BYTES = 8_192

/** Diagnostic characters a failure summary carries from the executor. */
const MAX_EXECUTOR_DIAGNOSTIC_CHARS = 400

/** Grace an interrupted executor gets to exit before it is killed outright. */
const INTERRUPT_GRACE_MS = 2_000

/** Output a git invocation may produce before it is treated as a failure. */
const MAX_GIT_OUTPUT_BYTES = 64 * 1_024

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

const gitOutput = (
  repositoryRoot: CanonicalPath,
  args: readonly string[],
): Effect.Effect<string, GitInvocationFailed> =>
  Effect.map(
    Effect.tryPromise({
      // The signal the runtime hands the callback is aborted when the fiber is
      // interrupted, so an abandoned attempt leaves no git process behind.
      try: signal =>
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
    ({ stdout }) => stdout,
  )

const git = (
  repositoryRoot: CanonicalPath,
  args: readonly string[],
): Effect.Effect<void, GitInvocationFailed> =>
  Effect.asVoid(gitOutput(repositoryRoot, args))

const verifyWorktreeHead = (
  worktree: CanonicalPath,
  expectedHead: CommitSha,
  mismatchMessage: string,
): Effect.Effect<void, ExecutorFailed> =>
  Effect.flatMap(
    Effect.mapError(
      gitOutput(worktree, ["rev-parse", "--verify", "HEAD"]),
      () =>
        new ExecutorFailed({ message: "worktree head could not be verified" }),
    ),
    output =>
      toCommitSha(output.trim()) === expectedHead
        ? Effect.void
        : executorFailure(mismatchMessage),
  )

interface ClaimedJob {
  readonly id: JobId
  readonly attempt: number
  readonly leaseToken: string
  readonly leaseUntil: number
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
 * Signals the executor's process group. Ordinary tool subprocesses inherit it
 * and stop with the parent; deliberate new sessions are outside this liveness
 * mechanism and remain subject to the harness's constrained-tool boundary.
 */
const killGroup = (
  child: HarnessChildProcess,
  signal: "SIGTERM" | "SIGKILL",
  processKill: typeof process.kill,
): void => {
  const pid = child.pid
  if (pid === undefined) {
    child.kill(signal)
    return
  }
  try {
    processKill(-pid, signal)
  } catch {
    child.kill(signal)
  }
}

const PROCESS_GROUP_POLL_MS = 10

const isErrnoWithCode = (failure: unknown, code: string): boolean =>
  failure instanceof Error &&
  "code" in failure &&
  (failure as NodeJS.ErrnoException).code === code

const processGroupIsRunning = (
  child: HarnessChildProcess,
  processKill: typeof process.kill,
): boolean => {
  const pid = child.pid
  if (pid === undefined) return child.exitCode === null
  try {
    processKill(-pid, 0)
    return true
  } catch (failure) {
    // ESRCH alone proves the group is absent. EPERM and unknown failures leave
    // liveness uncertain and therefore must run out the bounded quarantine
    // path rather than silently authorising worktree reuse.
    return !isErrnoWithCode(failure, "ESRCH")
  }
}

/** Signals the detached group and calls back only once it is gone or bounded. */
const terminateProcessGroup = (
  child: HarnessChildProcess,
  initialSignal: "SIGTERM" | "SIGKILL" | undefined,
  processKill: typeof process.kill,
  done: (terminated: boolean) => void,
): void => {
  const startedAt = Date.now()
  let forcedAt =
    initialSignal === "SIGKILL" || initialSignal === undefined
      ? startedAt
      : undefined
  if (initialSignal !== undefined) killGroup(child, initialSignal, processKill)
  const poll = (): void => {
    if (!processGroupIsRunning(child, processKill)) {
      done(true)
      return
    }
    const now = Date.now()
    if (forcedAt === undefined && now - startedAt >= INTERRUPT_GRACE_MS) {
      forcedAt = now
      killGroup(child, "SIGKILL", processKill)
    }
    if (
      forcedAt !== undefined &&
      now - forcedAt >= FORCED_TERMINATION_WAIT_MS
    ) {
      done(false)
      return
    }
    setTimeout(poll, PROCESS_GROUP_POLL_MS)
  }
  poll()
}

const spawnChild = (
  plan: HarnessLaunchPlan,
  environment: LaunchEnvironment,
): HarnessChildProcess | undefined => {
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
): Effect.Effect<HarnessAttemptOutcome, ControlPlaneRequestFailed> => {
  let worktreeQuarantined = false
  const quarantineWorktree = (): void => {
    worktreeQuarantined = true
  }
  const lifecycle = Effect.flatMap(pinnedLaunch(claimed, attempt), pinned =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        yield* ensureLeaseRemaining(
          claimed,
          options.executorTimeoutMs +
            ATTEMPT_SETUP_MARGIN_MS +
            EXECUTOR_CLEANUP_MARGIN_MS +
            REPORTING_MARGIN_MS,
        )
        yield* options.repository.verifyHead(
          pinned.payload.repositoryRoot,
          pinned.payload.inputHeadSha,
        )
        yield* options.repository.addWorktree(
          pinned.payload.repositoryRoot,
          pinned.plan.cwd,
          pinned.payload.inputHeadSha,
        )
      }),
      () =>
        Effect.catchTags(
          runPinnedAttempt(options, claimed, pinned, quarantineWorktree),
          {
            ExecutorFailed: failure =>
              reportAttemptFailure(options, claimed, failure.message),
            ProvenanceUnverified: failure =>
              reportAttemptFailure(options, claimed, failure.message),
          },
        ),
      () =>
        worktreeQuarantined
          ? Effect.logError(
              `pi-control-plane quarantined live executor worktree ${pinned.plan.cwd}`,
            )
          : options.repository.removeWorktree(
              pinned.payload.repositoryRoot,
              pinned.plan.cwd,
            ),
    ),
  )
  // Acquisition failures have no worktree to release. Failures after
  // acquisition are reported inside `use`, before the release finalizer runs,
  // so teardown cannot consume the live lease before its outcome is durable.
  return Effect.catchTags(lifecycle, {
    ExecutorFailed: failure =>
      reportAttemptFailure(options, claimed, failure.message),
    ProvenanceUnverified: failure =>
      reportAttemptFailure(options, claimed, failure.message),
  })
}

const pinnedLaunch = (
  claimed: ClaimedJob,
  attempt: PreparedLaunch,
): Effect.Effect<PreparedLaunch, ExecutorFailed> => {
  if (attempt.payload.isolation === "approved-worktree")
    return Effect.succeed(attempt)
  const worktree = canonicalPath(
    join(
      attempt.payload.repositoryRoot,
      WORKTREE_DIRECTORY,
      `${claimed.id}-${String(claimed.attempt)}`,
    ),
  )
  if (worktree === undefined)
    return executorFailure("read-only worktree path is not canonical")
  if (attempt.plan.lane === "claude-code-max")
    return Effect.succeed({
      ...attempt,
      plan: { ...attempt.plan, cwd: worktree },
    })
  const workspaceIndex = attempt.plan.argv.indexOf("--workspace")
  if (attempt.plan.argv[workspaceIndex + 1] !== attempt.plan.cwd)
    return executorFailure("cursor launch plan workspace is not source-fixed")
  return Effect.succeed({
    ...attempt,
    plan: {
      ...attempt.plan,
      cwd: worktree,
      argv: attempt.plan.argv.map((argument, index) =>
        index === workspaceIndex + 1 ? worktree : argument,
      ),
    },
  })
}

const runPinnedAttempt = (
  options: HarnessWorkerOptions,
  claimed: ClaimedJob,
  attempt: PreparedLaunch,
  quarantineWorktree: () => void,
): Effect.Effect<
  HarnessAttemptOutcome,
  ExecutorFailed | ProvenanceUnverified | ControlPlaneRequestFailed
> =>
  Effect.gen(function* () {
    const verificationMarginMs =
      attempt.payload.isolation === "read-only"
        ? READ_ONLY_VERIFICATION_MARGIN_MS
        : GIT_TIMEOUT_MS
    const postExecutionMarginMs =
      EXECUTOR_CLEANUP_MARGIN_MS + verificationMarginMs + REPORTING_MARGIN_MS
    yield* ensureLeaseRemaining(
      claimed,
      options.executorTimeoutMs + postExecutionMarginMs,
    )
    const execution = yield* options.spawner(attempt.plan, quarantineWorktree)
    if (attempt.payload.isolation === "read-only")
      yield* options.repository.verifyUnchanged(
        attempt.plan.cwd,
        attempt.payload.inputHeadSha,
      )
    if (execution.exitCode !== 0) {
      yield* ensureLeaseRemaining(claimed, REPORTING_MARGIN_MS)
      return yield* failAttempt(options, claimed, exitFailureSummary(execution))
    }
    const handoff = yield* extractHandoff(
      execution.stdout,
      attempt.payload,
      claimed.id,
      claimed.attempt,
    )
    if (attempt.payload.isolation === "approved-worktree")
      yield* options.repository.verifyOutputHead(
        attempt.plan.cwd,
        handoff.outputHeadSha,
      )
    yield* ensureLeaseRemaining(claimed, REPORTING_MARGIN_MS)
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
  Array.from(value, character =>
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

const isSafeTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

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

const ensureLeaseRemaining = (
  claimed: ClaimedJob,
  minimumMs: number,
): Effect.Effect<void, ControlPlaneRequestFailed> =>
  Effect.flatMap(Clock.currentTimeMillis, now =>
    claimed.leaseUntil - now >= minimumMs
      ? Effect.void
      : Effect.fail(requestFailure("attempt has insufficient lease remaining")),
  )

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
    try: signal =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(CONTROL_PLANE_REQUEST_TIMEOUT_MS),
        ]),
      }),
    catch: () => requestFailure(`control plane request to ${path} failed`),
  })

class ResponseBodyTooLarge extends Error {}

const readJson = (
  response: Response,
  path: string,
): Effect.Effect<unknown, ControlPlaneRequestFailed> =>
  Effect.tryPromise({
    try: async signal => {
      const body = response.body
      if (body === null) return JSON.parse("") as unknown
      const reader = body.getReader()
      const chunks: Buffer[] = []
      let byteLength = 0
      const cancel = (): void => {
        void reader.cancel().catch(ignoreStreamFailure)
      }
      signal.addEventListener("abort", cancel, { once: true })
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (
            byteLength + next.value.byteLength >
            MAX_CONTROL_PLANE_RESPONSE_BYTES
          ) {
            await reader.cancel()
            throw new ResponseBodyTooLarge()
          }
          const chunk = Buffer.from(next.value)
          chunks.push(chunk)
          byteLength += chunk.byteLength
        }
      } finally {
        signal.removeEventListener("abort", cancel)
        reader.releaseLock()
      }
      return JSON.parse(
        Buffer.concat(chunks, byteLength).toString("utf8"),
      ) as unknown
    },
    catch: failure =>
      requestFailure(
        failure instanceof ResponseBodyTooLarge
          ? `control plane response from ${path} exceeded bounds`
          : `control plane response from ${path} is not JSON`,
      ),
  })

const cancelResponseBody = (
  response: Response,
  path: string,
): Effect.Effect<void, ControlPlaneRequestFailed> =>
  response.body === null
    ? Effect.void
    : Effect.tryPromise({
        try: () => response.body?.cancel() ?? Promise.resolve(),
        catch: () =>
          requestFailure(
            `control plane response from ${path} could not be cancelled`,
          ),
      })

const claimDueJob = (
  options: HarnessWorkerOptions,
): Effect.Effect<ClaimedJob | undefined, ControlPlaneRequestFailed> =>
  Effect.gen(function* () {
    const response = yield* postJson(options.origin, "/v1/worker/claim", {
      workerId: options.workerId,
      ttlMs: options.leaseTtlMs,
      kind: "harness.review",
    })
    if (response.status === 204) {
      yield* cancelResponseBody(response, "/v1/worker/claim")
      return undefined
    }
    if (response.status !== 200) {
      yield* cancelResponseBody(response, "/v1/worker/claim")
      return yield* Effect.fail(requestFailure("worker claim was rejected"))
    }
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
      job.leaseToken.length < 1 ||
      !isSafeTimestamp(job.leaseUntil)
    ) {
      return yield* Effect.fail(
        requestFailure("claimed job payload is malformed"),
      )
    }
    const payload =
      kind === "harness.review"
        ? yield* Effect.mapError(
            decodeHarnessReviewPayload(spec.payload, options.home),
            () => requestFailure("claimed job payload is malformed"),
          )
        : spec.payload
    return {
      id,
      attempt: Number(job.attempt),
      leaseToken: job.leaseToken,
      leaseUntil: Number(job.leaseUntil),
      kind,
      payload,
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
    failure =>
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
    .map(candidate => candidate.trim())
    .filter(candidate => candidate.length > 0)
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
      return yield* executorFailure<HarnessReviewHandoff>(
        `executor handoff does not match the attempt: ${match.mismatch}`,
      )
    }
    return handoff
  })
}

/**
 * Reports a local attempt failure only while its lease can still cover the
 * bounded control-plane request. A stale claim is left to normal lease recovery
 * instead of sending an outcome the compare-and-set route must reject.
 */
const reportAttemptFailure = (
  options: HarnessWorkerOptions,
  claimed: ClaimedJob,
  reason: string,
): Effect.Effect<HarnessAttemptOutcome, ControlPlaneRequestFailed> =>
  Effect.andThen(
    ensureLeaseRemaining(claimed, REPORTING_MARGIN_MS),
    failAttempt(options, claimed, reason),
  )

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
    yield* cancelResponseBody(response, `/v1/jobs/${claimed.id}/fail`)
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
    yield* cancelResponseBody(response, `/v1/jobs/${claimed.id}/complete`)
    if (response.status !== 200)
      return yield* Effect.fail(requestFailure("attempt handoff was rejected"))
  })
