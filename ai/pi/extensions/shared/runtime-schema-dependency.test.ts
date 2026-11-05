import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)

test("Pi supplies host packages through wildcard peers, not runtime dependencies", () => {
  for (const name of [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(manifest.dependencies?.[name], undefined, name)
    assert.equal(manifest.peerDependencies?.[name], "*", name)
  }
})

test("local tooling can construct the host schemas used by Pi tools", async () => {
  await assert.doesNotReject(async () => {
    const { Type } = await import("typebox")
    const schema = Type.Object({ value: Type.String() })
    assert.equal(schema.type, "object")
    assert.deepEqual(schema.required, ["value"])
    assert.equal(schema.properties.value.type, "string")
  })
})
