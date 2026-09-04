import { normalize } from "node:path"
import type {
  BacklogSourceCoverage,
  ExternalBacklogProjection,
} from "../shared/backlog-events.ts"

const ALL_SOURCES: readonly ExternalBacklogProjection["unreconciledSources"][number][] =
  [
    "owner-message",
    "bridge-message",
    "branch-todo",
    "tracker-item",
    "backlog-document",
  ]

export interface BacklogCoverageTracker {
  readonly reset: () => void
  readonly markSource: (
    project: string,
    source: BacklogSourceCoverage,
    complete: boolean,
  ) => void
  readonly markBranchTodos: (project: string, complete: boolean) => void
  readonly invalidateDeclared: (project: string) => void
  readonly unreconciledSources: (
    project: string,
  ) => ExternalBacklogProjection["unreconciledSources"]
}

const projectKey = (project: string): string =>
  normalize(project).replace(/\/$/u, "") || "/"

export const makeBacklogCoverageTracker = (): BacklogCoverageTracker => {
  const branches = new Set<string>()
  const sources = new Map<string, Set<BacklogSourceCoverage>>()

  const markSource: BacklogCoverageTracker["markSource"] = (
    project,
    source,
    complete,
  ) => {
    const key = projectKey(project)
    const coverage = sources.get(key) ?? new Set<BacklogSourceCoverage>()
    if (complete) coverage.add(source)
    else coverage.delete(source)
    if (coverage.size > 0) sources.set(key, coverage)
    else sources.delete(key)
  }

  return {
    reset: () => {
      branches.clear()
      sources.clear()
    },
    markSource,
    markBranchTodos: (project, complete) => {
      const key = projectKey(project)
      if (complete) branches.add(key)
      else branches.delete(key)
    },
    invalidateDeclared: project => {
      markSource(project, "tracker-item", false)
      markSource(project, "backlog-document", false)
    },
    unreconciledSources: project => {
      const key = projectKey(project)
      const covered = sources.get(key)
      return ALL_SOURCES.filter(source =>
        source === "branch-todo" ? !branches.has(key) : !covered?.has(source),
      )
    },
  }
}
