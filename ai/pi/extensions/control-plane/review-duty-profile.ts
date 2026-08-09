import { isAbsolute, normalize } from "node:path"

export const REVIEW_DUTY_PROFILES = [
  "st0x-review",
  "dataclique-review",
  "personal-review",
] as const

export type ReviewDutyProfile = (typeof REVIEW_DUTY_PROFILES)[number]

export const WORKTREE_DIRECTORY = ".worktrees"

/**
 * An `owner/name` repository identifier that passed `repositorySlug`. A
 * repository and a checkout path are both strings, so the brand is what keeps
 * the two from being swapped at the call sites that decide containment.
 */
export type RepositorySlug = string & { readonly __brand: "RepositorySlug" }

/**
 * An absolute directory path in canonical form: normalized, free of control
 * characters, without a trailing slash, and with no `.`, `..`, or empty
 * segment. Every boundary that compares, joins, or registers a path uses this
 * one form, so a path one boundary accepts can never be refused as
 * non-canonical by the next.
 */
export type CanonicalPath = string & { readonly __brand: "CanonicalPath" }

/**
 * Decides whether a canonical directory is a registered checkout of a
 * repository. `repositoryRootIsRegisteredUnder` binds the home directory the
 * registered locations are relative to, so no call site can supply one.
 */
export type RegisteredCheckoutCheck = (
  profile: ReviewDutyProfile,
  repository: RepositorySlug,
  root: CanonicalPath,
) => boolean

export const repositorySlug = (value: string): RepositorySlug | undefined =>
  SAFE_REPOSITORY.test(value) ? (value as RepositorySlug) : undefined

export const canonicalPath = (value: string): CanonicalPath | undefined =>
  value.length > 1 &&
  value.length <= MAX_PATH_LENGTH &&
  !CONTROL_CHARACTER.test(value) &&
  isAbsolute(value) &&
  normalize(value) === value &&
  !value.endsWith("/") &&
  pathSegments(value).every((segment) => segment !== "." && segment !== "..")
    ? (value as CanonicalPath)
    : undefined

export const pathSegments = (path: string): readonly string[] =>
  path.split("/").filter((segment) => segment.length > 0)

export const repositoryAllowedForProfile = (
  profile: ReviewDutyProfile,
  repository: RepositorySlug,
): boolean =>
  PROFILE_OWNERS[profile].includes(repository.split("/", 1)[0] ?? "")

export const automaticRepositoryForProfile = (
  profile: ReviewDutyProfile,
): string | undefined => AUTOMATIC_REPOSITORIES[profile]

/**
 * Home-relative checkout locations registered for a repository under a
 * profile. An unregistered repository yields no location, so callers that
 * bind a directory to a repository fail closed.
 */
export const registeredRepositoryRoots = (
  profile: ReviewDutyProfile,
  repository: RepositorySlug,
): readonly string[] => {
  const checkout = REPOSITORY_CHECKOUT_LOCATIONS[repository]
  if (checkout !== undefined) return checkout
  const name = repository.split("/").at(1)
  if (name === undefined || name.length < 1) return []
  return PROFILE_WORKSPACES[profile].map((workspace) => `${workspace}/${name}`)
}

/**
 * Builds the registered-checkout test for a home directory: a directory is
 * accepted only when it is `<home>/<registered location>` itself or lives
 * under that checkout's `.worktrees/` directory.
 *
 * The home directory is bound here instead of being inferred, because the
 * registered locations are home-relative and mean nothing on their own. A
 * comparison that matched trailing path segments would accept any directory
 * whose last segments happen to spell a registered location — an
 * attacker-planted `.config` or `code/<owner>/<repository>` anywhere on the
 * filesystem — which is the containment this test exists to deny.
 */
export const repositoryRootIsRegisteredUnder =
  (home: CanonicalPath): RegisteredCheckoutCheck =>
  (profile, repository, root) =>
    registeredRepositoryRoots(profile, repository).some((registered) => {
      const checkout = `${home}/${registered}`
      return (
        root === checkout ||
        root.startsWith(`${checkout}/${WORKTREE_DIRECTORY}/`)
      )
    })

const PROFILE_OWNERS: Readonly<Record<ReviewDutyProfile, readonly string[]>> = {
  "st0x-review": ["st0x-technology", "rainlanguage"],
  "dataclique-review": ["dataclique"],
  "personal-review": ["0xgleb"],
}

const AUTOMATIC_REPOSITORIES: Readonly<
  Partial<Record<ReviewDutyProfile, string>>
> = {
  "dataclique-review": "dataclique/yielduck",
  "personal-review": "0xgleb/dotconfig",
}

/**
 * Home-relative workspace directories a profile checks its repositories out
 * into. A repository's registered root is `<workspace>/<repository name>`
 * unless the repository has an explicit checkout location below. A profile
 * that reviews several organisations registers the workspace of each: the
 * st0x duty covers both the st0x and the rainlanguage checkouts.
 */
const PROFILE_WORKSPACES: Readonly<
  Record<ReviewDutyProfile, readonly string[]>
> = {
  "st0x-review": ["code/st0x", "code/rainlanguage"],
  "dataclique-review": ["code/dataclique"],
  "personal-review": ["code/0xgleb"],
}

/**
 * Repositories whose checkout directory is not named after the repository.
 * The dotconfig repository is checked out as the home configuration directory.
 */
const REPOSITORY_CHECKOUT_LOCATIONS: Readonly<
  Record<string, readonly string[]>
> = {
  "0xgleb/dotconfig": [".config"],
}

const SAFE_REPOSITORY = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,99}$/u
const CONTROL_CHARACTER = /\p{Cc}/u
const MAX_PATH_LENGTH = 1_024
