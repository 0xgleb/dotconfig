import type {
  CursorReviewModel,
  HarnessReviewPayload,
} from "./harness-protocol.ts"

/**
 * Source-fixed launch tables for the subscription harness lanes.
 *
 * Every launcher reads its environment allowlist and command template from
 * this module so each security-relevant table exists exactly once: a variable
 * absent from the allowlist here is absent from every lane that launches a
 * harness, and no launcher can drift by keeping a private copy.
 */

/** The environment a launcher hands the harness variables from. */
export type LaunchEnvironment = Readonly<Record<string, string | undefined>>

/**
 * The only variables a harness process inherits.
 *
 * The launch prefix clears the environment and then restores exactly these, so
 * containment does not depend on having enumerated the provider variables that
 * exist: an API key, endpoint override, proxy, custom request header, or
 * certificate bundle the control plane never heard of is gone by
 * construction, and a variable reaches the executor only because it is named
 * here.
 *
 * HOME carries the subscription credentials each lane authenticates with and
 * PATH finds its executable. SHELL, TERM, USER, LANG, LC_ALL and TMPDIR are
 * the account and locale context a terminal program needs to run and to write
 * a readable handoff.
 */
export const LAUNCH_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
] as const

/**
 * Builds the environment prefix every harness argv starts with: `env -i`
 * clears the launcher's environment, and only the allowlisted variables it
 * actually defines are restored. An unset variable is omitted rather than
 * restored as an empty string, so the harness sees the same absence its
 * launcher saw.
 */
export const allowlistedLaunchPrefix = (
  environment: LaunchEnvironment,
): readonly string[] => [
  "env",
  "-i",
  ...LAUNCH_ENVIRONMENT_ALLOWLIST.flatMap((name) => {
    const value = environment[name]
    return value === undefined ? [] : [`${name}=${value}`]
  }),
]

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
