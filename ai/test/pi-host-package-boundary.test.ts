import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const manifestUrl = new URL("../pi/extensions/package.json", import.meta.url)
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"))
const lock = JSON.parse(
  readFileSync(
    new URL("../pi/extensions/package-lock.json", import.meta.url),
    "utf8",
  ),
)
const hostPackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]

test("Pi supplies host packages through wildcard peers, not runtime dependencies", () => {
  for (const name of hostPackages) {
    assert.equal(manifest.dependencies?.[name], undefined, name)
    assert.equal(manifest.peerDependencies?.[name], "*", name)
    assert.equal(lock.packages[""].dependencies?.[name], undefined, name)
    assert.equal(lock.packages[""].peerDependencies?.[name], "*", name)
    assert.equal(lock.packages[`node_modules/${name}`]?.dev, true, name)
  }
})

test("local verification declares pinned host packages as development dependencies", () => {
  assert.equal(manifest.devDependencies?.["@earendil-works/pi-tui"], "0.84.1")
  assert.equal(manifest.devDependencies?.typebox, "1.3.7")
  assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies)
})

test("local tooling can construct the host schemas used by Pi tools", () => {
  const { Type } = createRequire(manifestUrl)("typebox")
  const schema = Type.Object({ value: Type.String() })
  assert.equal(schema.type, "object")
  assert.deepEqual(schema.required, ["value"])
  assert.equal(schema.properties.value.type, "string")
})
