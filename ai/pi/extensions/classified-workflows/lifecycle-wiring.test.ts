import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { boundedToolResultActionContext } from "./lifecycle.ts"

const extension = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("approved tool-result context normalizes commands and preserves the bounded extension wiring", () => {
  assert.deepEqual(
    boundedToolResultActionContext("bash", {
      command: "  cargo test   --workspace  ",
    }),
    { actionApproved: true, command: "cargo test --workspace" },
  )
  assert.deepEqual(boundedToolResultActionContext("edit", { oldText: "x" }), {
    actionApproved: true,
  })
  assert.equal(
    boundedToolResultActionContext("bash", { command: "x".repeat(3_000) })
      .command?.length,
    2_000,
  )
  assert.match(
    extension,
    /toolResultSubject[\s\S]*?boundedToolResultActionContext\(event\.toolName, event\.input\)/,
  )
})

test("action wiring revalidates project context before applying push hardening", () => {
  assert.match(
    extension,
    /const actionProjectContexts = runtimeClassificationProjectContexts[\s\S]*gitEnvironmentOverrideBlockReason[\s\S]*source: "deterministic"[\s\S]*classifyWithActivity[\s\S]*actionProjectContexts[\s\S]*const currentActionProjectContexts = runtimeClassificationProjectContexts[\s\S]*runtimeClassificationProjectContextsMatch[\s\S]*Runtime project, command, target, Git snapshot, or canonical path context changed during classification/,
  )
  assert.match(
    extension,
    /runtimeClassificationProjectContextsMatch[\s\S]*hardenedGitPushCommandForSubject[\s\S]*event\.input\.command = hardenedPush\.command/,
  )
})

test("artifact-provenance evidence remains wired into classification requests", () => {
  assert.match(
    extension,
    /current typed artifact provenance:.*artifactPaths\(artifactProvenance\)/s,
  )
})
