import assert from "node:assert/strict"
import test from "node:test"
import { deterministicDecision } from "./core.ts"

test("persistent-memory retrieval and writes never receive read-only admission", () => {
  for (const toolName of [
    "memory",
    "memory_search",
    "session_search",
    "functions.memory",
    "functions.memory_search",
    "functions.session_search",
  ]) {
    const decision = deterministicDecision({
      boundary: "action",
      toolName,
      input: { action: "add", query: "prior work" },
      cwd: "/repo",
    })
    assert.equal(decision?.verdict, "block", toolName)
    assert.match(decision?.reason ?? "", /persistent.memory.*prohibited/i)
  }
})
