import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const registry = readFileSync(
  new URL("../pi/extensions/agent-registry/index.ts", import.meta.url),
  "utf8",
)
const workflows = readFileSync(
  new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url),
  "utf8",
)

test("classifier receives live registry assignment metadata and current claimed request bodies", () => {
  assert.match(
    registry,
    /REGISTRY_INTENT_REQUEST_EVENT[\s\S]*claimed request IDs/,
  )
  assert.match(
    registry,
    /request\.status === "claimed" &&\s*request\.leaseId === lease\.id/,
  )
  assert.match(
    registry,
    /Trusted current claimed registry request \$\{request\.id\} full bounded body: \$\{request\.text\.slice\(0, 4_000\)\}/,
  )
  assert.match(workflows, /const registryRequest: RegistryIntentRequest =/)
  assert.match(
    workflows,
    /pi\.events\.emit\(REGISTRY_INTENT_REQUEST_EVENT, registryRequest\)/,
  )
  assert.match(registry, /typeof payload\.report !== "function"/)
  assert.match(workflows, /\.\.\.registryIntent,[\s\S]*\.\.\.todoIntent/)
})
