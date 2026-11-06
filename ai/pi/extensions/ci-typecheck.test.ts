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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const record = (value: unknown): Readonly<Record<string, unknown>> => {
  assert.ok(isRecord(value))
  return value
}

const checkStart = workflow.indexOf("\n  check:\n")
assert.ok(checkStart >= 0)
const followingJob = workflow
  .slice(checkStart + 1)
  .search(/\n  [a-zA-Z][\w-]*:\n/)
const checkJob = workflow.slice(
  checkStart,
  followingJob < 0 ? undefined : checkStart + 1 + followingJob,
)

const typecheckStep = (): string => {
  const start = checkJob.indexOf("      - name: Typecheck Pi extensions\n")
  assert.ok(start >= 0, "The required check job must run the full compiler")
  const end = checkJob.indexOf("\n      - ", start + 1)
  return checkJob.slice(start, end < 0 ? undefined : end)
}

test("the required CI check installs development dependencies and runs the declared compiler", () => {
  const step = typecheckStep()
  assert.equal(
    record(record(manifest).scripts).typecheck,
    "tsc --noEmit -p tsconfig.json",
  )
  assert.match(
    step,
    /nix --accept-flake-config --no-pure-eval develop \.#default --command/,
  )
  const directory = step.indexOf("cd ai/pi/extensions")
  const contract = step.indexOf("node --test ci-typecheck.test.ts")
  const install = step.indexOf("npm ci --legacy-peer-deps --include=dev")
  const compiler = step.indexOf("npm run typecheck")
  assert.ok(
    directory >= 0 &&
      contract > directory &&
      install > contract &&
      compiler > install,
  )
  assert.ok(
    checkJob.indexOf("nix --no-pure-eval flake check") < checkJob.indexOf(step),
  )
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
  assert.match(checkJob, /- run: nix --no-pure-eval flake check/)
})
