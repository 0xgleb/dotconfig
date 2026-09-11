import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { Effect, Either } from "effect"

export interface RuntimeGitSnapshot {
  gitBranch?: string
  gitHead?: string
  gitCachedPathCount: number
  gitStatusSnapshotSha256: string
  gitHasUnstagedTrackedChanges: boolean
  gitUntrackedFilesExcluded: true
  gitCommitHooksSnapshotSha256?: string
  gitPushRemoteSnapshotSha256?: string
}

export interface RuntimeProjectContext extends Partial<RuntimeGitSnapshot> {
  cwd: string
  gitToplevel?: string
  gitMainWorktree?: string
  isMainWorktree?: boolean
  gitEnvironmentOverrideNames?: ReadonlyArray<string>
  cwdRelation: "repository-root" | "inside-repository" | "outside-repository"
}

export interface RuntimeTargetProjectContext {
  targetPath: string
  targetIdentitySha256: string
  project: RuntimeProjectContext
}

export interface RuntimeCommandLocation {
  commandCwd: string
  commandCwdIdentitySha256: string
  command: string
  directoryTransition: boolean
}

export interface RuntimeCommandProjectContext extends RuntimeCommandLocation {
  project: RuntimeProjectContext
}

export interface RuntimeClassificationProjectContexts {
  runtimeProjectContext: RuntimeProjectContext
  runtimeCommandProjectContext?: RuntimeCommandProjectContext
  runtimeTargetProjectContext?: RuntimeTargetProjectContext
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isGitEnvironmentOverride = (key: string): boolean =>
  [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
  ].includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)

const gitEnvironmentOverrideNames = (): ReadonlyArray<string> =>
  Object.keys(process.env).filter(isGitEnvironmentOverride).sort()

const withGitEnvironmentOverrides = (
  project: RuntimeProjectContext,
): RuntimeProjectContext => {
  const overrideNames = gitEnvironmentOverrideNames()
  return overrideNames.length > 0
    ? { ...project, gitEnvironmentOverrideNames: overrideNames }
    : project
}

const sanitizedGitEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (isGitEnvironmentOverride(key)) delete env[key]
  return env
}

export const describeRuntimeGitSnapshot = (
  statusOutput: string,
): RuntimeGitSnapshot => {
  let gitBranch: string | undefined
  let gitHead: string | undefined
  let gitCachedPathCount = 0
  let gitHasUnstagedTrackedChanges = false
  const records = statusOutput.split("\0")
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ""
    if (record.startsWith("# branch.oid ")) {
      const rawCandidate = record.slice("# branch.oid ".length)
      const candidate = rawCandidate.trim()
      if (!/[\r\n]/.test(rawCandidate) && /^[0-9a-f]{40,64}$/i.test(candidate))
        gitHead = candidate
      continue
    }
    if (record.startsWith("# branch.head ")) {
      const rawCandidate = record.slice("# branch.head ".length)
      const candidate = rawCandidate.trim()
      if (
        !/[\r\n]/.test(rawCandidate) &&
        candidate !== "(detached)" &&
        candidate !== "(unknown)"
      )
        gitBranch = candidate
      continue
    }
    if (!/^[12u] /.test(record)) continue
    const indexAndWorktree = record.slice(2, 4)
    if (indexAndWorktree[0] !== ".") gitCachedPathCount += 1
    if (indexAndWorktree[1] !== ".") gitHasUnstagedTrackedChanges = true
    if (record.startsWith("2 ")) index += 1
  }
  return {
    ...(gitBranch ? { gitBranch } : {}),
    ...(gitHead ? { gitHead } : {}),
    gitCachedPathCount,
    gitStatusSnapshotSha256: createHash("sha256")
      .update(statusOutput)
      .digest("hex"),
    gitHasUnstagedTrackedChanges,
    gitUntrackedFilesExcluded: true,
  }
}

