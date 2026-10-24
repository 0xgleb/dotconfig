import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const guidance = readFileSync(
  new URL("../pi/AGENTS.md", import.meta.url),
  "utf8",
).replace(/\s+/g, " ")

test("environment guidance rejects enumeration before filtering or redaction", () => {
  assert.match(guidance, /Never enumerate the environment/)
  assert.match(guidance, /unscoped `printenv`/)
  assert.match(guidance, /bare `\$env`/)
  assert.match(guidance, /Filtering or redacting after retrieval is too late/)
})

test("session metadata guidance names exact documented keys for direct lookup", () => {
  assert.match(guidance, /direct lookup of only the documented injected keys/)
  for (const key of [
    "PI_SESSION_ID",
    "PI_PROVIDER",
    "PI_MODEL",
    "PI_REASONING_LEVEL",
  ]) {
    assert.ok(guidance.includes(`\`${key}\``), `missing metadata key ${key}`)
  }
})

test("a PI prefix never establishes credential safety", () => {
  assert.match(guidance, /A `PI_` prefix is not a credential-safety guarantee/)
  assert.match(guidance, /Never read credential-bearing variable values/)
})
