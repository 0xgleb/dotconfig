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
})

test("repository CLAUDE instructions resolve to repository policy, not global policy", () => {
  assert.equal(
    realpathSync(`${root}CLAUDE.md`),
    realpathSync(`${root}AGENTS.md`),
  )
})
