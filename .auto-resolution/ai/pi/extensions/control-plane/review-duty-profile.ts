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

/**
 * Accepts a path already in canonical form. The form is decided by string
 * rules rather than by `node:path`, because this module is also bundled into
 * the browser dashboard, where no platform path builtin resolves.
 */
export const canonicalPath = (value: string): CanonicalPath | undefined =>
  value.length > 1 &&
  value.length <= MAX_PATH_LENGTH &&
  !CONTROL_CHARACTER.test(value) &&
  value.startsWith("/") &&
  !value.endsWith("/") &&
  value
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..")
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
): RepositorySlug | undefined => AUTOMATIC_REPOSITORIES[profile]

/**
 * Home-relative checkout locations registered for a repository under a
 * profile. A location comes from the workspace of the repository's own owner,
 * so a repository is bound to its organisation's checkout and never to another
 * organisation's same-named directory. A repository outside the profile, or an
 * owner with no registered workspace, yields no location, so callers that bind
 * a directory to a repository fail closed.
 */
export const registeredRepositoryRoots = (
  profile: ReviewDutyProfile,
  repository: RepositorySlug,
): readonly string[] => {
  if (!repositoryAllowedForProfile(profile, repository)) return []
  const checkout = REPOSITORY_CHECKOUT_LOCATIONS[repository]
  if (checkout !== undefined) return checkout
  const [owner, name] = repository.split("/")
  if (owner === undefined || name === undefined || name.length < 1) return []
  const workspace = OWNER_WORKSPACES[owner]
  return workspace === undefined ? [] : [`${workspace}/${name}`]
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

const SAFE_REPOSITORY = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,99}$/u
const CONTROL_CHARACTER = /\p{Cc}/u
const MAX_PATH_LENGTH = 1_024

const PROFILE_OWNERS: Readonly<Record<ReviewDutyProfile, readonly string[]>> = {
  "st0x-review": ["st0x-technology", "rainlanguage"],
  "dataclique-review": ["dataclique", "0xgleb"],
  "personal-review": ["0xgleb"],
}

/**
 * Repository each profile reviews without being asked. The literals pass
 * `repositorySlug` here rather than at the comparison, so a table entry that
 * is not an `owner/name` identifier is refused where it is written instead of
 * silently never matching.
 */
const AUTOMATIC_REPOSITORIES: Readonly<
  Partial<Record<ReviewDutyProfile, RepositorySlug>>
> = {
  "dataclique-review": repositorySlug("dataclique/yielduck"),
  "personal-review": repositorySlug("0xgleb/dotconfig"),
}

/**
 * Home-relative workspace directory each organisation is checked out into. A
 * repository's registered root is `<its owner's workspace>/<repository name>`
 * unless the repository has an explicit checkout location below.
 *
 * The workspace is keyed by owner rather than by profile because a profile
 * reviews several organisations — the st0x duty covers both the st0x and the
 * rainlanguage checkouts — and a profile-keyed table would accept either
 * organisation's directory for either organisation's repository.
 */
const OWNER_WORKSPACES: Readonly<Record<string, string>> = {
  "st0x-technology": "code/st0x",
  rainlanguage: "code/rainlanguage",
  dataclique: "code/dataclique",
  "0xgleb": "code/0xgleb",
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
