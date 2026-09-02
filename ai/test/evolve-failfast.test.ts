import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
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
  assert.match(evolve, /run-evolve-flake-update \$config_root/)
  assert.match(evolve, /run-evolve-step "Darwin switch"/)
  assert.match(evolve, /run-evolve-step "Nix store GC"/)
  assert.match(
    evolve,
    /let pi_bin = \(\$env\.HOME \| path join "\.pi" "agent" "bin" "pi"\)/,
  )
  assert.match(
    config,
    /def verify-pi-host \[pi_bin: string\][\s\S]*?\^\$pi_bin --version/,
  )
  assert.match(config, /readlink -f \$pi_bin/)
  assert.match(config, /let expected_wrapped =/)
  assert.match(config, /str contains \$expected_wrapped/)
  assert.match(
    config,
    /managed Pi entrypoint executes a different host package/,
  )
  assert.match(config, /str contains "renderSafely\(\)"/)
  assert.match(config, /str contains "this\.renderSafely\(\);"/)
  assert.match(config, /str contains "const pending = \[root\];"/)
  assert.match(
    evolve,
    /run-evolve-step "Pi host verification" \{\|\| verify-pi-host \$pi_bin \}/,
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
    evolve.indexOf('run-evolve-step "Nix store GC"') >
      evolve.indexOf('run-evolve-step "Pi host verification"'),
  )
})

test("host activation migrates already-running Pi sessions without losing their state", () => {
  const autoReload = readFileSync(
    new URL("../pi/extensions/auto-reload/index.ts", import.meta.url),
    "utf8",
  )
  assert.match(autoReload, /needsManagedHostMigration/)
  assert.match(autoReload, /verifiedHostArtifacts/)
  assert.match(autoReload, /ctx\.sessionManager\.getSessionFile\(\)/)
  assert.match(autoReload, /ctx\.ui\.getEditorText\(\)/)
  assert.match(autoReload, /ctx\.hasPendingMessages\(\)/)
  assert.match(autoReload, /process\.execve/)
  assert.match(autoReload, /Resuming preserved work after Pi host migration/)
})

test("evolve falls back to the existing lock only for an exact GitHub API rate limit", () => {
  const start = config.indexOf("def is-github-api-rate-limit")
  const end = config.indexOf("\ndef run-evolve-flake-update", start)
  assert.notEqual(start, -1)
  assert.ok(end > start)

  const functionSource = config.slice(start, end)
  const classify = (output: string): boolean => {
    const script = `${functionSource}\nprint (is-github-api-rate-limit ${JSON.stringify(output)})`
    const result = spawnSync("nu", ["--no-config-file", "--commands", script], {
      encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim() === "true"
  }

  assert.equal(
    classify(
      "unable to download https://api.github.com/repos/data-cartel/but.nix/commits/HEAD: HTTP error 403: API rate limit exceeded",
    ),
    true,
  )
  assert.equal(
    classify(
      "unable to download https://api.github.com/repos/private/repo: HTTP error 403: Resource not accessible",
    ),
    false,
  )
  assert.equal(classify("Could not resolve host: api.github.com"), false)

  assert.match(
    config,
    /def run-evolve-flake-update[\s\S]*?flake update --flake \$config_root[\s\S]*?\| complete/,
  )
  assert.match(
    config,
    /let lock_is_unchanged[\s\S]*?path exists[\s\S]*?is-github-api-rate-limit \$output[\s\S]*?continuing with the existing flake\.lock/,
  )
  assert.match(config, /flake update failed with exit code[\s\S]*?error make/)
  assert.doesNotMatch(
    config,
    /GITHUB_TOKEN|GH_TOKEN|credentials|auth\.json|keychain/,
  )
})
