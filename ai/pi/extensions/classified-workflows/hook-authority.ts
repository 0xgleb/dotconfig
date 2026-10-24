import { Data, Either } from "effect"
import type { Decision } from "./core.ts"
import type { ClassificationRequest } from "./lifecycle.ts"

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
// Retired configuration must fail explicitly, never restore an older policy.
export const parseGitHookAuthorityMode = (
  value: unknown,
): Either.Either<"enforce", GitHookAuthorityFlagError> =>
  value === "enforce"
    ? Either.right(value)
    : Either.left(
        new GitHookAuthorityFlagError({
          message:
            value === "off" || value === "shadow"
              ? "Retired --git-hook-authority mode; off and shadow are no longer supported. Use enforce. No classifier request was started."
              : "Invalid --git-hook-authority mode; expected enforce. No classifier request was started.",
        }),
      )

export const registerGitHookAuthority = (
  flags: GitHookAuthorityFlags,
): GitHookAuthority => {
  flags.registerFlag("git-hook-authority", {
    description:
      "Configured checks are enforced by Git hooks. Only enforce is supported.",
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
