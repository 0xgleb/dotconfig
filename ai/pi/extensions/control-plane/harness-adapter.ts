import { join } from "node:path"
import { Data, Effect } from "effect"
import {
  allowlistedLaunchPrefix,
  claudeSubscriptionCommand,
  CURSOR_MODEL_ARGUMENTS,
  CURSOR_PROBE_COMMAND,
  LAUNCH_ENVIRONMENT_ALLOWLIST,
  type LaunchEnvironment,
} from "./harness-launch.ts"
import {
  decodeHarnessReviewPayload,
  includesAny,
  toJobId,
  type HarnessLane,
  type HarnessReviewPayload,
  type JobId,
} from "./harness-protocol.ts"
import {
  canonicalPath,
  pathSegments,
  WORKTREE_DIRECTORY,
  type CanonicalPath,
} from "./review-duty-profile.ts"

export { toJobId, type JobId, type LaunchEnvironment }

export interface HarnessLaunchPlan {
  readonly lane: HarnessLane
  /**
   * Directory the harness process runs in. Read-only work runs in the
   * validated checkout; approved-worktree work runs in a job-scoped worktree
   * under the checkout's `.worktrees/` directory, which the launcher creates
   * before spawning the process.
   */
  readonly cwd: CanonicalPath
  readonly argv: readonly string[]
  /**
   * Names of the only variables the launched process inherits. `argv` clears
   * the environment and restores these, so a variable outside the list cannot
   * reach the executor.
   */
  readonly environmentAllowlist: readonly string[]
}

/**
 * A checkout root the supervisor has registered as launchable, in canonical
 * form. `toCanonicalWorkspaceRoot` is the only way to obtain one, so a root
 * assembled from configuration cannot reach a launch without passing the same
 * check the launch itself applies.
 *
 * Containment against these roots is lexical: this module performs no
 * filesystem access, so it cannot see through a symlink. A caller resolves
 * every root with `realpath` — and refuses symlinked candidates — before
 * registering it here.
 */
export type CanonicalWorkspaceRoot = string & {
  readonly __brand: "CanonicalWorkspaceRoot"
}

export type RegisteredWorkspaceRoots = readonly CanonicalWorkspaceRoot[]

export const toCanonicalWorkspaceRoot = (
  root: string,
): CanonicalWorkspaceRoot | undefined =>
  canonicalPath(root) === undefined
    ? undefined
    : (root as CanonicalWorkspaceRoot)

export class HarnessAdapterError extends Data.TaggedError(
  "HarnessAdapterError",
)<{
  readonly code: "invalid_input"
  readonly message: string
}> {}

/**
 * Builds the source-fixed launch plan for a validated harness review payload.
 *
 * The payload is decoded against the checkouts registered under `home`, and
 * its repositoryRoot must additionally equal one of `allowedRoots` or live
 * under `<root>/.worktrees/`; a payload naming any other directory — even one
 * whose basename matches the repository — is refused, and so is a derived
 * worktree that would fall outside those roots.
 *
 * `environment` is the launcher's own environment. Only its allowlisted
 * variables reach the plan's argv, so the plan carries no variable the
 * allowlist does not name.
 */
export const buildHarnessLaunchPlan = (
  payload: unknown,
  jobId: string,
  attempt: number,
  allowedRoots: RegisteredWorkspaceRoots,
  home: CanonicalPath,
  environment: LaunchEnvironment,
): Effect.Effect<HarnessLaunchPlan, HarnessAdapterError> => {
  const id = toJobId(jobId)
  if (id === undefined)
    return invalid("harness launch requires a bounded job identifier")
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100)
    return invalid("harness launch requires a bounded attempt number")
  if (allowedRoots.length < 1 || !allowedRoots.every(isCanonicalRoot))
    return invalid("harness launch requires canonical registered workspace roots")
  return Effect.flatMap(
    Effect.mapError(
      decodeHarnessReviewPayload(payload, home),
      (failure) =>
        new HarnessAdapterError({
          code: "invalid_input",
          message: failure.message,
        }),
    ),
    (decoded) =>
      rootIsRegistered(decoded.repositoryRoot, allowedRoots)
        ? Effect.flatMap(launchDirectory(decoded, id, attempt), (cwd) =>
            rootIsRegistered(cwd, allowedRoots)
              ? Effect.succeed(
                  launchPlan(decoded, cwd, id, attempt, environment),
                )
              : invalid(
                  "isolated worktree is outside the registered workspace roots",
                ),
          )
        : invalid("repository root is outside the registered workspace roots"),
  )
}

const invalid = <A>(message: string): Effect.Effect<A, HarnessAdapterError> =>
  Effect.fail(new HarnessAdapterError({ code: "invalid_input", message }))

