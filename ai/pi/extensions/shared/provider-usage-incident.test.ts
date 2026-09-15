import assert from "node:assert/strict"
import test from "node:test"
import { agentTurnIncidentAfterRun } from "./agentops-events.ts"

test("Codex usage-limit diagnostics remain provider warnings with the original message", () => {
  for (const summary of [
    "Codex error: The usage limit has been reached",
    "Codex error: The usage limit has been reached.",
  ]) {
    assert.deepEqual(
      agentTurnIncidentAfterRun(
        { stopReason: "error", errorMessage: summary },
        false,
      ),
      {
        severity: "warning",
        component: "provider",
        operation: "agent turn",
        summary,
      },
    )
    assert.equal(
      agentTurnIncidentAfterRun(
        { stopReason: "stop", errorMessage: summary },
        false,
      ),
      undefined,
    )
    assert.equal(
      agentTurnIncidentAfterRun(
        { stopReason: "error", errorMessage: summary },
        true,
      ),
      undefined,
    )
  }
})

test("local and ambiguous usage-limit messages are not downgraded to provider warnings", () => {
  for (const summary of [
    "The usage limit has been reached",
    "Local tool usage limit exceeded",
    "Codex error: The usage limit has been reached in a local tool",
    "Local wrapper: Codex error: The usage limit has been reached",
  ]) {
    assert.deepEqual(
      agentTurnIncidentAfterRun(
        { stopReason: "error", errorMessage: summary },
        false,
      ),
      {
        severity: "error",
        component: "pi-host",
        operation: "agent turn",
        summary,
      },
    )
  }
})
