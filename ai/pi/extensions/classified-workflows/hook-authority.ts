import { Data, Either } from "effect"
import type { Decision } from "./core.ts"
import type {
  ClassificationRequest,
  GitHookAuthorityMode,
} from "./lifecycle.ts"

export interface GitHookAuthorityFlags {
  registerFlag(
    name: string,
    options: { description: string; type: "string"; default: string },
  ): void
  getFlag(name: string): unknown
}

export type GitHookAuthority = (
  request: ClassificationRequest,
  classify: (request: ClassificationRequest) => Promise<Decision>,
) => Promise<Decision>

export class GitHookAuthorityFlagError extends Data.TaggedError(
  "GitHookAuthorityFlagError",
)<{ readonly message: string }> {}

// The managed CLI flag is owner-controlled. It is never taken from a tool
// subject, environment variable, registry record, or model-produced text.
// Off and shadow retain legacy decisions; enforce delegates checks to Git.
export const parseGitHookAuthorityMode = (
  value: unknown,
): Either.Either<GitHookAuthorityMode, GitHookAuthorityFlagError> =>
  value === "off" || value === "shadow" || value === "enforce"
    ? Either.right(value)
    : Either.left(
        new GitHookAuthorityFlagError({
          message:
            "Invalid --git-hook-authority mode; expected off, shadow, or enforce. No classifier request was started.",
        }),
      )

export const registerGitHookAuthority = (
  flags: GitHookAuthorityFlags,
): GitHookAuthority => {
  flags.registerFlag("git-hook-authority", {
    description:
      "Hook assurance: off/shadow retain legacy policy; enforce delegates configured checks to Git (owner-enabled default).",
    type: "string",
    default: "enforce",
  })
  return (request, classify) => {
    const mode = parseGitHookAuthorityMode(flags.getFlag("git-hook-authority"))
    return Either.isLeft(mode)
      ? Promise.resolve({
          verdict: "block",
          reason: mode.left.message,
          source: "deterministic",
        })
      : classify({ ...request, gitHookAuthorityMode: mode.right })
  }
}
