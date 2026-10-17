import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"

const selected = [
  "ai/pi.settings.json",
  "ai/pi/hermes-memory-config.json",
  "ai/test/pi-hermes-memory-live-index.test.ts",
  "ai/test/pi-memory-provider-removal.test.ts",
  ".auto-resolution/ai/pi.settings.json",
  ".auto-resolution/ai/pi/hermes-memory-config.json",
  ".auto-resolution/ai/pi/patches/pi-hermes-memory-bounded-live-index.patch",
  ".auto-resolution/ai/pi/patches/pi-hermes-memory-bounded-session-backfill.patch",
  ".auto-resolution/ai/test/pi-hermes-memory-live-index.test.ts",
  ".auto-resolution/home.nix",
  ".conflict-base-0/ai/pi.settings.json",
  ".conflict-base-0/home.nix",
  ".conflict-side-0/ai/pi.settings.json",
  ".conflict-side-0/home.nix",
  ".conflict-side-1/ai/pi.settings.json",
  ".conflict-side-1/ai/pi/hermes-memory-config.json",
  ".conflict-side-1/ai/pi/patches/pi-hermes-memory-bounded-live-index.patch",
  ".conflict-side-1/ai/pi/patches/pi-hermes-memory-bounded-session-backfill.patch",
  ".conflict-side-1/ai/test/pi-hermes-memory-live-index.test.ts",
  ".conflict-side-1/home.nix",
]

test("the installed hook preserves peer bytes for the exact memory configuration selection", () => {
  const project = process.cwd()
  const fixture = join(project, ".tmp/publication/memory-hook-fixture")
  mkdirSync(fixture)
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: fixture,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "inherit"],
    })
  git("init", "--quiet", "--initial-branch=master")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.test")
  const peer = "ai/test/peer.ts"
  for (const path of [...selected, peer]) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true })
    writeFileSync(join(fixture, path), "baseline fixture content\n")
  }
  for (const path of [".pre-commit-config.yaml", "prettier.config.mjs"])
    copyFileSync(join(project, path), join(fixture, path))
  git("add", "--all")
  git("commit", "--quiet", "-m", "fixture baseline")
  writeFileSync(join(fixture, peer), "export const peer=2;\n")
  git("add", "--", peer)
  writeFileSync(join(fixture, peer), "export const peer=3;\n")
  writeFileSync(join(fixture, "untracked.txt"), "untracked fixture content\n")
  const present = selected.filter(path => existsSync(join(project, path)))
  const deleted = selected.filter(path => !existsSync(join(project, path)))
  for (const path of present)
    copyFileSync(join(project, path), join(fixture, path))
  for (const path of deleted) git("rm", "--quiet", "--", path)
  git("add", "--", ...present)
  const indexBefore = git("show", `:${peer}`)
  const peerBefore = readFileSync(join(fixture, peer))
  const untrackedBefore = readFileSync(join(fixture, "untracked.txt"))
  const hook = join(fixture, ".git/hooks/pre-commit")
  copyFileSync(join(project, ".git/hooks/pre-commit"), hook)
  chmodSync(hook, 0o755)
  process.stdout.write(
    git(
      "commit",
      "--only",
      "--quiet",
      "-m",
      "fixture memory selection",
      "--",
      ...selected,
    ),
  )
  assert.equal(git("show", `:${peer}`), indexBefore)
  assert.deepEqual(readFileSync(join(fixture, peer)), peerBefore)
  assert.deepEqual(
    readFileSync(join(fixture, "untracked.txt")),
    untrackedBefore,
  )
  assert.equal(git("show", `HEAD:${peer}`), "baseline fixture content\n")
  assert.deepEqual(
    git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
      .trim()
      .split("\n")
      .sort(),
    [...selected].sort(),
  )
  for (const path of present) {
    assert.deepEqual(
      readFileSync(join(fixture, path)),
      readFileSync(join(project, path)),
    )
    assert.equal(
      git("show", `HEAD:${path}`),
      readFileSync(join(project, path), "utf8"),
    )
  }
})
