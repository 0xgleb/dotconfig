import assert from "node:assert/strict";
import test from "node:test";
import { registryStateRoot, shouldSelfClaimUnownedRole } from "./paths.ts";

test("sessions outside dotconfig never self-claim its standing Pi support role", () => {
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/.config",
      "pi-support",
      "/Users/example/code/project",
      "/Users/example",
    ),
    false,
  );
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/.config",
      "pi-support",
      "/Users/example/.config",
      "/Users/example",
    ),
    true,
  );
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/project",
      "reviewer",
      "/Users/example/code/other",
      "/Users/example",
    ),
    true,
  );
});

test("registry state root is fixed outside the repository", () => {
  assert.equal(registryStateRoot("/state", "/Users/example"), "/state/pi/agent-registry");
  assert.equal(registryStateRoot("relative", "/Users/example"), "/Users/example/.local/state/pi/agent-registry");
});