export const describeRuntimeProjectContext = (
  cwd: string,
  gitToplevel?: string,
  gitMainWorktree?: string,
  gitSnapshot?: RuntimeGitSnapshot,
): RuntimeProjectContext => {
  const resolvedCwd = resolve(cwd)
  if (!gitToplevel)
    return { cwd: resolvedCwd, cwdRelation: "outside-repository" }

  const resolvedToplevel = resolve(gitToplevel)
  const child = relative(resolvedToplevel, resolvedCwd)
  const cwdRelation =
    child === ""
      ? "repository-root"
      : child !== ".." && !child.startsWith(`..${sep}`)
        ? "inside-repository"
        : "outside-repository"
  const resolvedMainWorktree = gitMainWorktree
    ? resolve(gitMainWorktree)
    : undefined
  return {
    cwd: resolvedCwd,
    gitToplevel: resolvedToplevel,
    ...(resolvedMainWorktree
      ? {
          gitMainWorktree: resolvedMainWorktree,
          isMainWorktree: resolvedToplevel === resolvedMainWorktree,
        }
      : {}),
    ...(gitSnapshot ?? {}),
    cwdRelation,
  }
}

const externalPathValue = <Value>(attempt: () => Value): Value | undefined => {
  const result = Effect.runSync(
    Effect.either(
      Effect.try({
        try: attempt,
        catch: cause => cause,
      }),
    ),
  )
  return Either.isRight(result) ? result.right : undefined
}

const gitBoundaryHookNames = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-push",
] as const

const gitCommitHooksSnapshotSha256 = (
  cwd: string,
  gitToplevel: string,
): string => {
  const configured = spawnSync(
    "git",
    ["-C", cwd, "config", "--path", "--get", "core.hooksPath"],
    {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    },
  )
  const defaultHooks = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--git-path", "hooks"],
    {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    },
  )
  const configuredPath = configured.status === 0 ? configured.stdout.trim() : ""
  const defaultPath =
    defaultHooks.status === 0 ? defaultHooks.stdout.trim() : ""
  const hooksRoot = configuredPath
    ? resolve(gitToplevel, configuredPath)
    : resolve(cwd, defaultPath)
  const records = [
    `configured:${configuredPath}`,
    `default:${configuredPath ? "(unused)" : defaultPath}`,
  ]
  for (const hookName of gitBoundaryHookNames) {
    const hookPath = resolve(cwd, hooksRoot, hookName)
    const link = externalPathValue(() => lstatSync(hookPath))
    if (!link) {
      records.push(`${hookName}:absent`)
      continue
    }
    const canonicalPath = externalPathValue(() => realpathSync.native(hookPath))
    const target = canonicalPath
      ? externalPathValue(() => statSync(canonicalPath))
      : undefined
    const content =
      canonicalPath && target?.isFile()
        ? externalPathValue(() => readFileSync(canonicalPath))
        : undefined
    records.push(
      [
        hookName,
        hookPath,
        canonicalPath ?? "unresolved",
        String(link.mode),
        target ? String(target.mode) : "missing",
        content
          ? createHash("sha256").update(content).digest("hex")
          : "not-file",
      ].join(":"),
    )
  }
  return createHash("sha256").update(records.join("\0")).digest("hex")
}

