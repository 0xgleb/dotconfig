import assert from "node:assert/strict"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

const root = fileURLToPath(new URL("../../", import.meta.url))
const globalPath = `${root}GLOBAL_AGENTS.md`
const home = readFileSync(`${root}home.nix`, "utf8")

test("one non-autodiscovered global source replaces the two divergent global files", () => {
  assert.ok(lstatSync(globalPath).isFile())
  assert.equal(existsSync(`${root}ai/AGENTS.md`), false)
  assert.equal(existsSync(`${root}ai/pi/AGENTS.md`), false)
  const global = readFileSync(globalPath, "utf8")
  assert.ok(
    /guarantees in tested harness code:[\s\S]*?timed publication/.test(global),
    "Timing guarantees must belong to harness code",
  )
  assert.ok(
    !/(?:every|at least every)\s+\d+\s+(?:minutes?|hours?)/.test(global),
    "Do not assign timed publication cadence to the model",
  )
})

test("every managed harness global entrypoint uses the same canonical source", () => {
  assert.ok(
    /globalInstructions =\s*config\.lib\.file\.mkOutOfStoreSymlink\s*"\$\{config.home.homeDirectory\}\/\.config\/GLOBAL_AGENTS\.md"/.test(
      home,
    ),
    "Canonical global source must be explicit in Home Manager",
  )
  for (const path of [
    ".claude/CLAUDE.md",
    ".cursor/AGENTS.md",
    ".cursor/CLAUDE.md",
    ".pi/agent/AGENTS.md",
  ]) {
    assert.ok(home.includes(`"${path}".source = globalInstructions;`), path)
  }
})

test("repository CLAUDE instructions resolve to repository policy, not global policy", () => {
  assert.equal(
    realpathSync(`${root}CLAUDE.md`),
    realpathSync(`${root}AGENTS.md`),
  )
  const project = readFileSync(`${root}AGENTS.md`, "utf8")
  assert.ok(
    /Work on `master`/.test(project),
    "Project publication branch remains local",
  )
  assert.ok(
    /Do not use `rustaceanvim`/.test(project),
    "Project Neovim ownership rules must be preserved",
  )
})
