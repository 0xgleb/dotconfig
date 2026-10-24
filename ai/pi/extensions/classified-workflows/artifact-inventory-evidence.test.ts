import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import test from "node:test"
import {
  selectRelevantExecutionEvidence,
  toolInputDigest,
  toolResultExecutionEvidence,
} from "./execution-evidence.ts"

const cwd = realpathSync(process.cwd())
const inventory = { command: "du target/debug/incremental" }
const subject = {
  cwd,
  toolName: "bash",
  input: inventory,
  inputDigest: toolInputDigest("bash", inventory),
}
const evidence = (
  input: Readonly<Record<string, unknown>>,
  text: string,
  scope = cwd,
  status: "success" | "error" | "unknown" = "success",
  toolName = "bash",
) =>
  toolResultExecutionEvidence({
    toolName,
    input,
    inputDigest: toolInputDigest(toolName, input),
    text,
    scope,
    isError:
      status === "success" ? false : status === "error" ? true : undefined,
    subject,
  })
const oldInventory = evidence(inventory, "old observation, not current size")
const build = (scope = cwd) =>
  evidence({ command: "cargo build -p dashboard" }, "Finished build", scope)
const noise = Array.from({ length: 12 }, (_, index) =>
  evidence(
    { path: `notes/item-${index}.txt` },
    "unrelated",
    cwd,
    "success",
    "read",
  ),
)
const prefix = (value: string) => value.split(" input=")[0] ?? ""

// Commands below are inert inputs to the real evidence renderer/selector.
// No Cargo process, disk inventory, artifact deletion or foreign work executes.
test("a repeated Cargo-target inventory retains later possible artifact generation", () => {
  const removed = evidence(
    { command: "rm -r target/debug/incremental" },
    "removed",
  )
  const generated = build()
  const selected = selectRelevantExecutionEvidence(
    [oldInventory, removed, generated, ...noise],
    subject,
  )
  assert.ok(selected.includes(oldInventory))
  assert.ok(
    selected.includes(generated),
    "old input identity is not current artifact state",
  )
  assert.ok(selected.indexOf(oldInventory) < selected.indexOf(generated))
})

test("possible Cargo-output metadata is produced only for successful build-like commands", () => {
  for (const command of [
    "cargo build -p dashboard",
    "cargo check --workspace",
    "cargo test -p service --lib",
    "cargo clippy -p service -- -D warnings",
    "cargo nextest run -p service --lib",
    "direnv exec . cargo build --release",
  ]) {
    const result = evidence({ command }, "Finished")
    assert.match(prefix(result), /artifactEffect=possible-cargo-output/)
  }
  for (const command of [
    "echo cargo build",
    "cargo metadata",
    "cargo fmt --check",
    "cargo build --help",
    "cargo build --target-dir elsewhere",
    "cargo build --target-dir=elsewhere",
    "cargo build --target wasm32-unknown-unknown",
    "cargo build --target=wasm32-unknown-unknown",
    "cargo build; true",
  ]) {
    const result = evidence({ command }, build())
    assert.doesNotMatch(prefix(result), /artifactEffect=possible-cargo-output/)
  }
  for (const status of ["error", "unknown"] as const) {
    const result = evidence({ command: "cargo build" }, "Finished", cwd, status)
    assert.doesNotMatch(prefix(result), /artifactEffect=possible-cargo-output/)
  }
})

test("generation evidence before the latest successful inventory is not promoted", () => {
  const generated = build()
  const latestInventory = evidence(inventory, "new observation")
  const selected = selectRelevantExecutionEvidence(
    [oldInventory, generated, latestInventory, ...noise],
    subject,
  )
  assert.ok(selected.includes(latestInventory))
  assert.ok(!selected.includes(generated))
})

test("inventory chronology is scoped, exact-input-bound and does not cover unrelated reads", () => {
  const foreign = build("/workspace/other")
  const generated = build()
  assert.ok(
    !selectRelevantExecutionEvidence(
      [oldInventory, foreign, ...noise],
      subject,
    ).includes(foreign),
  )
  assert.ok(
    !selectRelevantExecutionEvidence([generated, ...noise], subject).includes(
      generated,
    ),
  )
  for (const command of [
    "du docs",
    "du target/../docs",
    "du target/debug/incremental; echo done",
    "ls target/debug/incremental",
  ]) {
    const input = { command }
    const unrelatedSubject = {
      ...subject,
      input,
      inputDigest: toolInputDigest("bash", input),
    }
    const observed = evidence(input, "old observation")
    const selected = selectRelevantExecutionEvidence(
      [observed, generated, ...noise],
      unrelatedSubject,
    )
    assert.ok(!selected.includes(generated), command)
  }
})

test("at most four later possible Cargo-output witnesses receive extra retention", () => {
  const generated = Array.from({ length: 10 }, (_, index) =>
    evidence({ command: `cargo build -p crate-${index}` }, "Finished"),
  )
  const selected = selectRelevantExecutionEvidence(
    [oldInventory, ...generated, ...noise],
    subject,
  )
  assert.deepEqual(
    selected.filter(candidate => generated.includes(candidate)),
    generated.slice(-4),
  )
})
