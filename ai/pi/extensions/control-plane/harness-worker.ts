import { spawn } from "node:child_process"
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
  type HarnessReviewHandoff,
  type HarnessReviewPayload,
  type JobId,
} from "./harness-protocol.ts"
import type { CanonicalPath } from "./review-duty-profile.ts"

export interface HarnessExecution {
  readonly exitCode: number
  readonly stdout: string
}

export type HarnessSpawner = (
  plan: HarnessLaunchPlan,
) => Effect.Effect<HarnessExecution, HarnessWorkerError>

export type HarnessAttemptOutcome =
  | { readonly outcome: "idle" }
  | { readonly outcome: "unsupported"; readonly jobId: JobId }
  | { readonly outcome: "completed"; readonly jobId: JobId }
  | {
      readonly outcome: "failed"
      readonly jobId: JobId
      readonly reason: string
    }

export interface HarnessWorkerOptions {
  readonly origin: string
  readonly workerId: string
  readonly leaseTtlMs: number
  readonly retryDelayMs: number
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
  readonly spawner: HarnessSpawner
}

export class HarnessWorkerError extends Data.TaggedError(
  "HarnessWorkerError",
)<{
  readonly code: "request_failed" | "executor_failed"
  readonly message: string
}> {}

const SUCCESSFUL_HANDOFF_STATUSES = [
  "clean",
  "findings_fixed",
  "findings_pending",
] as const

export const runNextHarnessAttempt = (
  options: HarnessWorkerOptions,
): Effect.Effect<HarnessAttemptOutcome, HarnessWorkerError> =>
  Effect.gen(function* () {
    const claimed = yield* claimDueJob(options)
    if (claimed === undefined) return { outcome: "idle" } as const
    if (claimed.kind !== "harness.review")
      return { outcome: "unsupported", jobId: claimed.id } as const
    const attempt = yield* prepareAttempt(claimed, options)
    if (attempt.kind === "rejected")
      return yield* failAttempt(options, claimed, attempt.reason)
    const execution = yield* Effect.either(options.spawner(attempt.plan))
    if (execution._tag === "Left")
      return yield* failAttempt(options, claimed, execution.left.message)
    if (execution.right.exitCode !== 0) {
      return yield* failAttempt(
        options,
        claimed,
        `executor exited with code ${String(execution.right.exitCode)}`,
      )
    }
    const handoff = yield* Effect.either(
      extractHandoff(
        execution.right.stdout,
        attempt.payload,
        claimed.id,
        claimed.attempt,
      ),
    )
    if (handoff._tag === "Left")
      return yield* failAttempt(options, claimed, handoff.left.message)
    if (!includesAny(SUCCESSFUL_HANDOFF_STATUSES, handoff.right.status)) {
      return yield* failAttempt(
        options,
        claimed,
        `harness ${handoff.right.status}: ${handoff.right.assessment}`,
      )
    }
    yield* completeAttempt(options, claimed, handoff.right)
    return { outcome: "completed", jobId: claimed.id } as const
  })

export const MAX_EXECUTOR_STDOUT_BYTES = 65_536

export const spawnHarnessExecutor = (timeoutMs: number): HarnessSpawner =>
  (plan) =>
    Effect.async<HarnessExecution, HarnessWorkerError>((resume) => {
      const [command, ...args] = plan.argv
      if (command === undefined) {
        resume(executorFailure("executor argv is empty"))
        return
      }
      let child
      try {
        child = spawn(command, args, {
          cwd: plan.cwd,
          stdio: ["ignore", "pipe", "ignore"],
        })
      } catch {
        resume(executorFailure("executor could not be spawned"))
        return
      }
      const chunks: Buffer[] = []
      let byteLength = 0
      let settled = false
      const settle = (
        exit: Effect.Effect<HarnessExecution, HarnessWorkerError>,
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resume(exit)
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        settle(executorFailure("executor timed out"))
      }, timeoutMs)
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
        byteLength += chunk.byteLength
        if (byteLength > MAX_EXECUTOR_STDOUT_BYTES) {
          child.kill("SIGKILL")
          settle(executorFailure("executor output exceeded bounds"))
        }
      })
      child.on("error", () =>
        settle(executorFailure("executor could not be spawned")),
      )
      child.on("close", (code) =>
        settle(
          code === null
            ? executorFailure("executor terminated without an exit code")
            : Effect.succeed({
                exitCode: code,
                stdout: Buffer.concat(chunks).toString("utf8"),
              }),
        ),
      )
    })

interface ClaimedJob {
  readonly id: JobId
  readonly attempt: number
  readonly leaseToken: string
  readonly kind: string
  readonly payload: unknown
}

const requestFailure = (message: string): HarnessWorkerError =>
  new HarnessWorkerError({ code: "request_failed", message })

const executorFailure = <A>(
  message: string,
): Effect.Effect<A, HarnessWorkerError> =>
  Effect.fail(new HarnessWorkerError({ code: "executor_failed", message }))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const postJson = (
  origin: string,
  path: string,
  body: unknown,
): Effect.Effect<Response, HarnessWorkerError> =>
  Effect.tryPromise({
    try: () =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    catch: () => requestFailure(`control plane request to ${path} failed`),
  })

