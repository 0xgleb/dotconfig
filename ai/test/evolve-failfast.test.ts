import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const config = readFileSync(
  new URL("../../nushell/config.src.nu", import.meta.url),
  "utf8",
)

test("evolve fails at the first unsuccessful external step", () => {
  assert.match(
    config,
    /def run-evolve-step \[label: string, command: closure\]/,
  )
  assert.match(config, /do \$command\n/)
  assert.doesNotMatch(config, /do \$command \| complete/)
  assert.doesNotMatch(config, /LAST_EXIT_CODE/)
  assert.doesNotMatch(config, /evolve failed during/)

  const evolve = config.slice(
    config.indexOf("def evolve []"),
    config.indexOf("\ndef ask ["),
  )
  assert.match(evolve, /run-evolve-step "sudo refresh"/)
  assert.match(evolve, /run-evolve-step "flake update"/)
  assert.match(evolve, /run-evolve-step "Darwin switch"/)
  assert.match(
    evolve,
    /let pi_bin = \(\$env\.HOME \| path join "\.pi" "agent" "bin" "pi"\)/,
  )
  assert.match(
    evolve,
    /run-evolve-step "Pi host verification" \{\|\| \^\$pi_bin --version \}/,
  )
  assert.doesNotMatch(
    evolve,
    /run-evolve-step "Pi host verification" \{\|\| \^pi --version \}/,
  )
  assert.match(evolve, /run-evolve-step "Nix store GC"/)
  assert.ok(
    evolve.indexOf('run-evolve-step "Pi host verification"') >
      evolve.indexOf('run-evolve-step "Darwin switch"'),
  )
  assert.ok(
    evolve.indexOf('run-evolve-step "Nix store GC"') <
      evolve.indexOf('run-evolve-step "flake update"'),
  )
})