export const runtimeProjectContext = (cwd: string): RuntimeProjectContext => {
  const resolvedCwd = resolve(cwd)
  const result = spawnSync(
    "git",
    ["-C", resolvedCwd, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    },
  )
  const gitToplevel = result.status === 0 ? result.stdout.trim() : undefined
  if (!gitToplevel)
    return withGitEnvironmentOverrides(
      describeRuntimeProjectContext(resolvedCwd, undefined),
    )

  const worktrees = spawnSync(
    "git",
    ["-C", resolvedCwd, "worktree", "list", "--porcelain"],
    {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    },
  )
  const gitMainWorktree =
    worktrees.status === 0
      ? worktrees.stdout
          .split(/\r?\n/)
          .find((line: string) => line.startsWith("worktree "))
          ?.slice("worktree ".length)
          .trim()
      : undefined
  const status = spawnSync(
    "git",
    [
      "-C",
      resolvedCwd,
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=no",
    ],
    {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    },
  )
  const pushRemote = spawnSync(
    "git",
    ["-C", resolvedCwd, "remote", "get-url", "--push", "--all", "origin"],
    {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    },
  )
  const pushRemoteOutput =
    pushRemote.status === 0 ? pushRemote.stdout.trim() : ""
  const urlRewriteConfiguration = gitUrlRewriteConfiguration(resolvedCwd)
  const gitSnapshot =
    status.status === 0
      ? {
          ...describeRuntimeGitSnapshot(status.stdout),
          gitCommitHooksSnapshotSha256: gitCommitHooksSnapshotSha256(
            resolvedCwd,
            gitToplevel,
          ),
          ...(pushRemoteOutput && urlRewriteConfiguration !== undefined
            ? {
                gitPushRemoteSnapshotSha256: gitPushConfigurationSha256(
                  pushRemoteOutput,
                  urlRewriteConfiguration,
                ),
              }
            : {}),
        }
      : undefined
  const project = describeRuntimeProjectContext(
    resolvedCwd,
    gitToplevel,
    gitMainWorktree || undefined,
    gitSnapshot,
  )
  return withGitEnvironmentOverrides(project)
}

export const runtimeProjectContextForTarget = (
  cwd: string,
  targetPath: string,
): RuntimeTargetProjectContext | undefined => {
  const resolvedTargetPath = resolve(cwd, targetPath)
  const targetStat = externalPathValue(() => lstatSync(resolvedTargetPath))
  if (targetStat?.isSymbolicLink()) return undefined
  const canonicalParent = externalPathValue(() =>
    realpathSync.native(dirname(resolvedTargetPath)),
  )
  if (!canonicalParent) return undefined
  const canonicalTargetPath = targetStat
    ? externalPathValue(() => realpathSync.native(resolvedTargetPath))
    : join(canonicalParent, basename(resolvedTargetPath))
  if (!canonicalTargetPath) return undefined
  const targetIdentity = externalPathValue(() =>
    statSync(canonicalTargetPath, { bigint: true }),
  )
  const parentIdentity = externalPathValue(() =>
    statSync(canonicalParent, { bigint: true }),
  )
  if (!parentIdentity) return undefined
  const targetIdentitySha256 = createHash("sha256")
    .update(canonicalTargetPath)
    .update("\0")
    .update(
      targetIdentity
        ? [
            targetIdentity.dev,
            targetIdentity.ino,
            targetIdentity.mode,
            targetIdentity.size,
            targetIdentity.mtimeNs,
          ]
            .map(String)
            .join(":")
        : "absent",
    )
    .update("\0")
    .update(
      [parentIdentity.dev, parentIdentity.ino, parentIdentity.mode]
        .map(String)
        .join(":"),
    )
    .digest("hex")
  return {
    targetPath: canonicalTargetPath,
    targetIdentitySha256,
    project: runtimeProjectContext(canonicalParent),
  }
}

const literalAbsoluteCommandPath = /^\/[A-Za-z0-9._@+,=\/-]+$/
// Only known valueless global options can precede the subcommand. Unknown
// options may consume a value, so guessing their arity could hide a selector.
const gitGlobalOptionsWithoutValues = new Set([
  "-v",
  "--version",
  "-h",
  "--help",
  "--html-path",
  "--man-path",
  "--info-path",
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-advice",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
])
const safeGitPushRemote =
  /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~+\/%-]+|ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~+\/%-]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~+\/-]+)$/

