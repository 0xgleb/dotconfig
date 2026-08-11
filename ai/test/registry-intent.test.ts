import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registry = readFileSync(new URL("../pi/extensions/agent-registry/index.ts", import.meta.url), "utf8");
const workflows = readFileSync(new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url), "utf8");

test("classifier receives live registry assignment metadata without request bodies", () => {
  assert.match(registry, /REGISTRY_INTENT_REQUEST_EVENT[\s\S]*claimed request IDs/);
  assert.match(
    registry,
    /request\.status === "claimed" &&\s*request\.leaseId === lease\.id &&\s*request\.agentId === payload\.agentId/,
  );
  assert.match(registry, /\.map\(\(request\) => request\.id\)/);
  assert.match(workflows, /const registryRequest: RegistryIntentRequest =/);
  assert.match(workflows, /pi\.events\.emit\(REGISTRY_INTENT_REQUEST_EVENT, registryRequest\)/);
  assert.match(registry, /typeof payload\.report !== "function"/);
  assert.match(
    workflows,
    /\.\.\.registryIntent,\s*\.\.\.questionIntent,\s*\.\.\.todoIntent/,
  );
});
