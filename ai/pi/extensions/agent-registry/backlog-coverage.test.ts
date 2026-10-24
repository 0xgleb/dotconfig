import assert from "node:assert/strict"
import test from "node:test"
import { makeBacklogCoverageTracker } from "./backlog-coverage.ts"

const project = "/repo/a"

test("coverage is lifecycle-scoped and resets to unreconciled", () => {
  const coverage = makeBacklogCoverageTracker()
  coverage.markSource(project, "owner-message", true)
  coverage.markSource(project, "bridge-message", true)
  coverage.markSource(project, "tracker-item", true)
  coverage.markSource(project, "backlog-document", true)
  coverage.markBranchTodos(project, true)
  assert.deepEqual(coverage.unreconciledSources(project), [])

  coverage.reset()
  assert.deepEqual(coverage.unreconciledSources(project), [
    "owner-message",
    "bridge-message",
    "branch-todo",
    "tracker-item",
    "backlog-document",
  ])
})

test("coverage keys canonicalize equivalent project paths", () => {
  const coverage = makeBacklogCoverageTracker()
  coverage.markSource("/repo/../repo", "tracker-item", true)
  coverage.markBranchTodos("/repo/./", true)

  assert.deepEqual(coverage.unreconciledSources("/repo"), [
    "owner-message",
    "bridge-message",
    "backlog-document",
  ])
})

test("partial, failed, and absent declared collections invalidate only their source", () => {
  const coverage = makeBacklogCoverageTracker()
  coverage.markSource(project, "owner-message", true)
  coverage.markSource(project, "tracker-item", true)
  coverage.markSource(project, "backlog-document", true)
  coverage.markBranchTodos(project, true)

  coverage.markSource(project, "tracker-item", false)
  assert.deepEqual(coverage.unreconciledSources(project), [
    "bridge-message",
    "tracker-item",
  ])

  coverage.invalidateDeclared(project)
  assert.deepEqual(coverage.unreconciledSources(project), [
    "bridge-message",
    "tracker-item",
    "backlog-document",
  ])
  coverage.markBranchTodos(project, false)
  assert.deepEqual(coverage.unreconciledSources(project), [
    "bridge-message",
    "branch-todo",
    "tracker-item",
    "backlog-document",
  ])
})
