import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../skills/eow/SKILL.md", import.meta.url),
  "utf8",
)

test("weekly evidence queries require explicit repositories and bounded coverage", () => {
  const queries = source
    .split("\n")
    .filter(line => line.startsWith("gh search "))
  assert.equal(queries.length, 6)
  for (const query of queries) {
    assert.ok(query.includes("--repo=OWNER/REPO"))
    assert.ok(query.includes("--limit 200"))
    assert.ok(!query.includes("--owner="))
  }
  assert.ok(!source.includes("linear api"))
  assert.ok(source.includes("potentially truncated"))
  assert.ok(
    source.includes("An updated PR is not proof of a substantive contribution"),
  )
  assert.ok(source.includes("Do not infer an individual's work"))
})

test("weekly query JSON fields are exposed by the installed GitHub CLI", () => {
  for (const kind of ["prs", "issues"]) {
    const help = execFileSync("gh", ["search", kind, "--help"], {
      encoding: "utf8",
    })
    const fields = help
      .split("JSON FIELDS\n")[1]
      ?.split("\nEXAMPLES")[0]
      ?.split(/[\s,]+/)
      .filter(Boolean)
    assert.ok(fields, `missing ${kind} field contract`)
    for (const query of source
      .split("\n")
      .filter(line => line.startsWith(`gh search ${kind} `))) {
      const selected = query.split("--json ")[1]?.split(" ")[0]?.split(",")
      assert.ok(selected)
      for (const field of selected)
        assert.ok(fields.includes(field), `${kind} does not expose ${field}`)
    }
  }
})
