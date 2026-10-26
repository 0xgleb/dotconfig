import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const workflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
)
const manifest: unknown = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
)
const lock: unknown = JSON.parse(
  readFileSync(new URL("../../../flake.lock", import.meta.url), "utf8"),
)

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const record = (value: unknown): Readonly<Record<string, unknown>> => {
  assert.ok(isRecord(value))
  return value
}

const checkStart = workflow.indexOf("\n  check:\n")
const buildStart = workflow.indexOf("\n  build-nixos:\n")
assert.ok(checkStart >= 0 && buildStart > checkStart)
const checkJob = workflow.slice(checkStart, buildStart)

const typecheckStep = (): string => {
  const start = checkJob.indexOf("      - name: Typecheck Pi extensions\n")
  assert.ok(start >= 0, "The required check job must run the full compiler")
  const end = checkJob.indexOf("\n      - ", start + 1)
  return checkJob.slice(start, end < 0 ? undefined : end)
}

const nixpkgsSource = (): string => {
  const flake = record(lock)
  const nodes = record(flake.nodes)
  assert.ok(typeof flake.root === "string")
  const inputs = record(record(nodes[flake.root]).inputs)
  assert.ok(typeof inputs.nixpkgs === "string")
  const locked = record(record(nodes[inputs.nixpkgs]).locked)
  assert.equal(locked.type, "github")
  assert.equal(locked.owner, "NixOS")
  assert.equal(locked.repo, "nixpkgs")
  assert.ok(typeof locked.rev === "string" && /^[0-9a-f]{40}$/.test(locked.rev))
  return `github:NixOS/nixpkgs/${locked.rev}#nodejs`
}

test("the required CI check installs development dependencies and runs the declared compiler", () => {
  const step = typecheckStep()
  assert.equal(
    record(record(manifest).scripts).typecheck,
    "tsc --noEmit -p tsconfig.json",
  )
  assert.match(step, /working-directory: ai\/pi\/extensions/)
  assert.ok(step.includes(`nix shell ${nixpkgsSource()} --command`))
  const contract = step.indexOf("node --test ci-typecheck.test.ts")
  const install = step.indexOf("npm ci --legacy-peer-deps --include=dev")
  const compiler = step.indexOf("npm run typecheck")
  assert.ok(contract >= 0 && install > contract && compiler > install)
  assert.ok(checkJob.indexOf("nix flake check") < checkJob.indexOf(step))
})

test("compiler and installation failures cannot be suppressed in the required check", () => {
  const step = typecheckStep()
  assert.match(step, /bash -euo pipefail -c/)
  assert.match(step, /timeout-minutes: [1-9][0-9]*/)
  assert.doesNotMatch(checkJob, /^\s*(?:if|continue-on-error):/m)
  assert.doesNotMatch(step, /\|\||--omit=dev|--production|continue-on-error/)
})

test("the compiler gate preserves existing Nix gates and read-only checkout credentials", () => {
  typecheckStep()
  assert.match(workflow, /permissions:\n  contents: read\n/)
  assert.match(checkJob, /persist-credentials: false/)
  assert.match(
    checkJob,
    /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/,
  )
  assert.match(
    checkJob,
    /cachix\/install-nix-action@ba0dd844c9180cbf77aa72a116d6fbc515d0e87b/,
  )
  assert.match(checkJob, /- run: nix flake check/)
  assert.match(
    workflow.slice(buildStart),
    /- run: nix build \.#nixosConfigurations\.nixxxos\.config\.system\.build\.toplevel/,
  )
})
