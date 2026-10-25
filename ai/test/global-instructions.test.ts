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

test("consolidation preserves global safeguards and project-local guidance", () => {
  const global = readFileSync(globalPath, "utf8")
  const project = readFileSync(`${root}AGENTS.md`, "utf8")
  assert.ok(global.includes("Preserve uncertain changes"))
  assert.ok(global.includes("verify harness discovery links"))
  assert.ok(global.includes("registered reload tool"))
  assert.ok(project.includes("Put top-level Nix flags before the subcommand"))
  assert.ok(
    project.includes(
      "Keep SPEC/ROADMAP → GitHub issues → local execution tasks",
    ),
  )
  assert.ok(project.includes("explicit short-lived one-off exceptions"))
})

test("managed engineering harness entrypoints use the canonical source", () => {
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

test("Codex retains its independent research and administration instructions", () => {
  assert.ok(!home.includes('".codex/AGENTS.md".source = globalInstructions;'))
  const global = readFileSync(globalPath, "utf8")
  assert.match(global, /Codex keeps its own `~\/.codex\/AGENTS\.md`/)
})

test("repository CLAUDE instructions resolve to repository policy, not global policy", () => {
  assert.equal(
    realpathSync(`${root}CLAUDE.md`),
    realpathSync(`${root}AGENTS.md`),
  )
  const project = readFileSync(`${root}AGENTS.md`, "utf8")
  assert.ok(
    /purpose-named branch/.test(project) && /open a draft PR/.test(project),
    "Project publication workflow remains local",
  )
  assert.ok(
    /Do not use `rustaceanvim`/.test(project),
    "Project Neovim ownership rules must be preserved",
  )
})
