import assert from "node:assert/strict"
import test from "node:test"
import {
  agentTurnIncidentAfterRun,
  agentopsIncidentKey,
} from "./agentops-events.ts"

const refusal =
  "Codex error: This content was flagged for possible cybersecurity risk."

test("a provider safety refusal remains an error attributed to the provider", () => {
  const incident = agentTurnIncidentAfterRun(
    { stopReason: "error", errorMessage: refusal },
    false,
  )
  assert.deepEqual(incident, {
    severity: "error",
    component: "provider",
    operation: "agent turn",
    summary: refusal,
  })
  assert.ok(incident)
  assert.equal(
    agentopsIncidentKey(incident),
    agentopsIncidentKey({ ...incident }),
  )
})

test("safety refusal takes precedence over transient words in diagnostic suffixes", () => {
  const message = `${refusal} Additional diagnostic: servers are currently overloaded.`
  const incident = agentTurnIncidentAfterRun(
    { stopReason: "error", errorMessage: message },
    false,
  )
  assert.equal(incident?.severity, "error")
  assert.equal(incident?.component, "provider")
  assert.equal(incident?.summary, message)
})

test("ordinary tool wording and non-error turns are not reclassified as provider refusals", () => {
  const message = "Local tool reported possible cybersecurity risk."
  assert.equal(
    agentTurnIncidentAfterRun(
      { stopReason: "error", errorMessage: message },
      false,
    )?.component,
    "pi-host",
  )
  assert.equal(
    agentTurnIncidentAfterRun(
      { stopReason: "stop", errorMessage: refusal },
      false,
    ),
    undefined,
  )
})