const commandDirectoryIdentity = (
  candidate: string,
): { commandCwd: string; commandCwdIdentitySha256: string } | undefined => {
  const resolvedCandidate = resolve(candidate)
  const link = externalPathValue(() => lstatSync(resolvedCandidate))
  if (!link?.isDirectory() || link.isSymbolicLink()) return undefined
  const commandCwd = externalPathValue(() =>
    realpathSync.native(resolvedCandidate),
  )
  if (!commandCwd) return undefined
  const identity = externalPathValue(() =>
    statSync(commandCwd, { bigint: true }),
  )
  if (!identity?.isDirectory()) return undefined
  return {
    commandCwd,
    commandCwdIdentitySha256: createHash("sha256")
      .update(commandCwd)
      .update("\0")
      .update(
        [identity.dev, identity.ino, identity.mode, identity.mtimeNs]
          .map(String)
          .join(":"),
      )
      .digest("hex"),
  }
}

const shellWords = (command: string): readonly string[] | undefined => {
  if (!command.trim() || /[\r\n]/.test(command)) return undefined
  const words: string[] = []
  let current = ""
  let quote: "single" | "double" | undefined
  let started = false
  for (const character of command) {
    if (quote === "single") {
      if (character === "'") quote = undefined
      else current += character
      started = true
      continue
    }
    if (quote === "double") {
      if (/[`$\\]/.test(character)) return undefined
      if (character === '"') quote = undefined
      else current += character
      started = true
      continue
    }
    if (/[;&|<>`$\\()]/.test(character)) return undefined
    if (character === "'") {
      quote = "single"
      started = true
    } else if (character === '"') {
      quote = "double"
      started = true
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(current)
        current = ""
        started = false
      }
    } else {
      current += character
      started = true
    }
  }
  if (quote) return undefined
  if (started) words.push(current)
  return words.length > 0 ? words : undefined
}

const unsafeGitTokens = (words: readonly string[]): boolean => {
  if (words.some(word => word.includes("/") && basename(word) === "git"))
    return true
  if (words.some(word => /^(?:cd|pushd|popd)$/.test(word))) return true
  if (words.some(word => /^GIT_[A-Za-z0-9_]+=/.test(word))) return true
  const gitIndex = words.findIndex(word => word === "git" || word === "^git")
  if (gitIndex < 0) return false
  if (gitIndex > 0) return true
  for (const word of words.slice(gitIndex + 1)) {
    // Git parses global options before the subcommand. For example, --git-dir
    // after rev-parse reports a path; it does not select another repository.
    if (!word.startsWith("-")) return false
    if (!gitGlobalOptionsWithoutValues.has(word)) return true
  }
  return false
}

export const runtimeCommandLocationForSubject = (
  cwd: string,
  subject: unknown,
): RuntimeCommandLocation | undefined => {
  if (!isRecord(subject) || subject.toolName !== "bash") return undefined
  const input = isRecord(subject.input) ? subject.input : undefined
  if (typeof input?.command !== "string") return undefined
  const rawCommand = input.command.trim()
  const match = rawCommand.match(
    /^cd[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|<>\\]+))[ \t]*\r?\n([^\r\n]+?)[ \t]*$/,
  )
  const candidate = match
    ? (match[1] ?? match[2] ?? match[3])
    : rawCommand.includes("\n") || rawCommand.includes("\r")
      ? undefined
      : cwd
  const command = (match ? match[4] : rawCommand)?.trim()
  const directoryTransition = Boolean(match)
  if (
    !candidate ||
    !command ||
    !isAbsolute(candidate) ||
    (directoryTransition && !literalAbsoluteCommandPath.test(candidate))
  )
    return undefined
  const words = shellWords(command)
  if (!words || unsafeGitTokens(words)) return undefined
  const directory = commandDirectoryIdentity(candidate)
  return directory ? { ...directory, command, directoryTransition } : undefined
}

