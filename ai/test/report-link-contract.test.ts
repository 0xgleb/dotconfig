import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../skills/report/SKILL.md", import.meta.url),
  "utf8",
)

test("owner-report examples demonstrate verified GitHub links without retired organization defaults", () => {
  const shape =
    source.split("## Shape")[1]?.split("## Links that carry a route")[0] ?? ""
  assert.ok(shape.includes("verify current status before reusing any item"))
  assert.ok(
    shape.includes("[#75](https://github.com/0xgleb/dotconfig/issues/75)"),
  )
  assert.ok(
    shape.includes("[#76](https://github.com/0xgleb/dotconfig/issues/76)"),
  )
  assert.doesNotMatch(source, /\b(?:st0x|rainlanguage|linear|graphite)\b/i)
  assert.ok(
    source.includes(
      "Every external reference must carry its corresponding verified link",
    ),
  )
})

test("owner-report and stakeholder transport remain separate and delivery-bound", () => {
  assert.ok(source.includes('report_owner { text: "<report>" }'))
  assert.ok(
    source.includes(
      'deliver_stakeholder_update { text: "<exact verified update>" }',
    ),
  )
  assert.ok(source.includes("Only typed delivery evidence counts"))
  assert.ok(source.includes("A queued"))
  assert.ok(source.includes("bridge message is not delivery"))
})