const isCanonicalRoot = (root: string): boolean =>
  toCanonicalWorkspaceRoot(root) !== undefined

const rootIsRegistered = (
  root: string,
  allowedRoots: RegisteredWorkspaceRoots,
): boolean =>
  allowedRoots.some(
    (allowed) =>
      root === allowed ||
      root.startsWith(`${allowed}/${WORKTREE_DIRECTORY}/`),
  )

/**
 * Resolves the directory a payload is allowed to run in. Approved-worktree
 * work never runs in the checkout it reviews: it runs in a job-scoped
 * worktree, and a payload that already names a worktree cannot host one, so
 * such a launch is refused rather than silently downgraded to the checkout.
 */
const launchDirectory = (
  payload: HarnessReviewPayload,
  jobId: JobId,
  attempt: number,
): Effect.Effect<CanonicalPath, HarnessAdapterError> => {
  const root = payload.repositoryRoot
  if (payload.isolation === "read-only") return Effect.succeed(root)
  if (includesAny(pathSegments(root), WORKTREE_DIRECTORY))
    return invalid("approved-worktree isolation requires a primary checkout")
  const worktree = canonicalPath(
    join(root, WORKTREE_DIRECTORY, `${jobId}-${String(attempt)}`),
  )
  return worktree === undefined
    ? invalid("isolated worktree path is not canonical")
    : Effect.succeed(worktree)
}

const handoffContract = (jobId: JobId, attempt: number): string =>
  `At completion, return exactly one bounded harness handoff v1 for job ${jobId} attempt ${String(attempt)} with matching lane, repository, pull request, and input head SHA. Never include prompts, reasoning, credentials, diffs, or raw logs, and never treat model output as approval or merge authority.`

const claudePrompt = (
  payload: Extract<HarnessReviewPayload, { readonly lane: "claude-code-max" }>,
  cwd: CanonicalPath,
  jobId: JobId,
  attempt: number,
): string =>
  payload.task === "review-pr"
    ? `You are a fresh Claude Code subscription-harness review executor for ${payload.repository}#${payload.pullRequest}, kind ${payload.kind}, input head ${payload.inputHeadSha}, profile ${payload.profile}. Verify the unchanged input head, then invoke the shared review-pr skill exactly. Assigned work is read-only: no checkout, no mutation, empty-body pending inline-only, and never a submitted verdict. Run an independent native Fable verification before handoff; report blocked if it is unavailable. Never use an Anthropic API provider, SDK, curl, or paid API key. ${handoffContract(jobId, attempt)}`
    : `You are a fresh Claude Code subscription-harness review executor for ${payload.repository}#${payload.pullRequest}, kind ${payload.kind}, input head ${payload.inputHeadSha}, profile ${payload.profile}. Verify the unchanged input head, then invoke the shared review-loop skill exactly inside the approved-worktree isolation at ${cwd}; fix only verified findings and follow delivery rules without merging. Run an independent native Fable verification before handoff; report blocked if it is unavailable. Never use an Anthropic API provider, SDK, curl, or paid API key. ${handoffContract(jobId, attempt)}`

const cursorPrompt = (
  payload: Extract<
    HarnessReviewPayload,
    { readonly lane: "cursor-subscription" }
  >,
  jobId: JobId,
  attempt: number,
): string =>
  `You are a read-only Cursor review probe for ${payload.repository}#${payload.pullRequest}, input head ${payload.inputHeadSha}, profile ${payload.profile}. Inspect the pull request in plan mode without mutating any file, branch, or review state, and report bounded findings only. ${handoffContract(jobId, attempt)}`

const launchPlan = (
  payload: HarnessReviewPayload,
  cwd: CanonicalPath,
  jobId: JobId,
  attempt: number,
  environment: LaunchEnvironment,
): HarnessLaunchPlan =>
  payload.lane === "claude-code-max"
    ? {
        lane: payload.lane,
        cwd,
        environmentAllowlist: LAUNCH_ENVIRONMENT_ALLOWLIST,
        argv: [
          ...allowlistedLaunchPrefix(environment),
          ...claudeSubscriptionCommand(payload.isolation),
          claudePrompt(payload, cwd, jobId, attempt),
        ],
      }
    : {
        lane: payload.lane,
        cwd,
        environmentAllowlist: LAUNCH_ENVIRONMENT_ALLOWLIST,
        argv: [
          ...allowlistedLaunchPrefix(environment),
          ...CURSOR_PROBE_COMMAND,
          "--model",
          CURSOR_MODEL_ARGUMENTS[payload.model],
          "--trust",
          "--workspace",
          cwd,
          cursorPrompt(payload, jobId, attempt),
        ],
      }