export const unsafeRuntimeCommandLocationBlockReason = (
  cwd: string,
  subject: unknown,
): string | undefined => {
  if (!isRecord(subject) || subject.toolName !== "bash") return undefined
  const input = isRecord(subject.input) ? subject.input : undefined
  if (typeof input?.command !== "string") return undefined
  const normalized = input.command
    .replace(/\\\r?\n/g, "")
    .replace(/["'\\]/g, "")
  const hasGit = [normalized, normalized.replace(/\$/g, "")].some(command =>
    /(?:^|[\s;&|($`])\^?(?:git|(?:[^\s;&|$()]+\/)+git)(?=[\s;&|$()]|$)/i.test(
      command,
    ),
  )
  if (!hasGit || runtimeCommandLocationForSubject(cwd, subject))
    return undefined
  return "Git commands require either the session cwd or one existing non-symlink absolute command cwd and one literal command without environment assignments, repository selectors, config overrides, shell composition, or additional directory changes."
}

const gitUrlRewriteConfiguration = (cwd: string): string | undefined => {
  const result = spawnSync(
    "git",
    [
      "-C",
      cwd,
      "config",
      "--null",
      "--get-regexp",
      "^url\\..*\\.(insteadOf|pushInsteadOf)$",
    ],
    {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    },
  )
  return result.status === 0
    ? result.stdout
    : result.status === 1
      ? ""
      : undefined
}

const gitPushConfigurationSha256 = (
  pushRemoteOutput: string,
  urlRewriteConfiguration: string,
): string =>
  createHash("sha256")
    .update(pushRemoteOutput)
    .update("\0")
    .update(urlRewriteConfiguration)
    .digest("hex")

export type HardenedGitPushCommand =
  { readonly command: string } | { readonly reason: string }

export const gitEnvironmentOverrideBlockReason = (
  contexts: RuntimeClassificationProjectContexts,
  subject: unknown,
): string | undefined => {
  if (!isRecord(subject) || subject.toolName !== "bash") return undefined
  const input = isRecord(subject.input) ? subject.input : undefined
  if (
    typeof input?.command !== "string" ||
    !/(?:^|\s)\^?git(?:\s|$)/.test(input.command)
  )
    return undefined
  const overrideNames = new Set<string>()
  for (const project of [
    contexts.runtimeProjectContext,
    contexts.runtimeCommandProjectContext?.project,
    contexts.runtimeTargetProjectContext?.project,
  ])
    for (const name of project?.gitEnvironmentOverrideNames ?? [])
      overrideNames.add(name)
  return overrideNames.size > 0
    ? `Git command execution has ambient repository or config override variables: ${[...overrideNames].sort().join(", ")}. Clear them and re-establish fresh source-fixed Git evidence before retrying.`
    : undefined
}

export const hardenedGitPushCommandForSubject = (
  cwd: string,
  subject: unknown,
  expectedPushRemoteSnapshotSha256?: string,
): HardenedGitPushCommand | undefined => {
  const location = runtimeCommandLocationForSubject(cwd, subject)
  if (!location || !/^\^?git push -u origin HEAD$/.test(location.command))
    return undefined
  const overrides = gitEnvironmentOverrideNames()
  if (overrides.length > 0)
    return {
      reason: `Cannot seal Git push while ambient repository or config override variables are present: ${overrides.join(", ")}.`,
    }
  const remote = spawnSync(
    "git",
    [
      "-C",
      location.commandCwd,
      "remote",
      "get-url",
      "--push",
      "--all",
      "origin",
    ],
    {
      encoding: "utf8",
      env: sanitizedGitEnvironment(),
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    },
  )
  const pushRemoteOutput = remote.status === 0 ? remote.stdout.trim() : ""
  const urlRewriteConfiguration = gitUrlRewriteConfiguration(
    location.commandCwd,
  )
  const currentPushRemoteSnapshotSha256 =
    pushRemoteOutput && urlRewriteConfiguration !== undefined
      ? gitPushConfigurationSha256(pushRemoteOutput, urlRewriteConfiguration)
      : undefined
  if (
    !expectedPushRemoteSnapshotSha256 ||
    currentPushRemoteSnapshotSha256 !== expectedPushRemoteSnapshotSha256
  )
    return {
      reason:
        "Cannot seal Git push because the effective origin destination no longer matches the approved source-fixed snapshot.",
    }
  if (urlRewriteConfiguration)
    return {
      reason:
        "Cannot seal Git push while url.*.insteadOf or url.*.pushInsteadOf rewriting is configured.",
    }
  const pushUrls = pushRemoteOutput
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
  if (
    pushUrls.length === 0 ||
    pushUrls.length > 4 ||
    pushUrls.some(value => !safeGitPushRemote.test(value))
  )
    return {
      reason:
        "Cannot seal Git push because origin has no bounded credential-free HTTPS or SSH push destination.",
    }
  const config = [
    `-c remote.origin.url=${pushUrls[0]}`,
    ...pushUrls.map(value => `-c remote.origin.pushurl=${value}`),
  ].join(" ")
  return {
    command: `${location.directoryTransition ? `cd ${JSON.stringify(location.commandCwd)}\n` : ""}git ${config} push -u origin HEAD`,
  }
}

export const runtimeCommandProjectContextForSubject = (
  cwd: string,
  subject: unknown,
): RuntimeCommandProjectContext | undefined => {
  const location = runtimeCommandLocationForSubject(cwd, subject)
  return location
    ? { ...location, project: runtimeProjectContext(location.commandCwd) }
    : undefined
}

export const runtimeTargetProjectContextForSubject = (
  cwd: string,
  subject: unknown,
): RuntimeTargetProjectContext | undefined => {
  if (!isRecord(subject)) return undefined
  if (!["read", "write", "edit"].includes(String(subject.toolName)))
    return undefined
  const input = isRecord(subject.input) ? subject.input : undefined
  return typeof input?.path === "string" && input.path.trim()
    ? runtimeProjectContextForTarget(cwd, input.path)
    : undefined
}

export const runtimeClassificationProjectContexts = (
  cwd: string,
  subject: unknown,
): RuntimeClassificationProjectContexts => {
  const runtimeCommandProjectContext = runtimeCommandProjectContextForSubject(
    cwd,
    subject,
  )
  const runtimeTargetProjectContext = runtimeTargetProjectContextForSubject(
    cwd,
    subject,
  )
  return {
    runtimeProjectContext: runtimeProjectContext(cwd),
    ...(runtimeCommandProjectContext ? { runtimeCommandProjectContext } : {}),
    ...(runtimeTargetProjectContext ? { runtimeTargetProjectContext } : {}),
  }
}

export const runtimeClassificationProjectContextsMatch = (
  before: RuntimeClassificationProjectContexts,
  after: RuntimeClassificationProjectContexts,
): boolean => JSON.stringify(before) === JSON.stringify(after)

const isAtOrWithin = (root: string, candidate: string): boolean => {
  const child = relative(resolve(root), resolve(candidate))
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  )
}

export const repositoryRootForPath = (
  candidate: string,
  gitToplevelForPath: (path: string) => string | undefined = path =>
    runtimeProjectContext(path).gitToplevel,
): string | undefined => {
  const resolvedCandidate = resolve(candidate)
  const repositoryRoot =
    gitToplevelForPath(resolvedCandidate) ??
    gitToplevelForPath(dirname(resolvedCandidate))
  return repositoryRoot ? resolve(repositoryRoot) : undefined
}

export const nestedRepositoryRootForPath = (
  cwd: string,
  candidate: string,
  gitToplevelForPath: (path: string) => string | undefined = path =>
    runtimeProjectContext(path).gitToplevel,
): string | undefined => {
  const resolvedCwd = resolve(cwd)
  const resolvedCandidate = resolve(resolvedCwd, candidate)
  const repositoryRoot = repositoryRootForPath(
    resolvedCandidate,
    gitToplevelForPath,
  )
  return repositoryRoot && isAtOrWithin(resolvedCwd, repositoryRoot)
    ? repositoryRoot
    : undefined
}
