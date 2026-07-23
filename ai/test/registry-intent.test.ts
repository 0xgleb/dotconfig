import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registry = readFileSync(new URL("../pi/extensions/agent-registry/index.ts", import.meta.url), "utf8");
const workflows = readFileSync(new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url), "utf8");

test("classifier receives live registry assignment metadata without request bodies", () => {
  assert.match(registry, /REGISTRY_INTENT_REQUEST_EVENT[\s\S]*claimed request IDs/);
  assert.match(registry, /request\.status === "claimed" && request\.leaseId === lease\.id/);
  assert.match(workflows, /pi\.events\.emit\(REGISTRY_INTENT_REQUEST_EVENT, ctx\.sessionManager\.getSessionId\(\)/);
  assert.match(workflows, /\.\.\.registryIntent, \.\.\.todoIntent/);
});
