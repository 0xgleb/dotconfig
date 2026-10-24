// Opt-in: node --test ai/test/dev-shell-hooks.integration.ts
// Requires Nix and direnv. Uses an independent disposable repository, not a worktree.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const project = fileURLToPath(new URL("../../", import.meta.url))
const fixture = join(project, ".tmp", "hooks-setup", "repository")
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`

test("direnv installs hooks and normal Git rejects unformatted staged TypeScript", () => {
  assert.equal(
    existsSync(fixture),
    false,
    "never overwrite an existing fixture",
  )
  mkdirSync(fixture, { recursive: true })
  const run = (command: string, args: string[], status = 0): string => {
    const result = spawnSync(command, args, {
      cwd: fixture,
      encoding: "utf8",
      timeout: 30_000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, status, `${command}: ${result.stderr}`)
    return result.stdout
  }
  try {
    run("git", ["init", "--quiet"])
    run("git", ["config", "--local", "user.name", "Hook fixture"])
    run("git", ["config", "--local", "user.email", "fixture@example.test"])
    run("git", ["config", "--local", "commit.gpgsign", "false"])
    for (const path of [".pre-commit-config.yaml", "prettier.config.mjs"])
      copyFileSync(join(project, path), join(fixture, path))
    writeFileSync(
      join(fixture, ".envrc"),
      `use nix ${shellQuote(join(project, "shell.nix"))}\n`,
    )
    mkdirSync(join(fixture, "ai"))
    const source = join(fixture, "ai", "fixture.ts")
    writeFileSync(source, "export const fixture=1;\n")
    run("direnv", ["allow", "."])
    assert.match(run("direnv", ["exec", ".", "prek", "--version"]), /^prek /)
    assert.equal(existsSync(join(fixture, ".git", "hooks", "pre-commit")), true)
    run("git", [
      "add",
      "--",
      ".pre-commit-config.yaml",
      "prettier.config.mjs",
      "ai/fixture.ts",
    ])
    run(
      "direnv",
      ["exec", ".", "git", "commit", "-m", "unformatted fixture"],
      1,
    )
    assert.equal(readFileSync(source, "utf8"), "export const fixture = 1\n")
    run("git", ["rev-parse", "--verify", "HEAD"], 128)
    run("git", ["add", "--", "ai/fixture.ts"])
    run("direnv", ["exec", ".", "git", "commit", "-m", "formatted fixture"])
    assert.equal(
      run("git", ["show", "HEAD:ai/fixture.ts"]),
      "export const fixture = 1\n",
    )
  } finally {
    run("direnv", ["deny", "."])
    rmSync(fixture, { recursive: true })
  }
})
