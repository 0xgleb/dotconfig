import { Data, Effect } from "effect"
import {
  decodeHarnessReviewPayload,
  isSafeHarnessJobId,
  type CursorReviewModel,
  type HarnessLane,
  type HarnessReviewPayload,
} from "./harness-protocol.ts"

export interface HarnessLaunchPlan {
  readonly lane: HarnessLane
  readonly cwd: string
  readonly argv: readonly string[]
  readonly scrubbedEnvironment: readonly string[]
}

export class HarnessAdapterError extends Data.TaggedError(
  "HarnessAdapterError",
)<{
  readonly code: "invalid_input"
  readonly message: string
}> {}

/**
 * Builds the source-fixed launch plan for a validated harness review payload.
 *
 * `allowedRoots` is the caller's registry of repository root directories (the
 * supervisor's workspace roots). When provided, the payload's repositoryRoot
 * must equal one of them or live under `<root>/.worktrees/`; a payload naming
 * any other directory — even one whose basename matches the repository — is
 * refused. Omitting it skips this containment check and leaves only the
 * protocol-level segment binding, which callers should treat as a weaker
 * fallback for contexts that have no root registry yet.
 */
export const buildHarnessLaunchPlan = (
  payload: unknown,
  jobId: string,
  attempt: number,
  allowedRoots?: readonly string[],
): Effect.Effect<HarnessLaunchPlan, HarnessAdapterError> => {
  if (!isSafeHarnessJobId(jobId))
    return invalid("harness launch requires a bounded job identifier")
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100)
    return invalid("harness launch requires a bounded attempt number")
  return Effect.flatMap(
    Effect.mapError(
      decodeHarnessReviewPayload(payload),
      (failure) =>
        new HarnessAdapterError({
          code: "invalid_input",
          message: failure.message,
        }),
    ),
    (decoded) =>
      allowedRoots !== undefined &&
      !rootIsRegistered(decoded.repositoryRoot, allowedRoots)
        ? invalid("repository root is outside the registered workspace roots")
        : Effect.succeed(launchPlan(decoded, jobId, attempt)),
  )
}

const invalid = <A>(message: string): Effect.Effect<A, HarnessAdapterError> =>
  Effect.fail(new HarnessAdapterError({ code: "invalid_input", message }))

const rootIsRegistered = (
  root: string,
  allowedRoots: readonly string[],
): boolean =>
  allowedRoots.some(
    (allowed) => root === allowed || root.startsWith(`${allowed}/.worktrees/`),
  )

const CLAUDE_SCRUBBED_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const

const CURSOR_SCRUBBED_ENVIRONMENT = ["CURSOR_API_KEY"] as const

const CURSOR_MODEL_ARGUMENTS: Readonly<Record<CursorReviewModel, string>> = {
  "grok-4.5": "grok-4.5-xhigh",
  "composer-2.5": "composer-2.5",
}

const handoffContract = (jobId: string, attempt: number): string =>
  `At completion, return exactly one bounded harness handoff v1 for job ${jobId} attempt ${String(attempt)} with matching lane, repository, pull request, and input head SHA. Never include prompts, reasoning, credentials, diffs, or raw logs, and never treat model output as approval or merge authority.`

const claudePrompt = (
  payload: Extract<HarnessReviewPayload, { readonly lane: "claude-code-max" }>,
  jobId: string,
  attempt: number,
): string =>
  payload.task === "review-pr"
    ? `You are a fresh Claude Code subscription-harness review executor for ${payload.repository}#${payload.pullRequest}, kind ${payload.kind}, input head ${payload.inputHeadSha}, profile ${payload.profile}. Verify the unchanged input head, then invoke the shared review-pr skill exactly. Assigned work is read-only: no checkout, no mutation, empty-body pending inline-only, and never a submitted verdict. Run an independent native Fable verification before handoff; report blocked if it is unavailable. Never use an Anthropic API provider, SDK, curl, or paid API key. ${handoffContract(jobId, attempt)}`
    : `You are a fresh Claude Code subscription-harness review executor for ${payload.repository}#${payload.pullRequest}, kind ${payload.kind}, input head ${payload.inputHeadSha}, profile ${payload.profile}. Verify the unchanged input head, then invoke the shared review-loop skill exactly inside approved-worktree isolation; fix only verified findings and follow delivery rules without merging. Run an independent native Fable verification before handoff; report blocked if it is unavailable. Never use an Anthropic API provider, SDK, curl, or paid API key. ${handoffContract(jobId, attempt)}`

const cursorPrompt = (
  payload: Extract<
    HarnessReviewPayload,
    { readonly lane: "cursor-subscription" }
  >,
  jobId: string,
  attempt: number,
): string =>
  `You are a read-only Cursor review probe for ${payload.repository}#${payload.pullRequest}, input head ${payload.inputHeadSha}, profile ${payload.profile}. Inspect the pull request in plan mode without mutating any file, branch, or review state, and report bounded findings only. ${handoffContract(jobId, attempt)}`

const launchPlan = (
  payload: HarnessReviewPayload,
  jobId: string,
  attempt: number,
): HarnessLaunchPlan =>
  payload.lane === "claude-code-max"
    ? {
        lane: payload.lane,
        cwd: payload.repositoryRoot,
        scrubbedEnvironment: CLAUDE_SCRUBBED_ENVIRONMENT,
        argv: [
          "env",
          ...CLAUDE_SCRUBBED_ENVIRONMENT.flatMap((name) => ["-u", name]),
          "jf",
          "clanker",
          "--claude",
          "--new",
          claudePrompt(payload, jobId, attempt),
        ],
      }
    : {
        lane: payload.lane,
        cwd: payload.repositoryRoot,
        scrubbedEnvironment: CURSOR_SCRUBBED_ENVIRONMENT,
        argv: [
          "env",
          ...CURSOR_SCRUBBED_ENVIRONMENT.flatMap((name) => ["-u", name]),
          "cursor-agent",
          "-p",
          "--mode",
          "plan",
          "--model",
          CURSOR_MODEL_ARGUMENTS[payload.model],
          "--trust",
          "--workspace",
          payload.repositoryRoot,
          cursorPrompt(payload, jobId, attempt),
        ],
      }
