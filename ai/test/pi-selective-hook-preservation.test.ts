import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"

const project = process.cwd()
const fixture = join(project, ".tmp", "hook-safety-fixture", "repository")
const peer = "ai/test/peer.ts"
const selected = [
  "ai/pi/extensions/package.json",
  "ai/pi/extensions/package-lock.json",
  "ai/test/pi-host-package-boundary.test.ts",
]
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: fixture,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "inherit"],
  })

// This is an independent disposable test repository, never a linked worktree.
// The actual project index, branch, hooks, dependencies and peer files are read-only.
test("the installed pre-commit runner preserves unrelated index and worktree bytes during a three-path commit", () => {
  mkdirSync(fixture)
  git("init", "--quiet", "--initial-branch=master")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.test")
  mkdirSync(dirname(join(fixture, peer)), { recursive: true })
  writeFileSync(join(fixture, peer), "export const peer = 1\n")
  for (const path of selected) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true })
    writeFileSync(
      join(fixture, path),
      path.endsWith(".json") ? "{}\n" : "export const baseline = 1\n",
    )
  }
  for (const path of [".pre-commit-config.yaml", "prettier.config.mjs"]) {
    copyFileSync(join(project, path), join(fixture, path))
  }
  git("add", "--all")
  git("commit", "--quiet", "-m", "fixture baseline")

  writeFileSync(join(fixture, peer), "export const peer=2;\n")
  git("add", "--", peer)
  writeFileSync(join(fixture, peer), "export const peer=3;\n")
  writeFileSync(join(fixture, "untracked.txt"), "untracked fixture content\n")
  for (const path of selected)
    copyFileSync(join(project, path), join(fixture, path))
  git("add", "--", ...selected)

  const peerIndex = git("show", `:${peer}`)
  const peerWorktree = readFileSync(join(fixture, peer), "utf8")
  const untracked = readFileSync(join(fixture, "untracked.txt"), "utf8")
  const selectedBytes = selected.map(path => readFileSync(join(fixture, path)))
  const hook = join(fixture, ".git", "hooks", "pre-commit")
  copyFileSync(join(project, ".git", "hooks", "pre-commit"), hook)
  chmodSync(hook, 0o755)

  process.stdout.write(
    git(
      "commit",
      "--only",
      "--quiet",
      "-m",
      "fixture selective hook check",
      "--",
      ...selected,
    ),
  )

  assert.equal(git("show", `:${peer}`), peerIndex)
  assert.equal(readFileSync(join(fixture, peer), "utf8"), peerWorktree)
  assert.equal(readFileSync(join(fixture, "untracked.txt"), "utf8"), untracked)
  assert.equal(git("show", `HEAD:${peer}`), "export const peer = 1\n")
  assert.deepEqual(
    git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
      .trim()
      .split("\n")
      .sort(),
    [...selected].sort(),
  )
  selected.forEach((path, index) => {
    assert.deepEqual(readFileSync(join(fixture, path)), selectedBytes[index])
    assert.deepEqual(
      Buffer.from(git("show", `HEAD:${path}`)),
      selectedBytes[index],
    )
  })
})
