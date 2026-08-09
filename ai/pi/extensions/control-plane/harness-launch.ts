import type {
  CursorReviewModel,
  HarnessReviewPayload,
} from "./harness-protocol.ts"

/**
 * Source-fixed launch tables for the subscription harness lanes.
 *
 * Every launcher reads its environment scrub list and command template from
 * this module so each security-relevant table exists exactly once: a provider
 * variable added here is scrubbed by every lane that launches that harness,
 * and no launcher can drift by keeping a private copy.
 */

export const CLAUDE_SCRUBBED_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const

export const CURSOR_SCRUBBED_ENVIRONMENT = [
  "CURSOR_API_KEY",
  "CURSOR_API_ENDPOINT",
] as const

/**
 * Argv for the Claude subscription lane, always headless and always with the
 * permission mode its isolation allows.
 *
 * The executor is invoked directly rather than through an interactive session
 * wrapper: a wrapper supplies its own settings and permission mode, and a
 * fullscreen session prints no handoff for the supervisor to read, so the
 * posture this module pins would be replaced by whatever the wrapper injects.
 * The mode is part of the command rather than an argument a caller appends,
 * so no launch can omit it.
 */
export const claudeSubscriptionCommand = (
  isolation: HarnessReviewPayload["isolation"],
): readonly string[] => [
  ...CLAUDE_HEADLESS_COMMAND,
  "--permission-mode",
  CLAUDE_PERMISSION_MODES[isolation],
]

export const CURSOR_PROBE_COMMAND = [
  "cursor-agent",
  "-p",
  "--mode",
  "plan",
] as const

export const CURSOR_MODEL_ARGUMENTS: Readonly<
  Record<CursorReviewModel, string>
> = {
  "grok-4.5": "grok-4.5-xhigh",
  "composer-2.5": "composer-2.5",
}

export const scrubbedLaunchPrefix = (
  scrubbed: readonly string[],
): readonly string[] => ["env", ...scrubbed.flatMap((name) => ["-u", name])]

const CLAUDE_HEADLESS_COMMAND = [
  "claude",
  "-p",
  "--no-session-persistence",
] as const

/**
 * Permission mode each isolation launches with. Read-only work plans and never
 * writes; approved-worktree work accepts edits confined to the worktree the
 * adapter created for the attempt. No lane launches with a mode that skips
 * permissions or approves tools on the executor's own say-so.
 */
const CLAUDE_PERMISSION_MODES: Readonly<
  Record<HarnessReviewPayload["isolation"], "plan" | "acceptEdits">
> = {
  "read-only": "plan",
  "approved-worktree": "acceptEdits",
}