const readJson = (
  response: Response,
  path: string,
): Effect.Effect<unknown, HarnessWorkerError> =>
  Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () => requestFailure(`control plane response from ${path} is not JSON`),
  })

const claimDueJob = (
  options: HarnessWorkerOptions,
): Effect.Effect<ClaimedJob | undefined, HarnessWorkerError> =>
  Effect.gen(function* () {
    const response = yield* postJson(options.origin, "/v1/worker/claim", {
      workerId: options.workerId,
      ttlMs: options.leaseTtlMs,
    })
    if (response.status === 204) return undefined
    if (response.status !== 200)
      return yield* Effect.fail(requestFailure("worker claim was rejected"))
    const body = yield* readJson(response, "/v1/worker/claim")
    const id =
      isRecord(body) && isRecord(body.job) && typeof body.job.id === "string"
        ? toJobId(body.job.id)
        : undefined
    if (
      !isRecord(body) ||
      !isRecord(body.job) ||
      id === undefined ||
      !Number.isSafeInteger(body.job.attempt) ||
      typeof body.job.leaseToken !== "string" ||
      body.job.leaseToken.length < 1 ||
      !isRecord(body.job.spec) ||
      typeof body.job.spec.kind !== "string"
    ) {
      return yield* Effect.fail(
        requestFailure("claimed job payload is malformed"),
      )
    }
    return {
      id,
      attempt: Number(body.job.attempt),
      leaseToken: body.job.leaseToken,
      kind: body.job.spec.kind,
      payload: body.job.spec.payload,
    }
  })

type PreparedAttempt =
  | {
      readonly kind: "prepared"
      readonly payload: HarnessReviewPayload
      readonly plan: HarnessLaunchPlan
    }
  | { readonly kind: "rejected"; readonly reason: string }

const prepareAttempt = (
  claimed: ClaimedJob,
  options: HarnessWorkerOptions,
): Effect.Effect<PreparedAttempt, HarnessWorkerError> =>
  Effect.gen(function* () {
    const payload = yield* Effect.either(
      decodeHarnessReviewPayload(claimed.payload, options.home),
    )
    if (payload._tag === "Left")
      return { kind: "rejected", reason: "stored harness payload is invalid" } as const
    const plan = yield* Effect.either(
      buildHarnessLaunchPlan(
        claimed.payload,
        claimed.id,
        claimed.attempt,
        options.allowedRoots,
        options.home,
        options.environment,
      ),
    )
    if (plan._tag === "Left")
      return { kind: "rejected", reason: "harness launch plan was refused" } as const
    return {
      kind: "prepared",
      payload: payload.right,
      plan: plan.right,
    } as const
  })

const MAX_HANDOFF_LINE_BYTES = 8_192

const extractHandoff = (
  stdout: string,
  payload: HarnessReviewPayload,
  jobId: JobId,
  attempt: number,
): Effect.Effect<HarnessReviewHandoff, HarnessWorkerError> => {
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
  return Effect.flatMap(
    Effect.try({
      try: () => JSON.parse(line) as unknown,
      catch: () =>
        new HarnessWorkerError({
          code: "executor_failed",
          message: "executor handoff is not valid JSON",
        }),
    }),
    (parsed) =>
      Effect.flatMap(
        Effect.mapError(
          decodeHarnessReviewHandoff(parsed),
          () =>
            new HarnessWorkerError({
              code: "executor_failed",
              message: "executor handoff is malformed",
            }),
        ),
        (handoff) => {
          const match = harnessHandoffAttemptMatch(
            handoff,
            payload,
            jobId,
            attempt,
          )
          // The matcher names the binding that failed, so a rejected attempt
          // records which invariant the executor broke rather than a single
          // undiagnosable refusal. The name is one of a fixed set of literals,
          // so nothing the executor wrote reaches the summary.
          return match.outcome === "matched"
            ? Effect.succeed(handoff)
            : executorFailure(
                `executor handoff does not match the attempt: ${match.mismatch}`,
              )
        },
      ),
  )
}

const failAttempt = (
  options: HarnessWorkerOptions,
  claimed: ClaimedJob,
  reason: string,
): Effect.Effect<HarnessAttemptOutcome, HarnessWorkerError> =>
  Effect.gen(function* () {
    const response = yield* postJson(
      options.origin,
      `/v1/jobs/${claimed.id}/fail`,
      {
        leaseToken: claimed.leaseToken,
        retryDelayMs: options.retryDelayMs,
        summary: reason,
      },
    )
    if (response.status !== 200)
      return yield* Effect.fail(requestFailure("attempt failure was rejected"))
    return { outcome: "failed", jobId: claimed.id, reason } as const
  })

const completeAttempt = (
  options: HarnessWorkerOptions,
  claimed: ClaimedJob,
  handoff: HarnessReviewHandoff,
): Effect.Effect<void, HarnessWorkerError> =>
  Effect.gen(function* () {
    const response = yield* postJson(
      options.origin,
      `/v1/jobs/${claimed.id}/complete`,
      { leaseToken: claimed.leaseToken, handoff },
    )
    if (response.status !== 200)
      return yield* Effect.fail(requestFailure("attempt completion was rejected"))
  })
