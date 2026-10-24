import assert from "node:assert/strict"
import { chmod, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const guard = new URL(
  "../../scripts/but-linked-worktree-guard.sh",
  import.meta.url,
).pathname

const run = (cwd: string, fakeBut: string, args: readonly string[] = []) =>
  spawnSync("bash", [guard, fakeBut, ...args], { cwd, encoding: "utf8" })

const git = (cwd: string, args: readonly string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
}

test("GitButler wrapper delegates from a primary worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "but-guard-main-"))
  git(root, ["init", "-q"])
  const fakeBut = join(root, "fake-but")
  await writeFile(
    fakeBut,
    "#!/usr/bin/env bash\nprintf 'delegated:%s\\n' \"$*\"\n",
  )
  await chmod(fakeBut, 0o755)

  const result = run(root, fakeBut, ["status"])
  const canonicalRoot = await realpath(root)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `delegated:-C ${canonicalRoot} status\n`)
})

test("GitButler wrapper pins a nested repository instead of an ancestor GitButler project", async () => {
  const outer = await mkdtemp(join(tmpdir(), "but-guard-outer-"))
  git(outer, ["init", "-q"])
  const nested = join(outer, "scratch", "repo")
  await mkdir(nested, { recursive: true })
  git(nested, ["init", "-q"])
  const fakeBut = join(outer, "fake-but")
  await writeFile(
    fakeBut,
    '#!/usr/bin/env bash\nprintf \'cwd:%s\\nargs:%s\\n\' "$PWD" "$*"\n',
  )
  await chmod(fakeBut, 0o755)

  const result = run(nested, fakeBut, ["status"])
  const canonicalNested = await realpath(nested)
  assert.equal(result.status, 0)
  assert.equal(
    result.stdout,
    `cwd:${canonicalNested}\nargs:-C ${canonicalNested} status\n`,
  )
})

test("GitButler wrapper preserves an explicit exact project selection", async () => {
  const outer = await mkdtemp(join(tmpdir(), "but-guard-explicit-"))
  git(outer, ["init", "-q"])
  const nested = join(outer, "nested")
  await mkdir(nested)
  git(nested, ["init", "-q"])
  const fakeBut = join(outer, "fake-but")
  await writeFile(fakeBut, "#!/usr/bin/env bash\nprintf 'args:%s\\n' \"$*\"\n")
  await chmod(fakeBut, 0o755)

  const result = run(outer, fakeBut, ["-C", nested, "status"])
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `args:-C ${nested} status\n`)
})

test("GitButler wrapper fails closed from a linked worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "but-guard-linked-"))
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "guard@example.invalid"])
  git(root, ["config", "user.name", "Guard Test"])
  await writeFile(join(root, "tracked"), "initial\n")
  git(root, ["add", "tracked"])
  git(root, ["commit", "-qm", "initial"])
  const linked = join(root, "linked")
  await mkdir(linked)
  git(root, ["worktree", "add", "-q", "-b", "linked-test", linked])
  const fakeBut = join(root, "fake-but")
  await writeFile(fakeBut, "#!/usr/bin/env bash\nprintf 'must-not-run\\n'\n")
  await chmod(fakeBut, 0o755)

  const result = run(linked, fakeBut, ["commit", "-m", "unsafe"])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /disabled in linked worktrees/i)
  assert.match(result.stderr, /worktree-local Git/i)
})
