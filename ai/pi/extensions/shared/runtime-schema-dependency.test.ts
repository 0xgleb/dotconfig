import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)

test("schema construction is declared as a production dependency", () => {
  assert.equal(manifest.dependencies?.typebox, "1.3.7")
  assert.equal(manifest.devDependencies?.typebox, undefined)
})

test("production dependencies can construct the schemas used by Pi tools", async () => {
  await assert.doesNotReject(async () => {
    const { Type } = await import("typebox")
    const schema = Type.Object({ value: Type.String() })
    assert.equal(schema.type, "object")
    assert.deepEqual(schema.required, ["value"])
    assert.equal(schema.properties.value.type, "string")
  })
})
