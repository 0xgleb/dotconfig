import assert from "node:assert/strict"
import test from "node:test"
import { buildClassifierPrompt } from "./lifecycle.ts"
import type { RuntimeProjectContext } from "./project-context.ts"

const linked: RuntimeProjectContext = {
  cwd: "/workspace/project/.tmp/worktrees/secondary",
  gitToplevel: "/workspace/project/.tmp/worktrees/secondary",
  gitMainWorktree: "/workspace/project",
  isMainWorktree: false,
  cwdRelation: "repository-root",
  gitBranch: "docs/contract",
  gitHead: "a".repeat(40),
  gitStatusSnapshotSha256: "b".repeat(64),
  gitCommitHooksSnapshotSha256: "c".repeat(64),
  gitCachedPathCount: 2,
  gitHasUnstagedTrackedChanges: false,
  gitUntrackedFilesExcluded: true,
}

const renderedCommitPolicy = (projectInstructions: string): string => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: [
      "Commit the reviewed documentation update on its existing branch.",
    ],
    projectInstructions,
    runtimeProjectContext: linked,
    subject: {
      toolName: "bash",
      cwd: linked.cwd,
      input: { command: 'git commit -m "clarify the contract"' },
    },
    evidence: [
      "Current cached inventory contains only README.md and SPEC.md.",
      "Required documentation checks passed; the completed independent review covers the same exact blobs.",
      "The current hook source/configuration identifies a formatting-only runner; the exact staged blobs pass that formatter's check.",
    ],
  })
  const start = prompt.indexOf(
    "For the isMainWorktree=false linked-worktree commit path only:",
  )
  const end = prompt.indexOf("A local WIP preservation commit", start)
  assert.ok(start >= 0 && end > start, "linked-commit policy must be present")
  return prompt.slice(start, end)
}

test("linked commit prompt requires repository-scoped gates rather than an invented pipeline", () => {
  const policy = renderedCommitPolicy(
    "Documentation changes require formatting and independent review. Other changes require the full pipeline.",
  )
  assert.ok(
    policy.includes(
      "all checks required by the applicable repository policy and evidenced change scope",
    ),
    "gate selection must follow applicable policy and scope",
  )
  assert.ok(
    policy.includes(
      "Documentation-only status does not waive an explicitly required gate",
    ),
    "docs cannot become a blanket gate exemption",
  )
  assert.ok(
    !policy.includes(
      "after the current focused backend and frontend pipeline gates are green",
    ),
    "unrelated pipeline names cannot be unconditional commit prerequisites",
  )
})

test("linked commit prompt permits only snapshot-bound formatting hooks with post-hook equality", () => {
  const policy = renderedCommitPolicy(
    "Run the configured formatter hook normally.",
  )
  assert.ok(
    policy.includes("An existing formatting-only hook may run normally"),
    "linked worktrees need the same bounded formatter path as main worktrees",
  )
  for (const requirement of [
    "exact formatter check passes for every staged blob",
    "runner preserves unstaged changes",
    "cannot add paths or stage unreviewed content",
    "post-commit path, mode, and blob identities must equal the reviewed index",
    "hook-entrypoint fingerprint alone is insufficient",
    "Unknown runner, configuration, or tool identity",
  ]) {
    assert.ok(policy.includes(requirement), requirement)
  }
})

test("linked commit prompt binds completed review across a byte-identical staging transition", () => {
  const policy = renderedCommitPolicy(
    "Reuse completed review only for unchanged source.",
  )
  for (const requirement of [
    "index-only staging transition",
    "same head",
    "complete reviewed path, mode, and blob identities",
    "unchanged relevant source and configuration inputs",
    "current status snapshot",
    "status snapshot that differs from the newly verified binding",
    "does not authorize reusing evidence after a source, configuration, dependency, or head change",
  ]) {
    assert.ok(policy.includes(requirement), requirement)
  }
})

test("linked commit prompt retains runtime, hook, untracked-content and publication boundaries", () => {
  const policy = renderedCommitPolicy("No hook bypass or unreviewed files.")
  for (const requirement of [
    "gitStatusSnapshotSha256",
    "gitCommitHooksSnapshotSha256",
    "gitCachedPathCount",
    "gitHasUnstagedTrackedChanges=false",
    "gitUntrackedFilesExcluded=true",
    "recomputed again at the final action boundary",
    "unreviewed staged path",
    "Do not use commit --only",
    "do not use --no-verify to bypass hook policy",
    "before publication",
    "This does not authorize source edits",
  ]) {
    assert.ok(policy.includes(requirement), requirement)
  }
})
