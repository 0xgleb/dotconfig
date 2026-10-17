import assert from "node:assert/strict"
import test from "node:test"
import {
  managedOperationalRole,
  registryStateRoot,
  shouldSelfClaimUnownedRole,
} from "./paths.ts"

test("managed operational roles are scoped to their owning project sessions", () => {
  assert.deepEqual(
    managedOperationalRole("/Users/example/.config", "/Users/example"),
    {
      project: "/Users/example/.config",
      role: "pi-support",
    },
  )
  assert.deepEqual(
    managedOperationalRole(
      "/Users/example/code/dataclique/yielduck",
      "/Users/example",
    ),
    { project: "/Users/example/code/dataclique/yielduck", role: "operator" },
  )
  assert.deepEqual(
    managedOperationalRole(
      "/Users/example/code/dataclique/moneymentum",
      "/Users/example",
    ),
    { project: "/Users/example/code/dataclique/moneymentum", role: "operator" },
  )
  assert.deepEqual(
    managedOperationalRole("/Users/example/code/st0x", "/Users/example"),
    { project: "/Users/example/code/st0x", role: "reviewer" },
  )
  assert.deepEqual(
    managedOperationalRole("/Users/example/code/dataclique", "/Users/example"),
    { project: "/Users/example/code/dataclique", role: "reviewer" },
  )
  assert.deepEqual(
    managedOperationalRole("/Users/example/code/0xgleb", "/Users/example"),
    { project: "/Users/example/code/0xgleb", role: "reviewer" },
  )
  assert.equal(
    managedOperationalRole("/Users/example/code/other", "/Users/example"),
    undefined,
  )
})

test("sessions outside dedicated projects never self-claim their standing roles", () => {
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/.config",
      "pi-support",
      "/Users/example/code/project",
      "/Users/example",
    ),
    false,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/.config",
      "pi-support",
      "/Users/example/.config",
      "/Users/example",
    ),
    true,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/dataclique/yielduck",
      "operator",
      "/Users/example/code/other",
      "/Users/example",
    ),
    false,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/dataclique/moneymentum",
      "operator",
      "/Users/example/code/other",
      "/Users/example",
    ),
    false,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/dataclique/moneymentum",
      "operator",
      "/Users/example/code/dataclique/moneymentum",
      "/Users/example",
    ),
    true,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/st0x",
      "reviewer",
      "/Users/example/code/other",
      "/Users/example",
    ),
    false,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/st0x",
      "reviewer",
      "/Users/example/code/st0x",
      "/Users/example",
    ),
    true,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/dataclique",
      "reviewer",
      "/Users/example/code/other",
      "/Users/example",
    ),
    false,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/dataclique",
      "reviewer",
      "/Users/example/code/dataclique",
      "/Users/example",
    ),
    true,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/0xgleb",
      "reviewer",
      "/Users/example/code/other",
      "/Users/example",
    ),
    false,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/0xgleb",
      "reviewer",
      "/Users/example/code/0xgleb",
      "/Users/example",
    ),
    true,
  )
  assert.equal(
    shouldSelfClaimUnownedRole(
      "/Users/example/code/project",
      "reviewer",
      "/Users/example/code/other",
      "/Users/example",
    ),
    true,
  )
})

test("registry state root is fixed outside the repository", () => {
  assert.equal(
    registryStateRoot("/state", "/Users/example"),
    "/state/pi/agent-registry",
  )
  assert.equal(
    registryStateRoot("relative", "/Users/example"),
    "/Users/example/.local/state/pi/agent-registry",
  )
})
