import assert from "node:assert/strict"
import test from "node:test"

import {
  agentopsRequestText,
  decodeAgentopsIncident,
  hasOpenAgentopsIncident,
  isExplicitUserCancellation,
  shouldRouteToolFailureToAgentops,
} from "./agentops-events.ts"

const incident = {
  severity: "error" as const,
  component: "classified-workflows",
  operation: "classify tool call",
  summary: "Classifier unavailable after two bounded attempts",
}

test("agentops incidents are bounded, sanitized, and deduplicated while open", () => {
  assert.deepEqual(
    decodeAgentopsIncident({
      ...incident,
      summary: "Classifier\u0000 unavailable\n after two bounded attempts",
    }),
    {
      ...incident,
      summary: "Classifier unavailable after two bounded attempts",
    },
  )
  assert.equal(
    decodeAgentopsIncident({ ...incident, severity: "info" }),
    undefined,
  )

  const text = agentopsRequestText(incident, ".config", "/Users/0xgleb/.config")
  assert.match(text, /Automatic Pi agentops incident \[agentops:[0-9a-f]{20}\]/)
  assert.match(text, /automatically routed support responsibility/i)
  assert.match(
    text,
    /grants no production, publication, secret, or cross-project mutation authority/i,
  )
  assert.equal(
    hasOpenAgentopsIncident([{ status: "queued", text }], incident),
    true,
  )
  assert.equal(
    hasOpenAgentopsIncident([{ status: "completed", text }], incident),
    false,
  )
})

test("explicit user cancellation is never promoted to an agentops incident", () => {
  for (const summary of [
    "Cancelled by user",
    "User interrupted",
    "Operation aborted",
  ]) {
    assert.equal(isExplicitUserCancellation(summary), true)
  }
  assert.equal(isExplicitUserCancellation("Reload failed after abort"), false)
})

test("agent-correctable local tool diagnostics do not become agentops incidents", () => {
  for (const [toolName, summary] of [
    ["edit", "oldText matched 3 occurrences in the file"],
    ["read", "ENOENT: no such file or directory"],
    ["bash", "Diff in crates/hedge/src/inventory.rs:240"],
    [
      "bash",
      "Checking formatting... Code style issues found in 2 files. Command exited with code 1",
    ],
    ["bash", "nu::parser::parse_mismatch"],
    ["bash", "test failed; rerun with cargo test"],
  ]) {
    assert.equal(shouldRouteToolFailureToAgentops(toolName, summary), false)
  }
})

test("local tool runtime failures and managed-tool failures still route", () => {
  assert.equal(
    shouldRouteToolFailureToAgentops(
      "bash",
      "Classifier unavailable after two bounded attempts",
    ),
    true,
  )
  assert.equal(
    shouldRouteToolFailureToAgentops("bash", "This operation was aborted"),
    true,
  )
  assert.equal(
    shouldRouteToolFailureToAgentops(
      "browser",
      "Loopback operator unavailable",
    ),
    true,
  )
})
