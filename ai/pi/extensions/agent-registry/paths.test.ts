import assert from "node:assert/strict";
import test from "node:test";
import { registryStateRoot } from "./paths.ts";

test("registry state root is fixed outside the repository", () => {
  assert.equal(registryStateRoot("/state", "/Users/example"), "/state/pi/agent-registry");
  assert.equal(registryStateRoot("relative", "/Users/example"), "/Users/example/.local/state/pi/agent-registry");
});
