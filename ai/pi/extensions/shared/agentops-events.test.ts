import assert from "node:assert/strict"
import test from "node:test"

import {
  agentopsIncidentKey,
  agentopsRequestText,
  agentTurnIncidentAfterRun,
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

test("agent turn incidents wait for the final settled low-level run", () => {
  const providerFailure =
    "Codex error: An error occurred while processing your request. Please include the request ID 3c1f222a-82d9-4736-9482-47d73d6fe352"

  assert.deepEqual(
    agentTurnIncidentAfterRun(
      { stopReason: "error", errorMessage: providerFailure },
      false,
    ),
    {
      severity: "error",
      component: "pi-host",
      operation: "agent turn",
      summary: providerFailure,
    },
  )
  assert.deepEqual(
    agentTurnIncidentAfterRun(
      {
        stopReason: "error",
        errorMessage:
          "Codex error: Our servers are currently overloaded. Please try again later.",
      },
      false,
    ),
    {
      severity: "warning",
      component: "provider",
      operation: "agent turn",
      summary:
        "Codex error: Our servers are currently overloaded. Please try again later.",
    },
  )
  const firstUsageLimit = agentTurnIncidentAfterRun(
    {
      stopReason: "error",
      errorMessage:
        "You have hit your ChatGPT usage limit (pro plan). Try again in ~7257 min.",
    },
    false,
  )
  const secondUsageLimit = agentTurnIncidentAfterRun(
    {
      stopReason: "error",
      errorMessage:
        "You have hit your ChatGPT usage limit (pro plan). Try again in ~7256 min.",
    },
    false,
  )
  assert.deepEqual(firstUsageLimit, {
    severity: "warning",
    component: "provider",
    operation: "agent turn",
    summary:
      "You have hit your ChatGPT usage limit (pro plan). Try again in ~7257 min.",
  })
  assert.ok(firstUsageLimit)
  assert.ok(secondUsageLimit)
  assert.equal(
    agentopsIncidentKey(firstUsageLimit),
    agentopsIncidentKey(secondUsageLimit),
  )
  assert.equal(
    agentTurnIncidentAfterRun(
      { stopReason: "error", errorMessage: "Local tool usage limit exceeded" },
      false,
    )?.severity,
    "error",
  )
  for (const countdown of ["1 hour and 30 minutes", "2h 15m"]) {
    const incident = agentTurnIncidentAfterRun(
      {
        stopReason: "error",
        errorMessage: `You have hit your ChatGPT usage limit (pro plan). Try again in ${countdown}.`,
      },
      false,
    )
    assert.ok(incident)
    assert.equal(
      agentopsIncidentKey(incident),
      agentopsIncidentKey(firstUsageLimit),
    )
  }
  assert.equal(
    agentTurnIncidentAfterRun({ stopReason: "stop" }, false),
    undefined,
  )
  assert.equal(
    agentTurnIncidentAfterRun(
      { stopReason: "error", errorMessage: "Cancelled by user" },
      false,
    ),
    undefined,
  )
  assert.equal(
    agentTurnIncidentAfterRun(
      { stopReason: "error", errorMessage: "This operation was aborted" },
      true,
    ),
    undefined,
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
