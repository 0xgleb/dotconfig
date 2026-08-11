import assert from "node:assert/strict";
import test from "node:test";
import { managedOperationalRole, registryStateRoot } from "./paths.ts";

test("managed operational roles are scoped to their owning project sessions", () => {
  assert.deepEqual(managedOperationalRole("/Users/example/.config", "/Users/example"), {
    project: "/Users/example/.config",
    role: "pi-support",
  });
  assert.deepEqual(
    managedOperationalRole("/Users/example/code/dataclique/yielduck", "/Users/example"),
    { project: "/Users/example/code/dataclique/yielduck", role: "operator" },
  );
  assert.deepEqual(
    managedOperationalRole("/Users/example/code/st0x", "/Users/example"),
    { project: "/Users/example/code/st0x", role: "reviewer" },
  );
  assert.deepEqual(
    managedOperationalRole("/Users/example/code/dataclique", "/Users/example"),
    { project: "/Users/example/code/dataclique", role: "reviewer" },
  );
  assert.deepEqual(
    managedOperationalRole("/Users/example/code/0xgleb", "/Users/example"),
    { project: "/Users/example/code/0xgleb", role: "reviewer" },
  );
  assert.equal(managedOperationalRole("/Users/example/code/other", "/Users/example"), undefined);
});

test("a managed role is never inferred from a directory that merely contains the project", () => {
  // Home contains every project without being one, and an org directory
  // contains the repos under it. A session there holds its own role, not the
  // standing role of everything beneath it, or one session would end up
  // appointed drainer of queues it never reads.
  assert.equal(managedOperationalRole("/Users/example", "/Users/example"), undefined);
  assert.equal(
    managedOperationalRole("/Users/example/code/st0x/st0x.issuance", "/Users/example"),
    undefined,
  );
});

test("registry state root is fixed outside the repository", () => {
  assert.equal(registryStateRoot("/state", "/Users/example"), "/state/pi/agent-registry");
  assert.equal(registryStateRoot("relative", "/Users/example"), "/Users/example/.local/state/pi/agent-registry");
});
