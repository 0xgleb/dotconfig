import { spawnSync } from "node:child_process"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

export interface RuntimeProjectContext {
  cwd: string
  gitToplevel?: string
  gitMainWorktree?: string
  isMainWorktree?: boolean
  cwdRelation: "repository-root" | "inside-repository" | "outside-repository"
}

const sanitizedGitEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ])
    delete env[key]
  return env
}

export const describeRuntimeProjectContext = (
  cwd: string,
  gitToplevel?: string,
  gitMainWorktree?: string,
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
    cwdRelation,
  }
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
  if (!gitToplevel) return describeRuntimeProjectContext(resolvedCwd, undefined)

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
          .find(line => line.startsWith("worktree "))
          ?.slice("worktree ".length)
          .trim()
      : undefined
  return describeRuntimeProjectContext(
    resolvedCwd,
    gitToplevel,
    gitMainWorktree || undefined,
  )
}

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
