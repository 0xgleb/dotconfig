import assert from "node:assert/strict"
import test from "node:test"
import {
  describeRuntimeProjectContext,
  nestedRepositoryRootForPath,
  repositoryRootForPath,
} from "./project-context.ts"

test("runtime project context identifies repository roots and descendants", () => {
  assert.deepEqual(
    describeRuntimeProjectContext("/workspace/st0x", "/workspace/st0x"),
    {
      cwd: "/workspace/st0x",
      gitToplevel: "/workspace/st0x",
      cwdRelation: "repository-root",
    },
  )
  assert.deepEqual(
    describeRuntimeProjectContext("/workspace/st0x/crate", "/workspace/st0x"),
    {
      cwd: "/workspace/st0x/crate",
      gitToplevel: "/workspace/st0x",
      cwdRelation: "inside-repository",
    },
  )
})

test("runtime project context distinguishes main and linked worktrees", () => {
  assert.deepEqual(
    describeRuntimeProjectContext(
      "/workspace/repo/.worktrees/fix/src",
      "/workspace/repo/.worktrees/fix",
      "/workspace/repo",
    ),
    {
      cwd: "/workspace/repo/.worktrees/fix/src",
      gitToplevel: "/workspace/repo/.worktrees/fix",
      gitMainWorktree: "/workspace/repo",
      isMainWorktree: false,
      cwdRelation: "inside-repository",
    },
  )
  assert.deepEqual(
    describeRuntimeProjectContext(
      "/workspace/repo",
      "/workspace/repo",
      "/workspace/repo",
    ),
    {
      cwd: "/workspace/repo",
      gitToplevel: "/workspace/repo",
      gitMainWorktree: "/workspace/repo",
      isMainWorktree: true,
      cwdRelation: "repository-root",
    },
  )
})

test("runtime project context does not invent a repository boundary", () => {
  assert.deepEqual(describeRuntimeProjectContext("/workspace", undefined), {
    cwd: "/workspace",
    cwdRelation: "outside-repository",
  })
})

test("repository root evidence can identify an explicitly authorized external target", () => {
  const gitToplevelForPath = (path: string): string | undefined =>
    path.startsWith("/workspace/rainlanguage/raindex")
      ? "/workspace/rainlanguage/raindex"
      : undefined
  assert.equal(
    repositoryRootForPath(
      "/workspace/rainlanguage/raindex/.tmp/reviews/pr-2827",
      gitToplevelForPath,
    ),
    "/workspace/rainlanguage/raindex",
  )
})

test("nested repository roots are accepted only beneath the session workspace", () => {
  const gitToplevelForPath = (path: string): string | undefined =>
    path.startsWith("/workspace/nested-repo")
      ? "/workspace/nested-repo"
      : path.startsWith("/outside/nested-repo")
        ? "/outside/nested-repo"
        : undefined
  assert.equal(
    nestedRepositoryRootForPath(
      "/workspace",
      "/workspace/nested-repo/.tmp/report.json",
      gitToplevelForPath,
    ),
    "/workspace/nested-repo",
  )
  assert.equal(
    nestedRepositoryRootForPath(
      "/workspace",
      "/outside/nested-repo/.tmp/report.json",
      gitToplevelForPath,
    ),
    undefined,
  )
})
